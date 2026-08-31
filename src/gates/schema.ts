/**
 * The schema gate (TASKS:Y4.1) — a stage that lost its footing is helped up, not restarted.
 *
 * A stage checkpoint has four outcomes, and they need four different answers:
 *
 *   - schema-valid JSON                → the stage is done;
 *   - JSON the engine SALVAGED from a cut-short body (`jsonTruncated`) → it may parse and
 *     still be missing half the findings, which is the dangerous case because it looks like
 *     success — so it is a failure, and the ask is "say less, completely";
 *   - nothing schema-valid at all      → ask again, correctively;
 *   - THE STEP BUDGET RAN OUT mid-work → the stage was working and never got to answer.
 *
 * The last one used to be indistinguishable from the third, and treating them alike is what
 * broke yama PR #101. Task Insertion spent its 32 steps reading, produced no JSON, and the
 * gate re-ran the WHOLE original prompt — which spent 32 more steps reading the same files
 * and produced no JSON again. The finalize ask that followed then turned every tool OFF and
 * asked for the answer, including `tasks_create`, the one call the stage is judged on. It
 * answered with a plan it had invented and an empty `checklistIds`, and the run failed over
 * a change whose diff had been in front of it the whole time.
 *
 * So a budget that ran out goes STRAIGHT to the closing ask, and the closing ask keeps the
 * stage's EFFECTING tools while dropping its exploring ones. Read nothing more; finish what
 * you were doing. Whatever comes back is stamped `recovered`, and a recovered answer is
 * never `trusted` — the run report has to carry the difference between a stage that worked
 * and a stage that was rescued.
 *
 * Nothing is truncated to make a retry fit: the verbatim output of every attempt is banked
 * by the session before this gate ever sees it.
 */
import { StageError } from "../core/errors.js";
import type {
  EngineToolResult,
  SchemaGateRequest,
  Stage,
  StageOutput,
} from "../types/index.js";

/** Attempts after the first, when the caller does not say. */
const DEFAULT_RETRIES = 1;

/** Step room for closing out — emitting the JSON, and the calls that make it true. */
const CLOSING_MAX_STEPS = 10;

/**
 * Tool filter for a closing ask that keeps nothing. An EMPTY list is a fail-open no-op in
 * the runtime (legacy semantics), so "no tools" is an include-list matching no name.
 */
const NO_TOOLS = ["__closing_no_tools__"];

/** Tool calls named in the digest before it collapses into a count. */
const DIGEST_CALLS = 24;

/**
 * The corrective preamble. It names the failure and repeats the original prompt verbatim —
 * a retry that paraphrases the task is a different question, and answers a different one.
 */
export const buildSchemaRetryPrompt = (
  original: string,
  reason: string,
): string =>
  [
    `Your previous answer could not be used: ${reason}.`,
    "Answer again, and this time return ONE complete JSON object that matches the schema exactly.",
    "Keep it short enough to finish: prefer fewer, denser entries over a long list that gets cut off mid-way.",
    "What you already read is recorded below and in the run store — re-read only what you still need.",
    "",
    "The task, unchanged:",
    "",
    original,
  ].join("\n");

/** One tool call, short enough to list two dozen of them. */
const describeCall = (call: EngineToolResult): string => {
  const params =
    call.params !== null && typeof call.params === "object"
      ? Object.entries(call.params as Record<string, unknown>)
          .filter(
            ([, value]) =>
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean",
          )
          .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
          .join(" ")
      : "";
  return `  ${call.name}${params.length > 0 ? ` ${params}` : ""}${call.isError ? " [failed]" : ""}`;
};

/**
 * What the attempt that just failed actually did, read off the tool results the session
 * banked — not off the conversation.
 *
 * Memory is on (TASKS:Y2.5), which makes this cheap rather than unnecessary: summarization
 * evicts, and the turn most worth remembering is the long one that just filled the window.
 * A recovery ask that stands on its own works either way, and that is the contract.
 */
export const describeAttempt = (calls: readonly EngineToolResult[]): string => {
  if (calls.length === 0) {
    return "Your last attempt called no tools at all.";
  }
  const lines = [...new Set(calls.map(describeCall))];
  return [
    `What your last attempt already did (${calls.length} tool call(s)) — none of it needs doing again:`,
    ...lines.slice(0, DIGEST_CALLS),
    ...(lines.length > DIGEST_CALLS
      ? [`  … and ${lines.length - DIGEST_CALLS} more`]
      : []),
  ].join("\n");
};

/**
 * The closing ask: stop exploring, finish the job, answer.
 *
 * It keeps the stage's effecting tools because for some stages the answer is not only
 * JSON — Task Insertion's plan is a claim about a checklist that has to exist, and a
 * closing ask that cannot call `tasks_create` can only produce a lie.
 */
export const buildClosingPrompt = (input: {
  reason: string;
  digest: string;
  /** The run's ground truth, restated so the ask needs no history to make sense. */
  context?: string;
  /** Whether this ask still holds tools that DO something. */
  hasTools: boolean;
}): string =>
  [
    `Your previous attempt did not produce the required JSON (${input.reason}).`,
    "",
    ...(input.context !== undefined ? [input.context, ""] : []),
    input.digest,
    "",
    "STOP INVESTIGATING NOW. Do not read another file and do not look anything else up.",
    ...(input.hasTools
      ? [
          "You still hold the tools that RECORD work — use them to make your answer true, and nothing else.",
        ]
      : []),
    "Using what you already have, emit ONE JSON object that satisfies the schema. Anything",
    "you did not finish belongs in the fields the schema provides for open items: an honest",
    "partial result is useful, an invented complete one is not.",
  ].join("\n");

/**
 * Runs a stage checkpoint under the schema gate.
 *
 * Returns the envelope of the first attempt that produced complete, schema-valid output.
 * A budget that ran out skips straight to the closing ask; anything else is retried
 * correctively first. When even the closing ask produces nothing usable, the last
 * `StageError` is thrown — naming the file the evidence was banked to.
 */
export const checkpointWithSchemaGate = async <T>(
  gate: SchemaGateRequest<T>,
): Promise<StageOutput<Stage, T>> => {
  const attempts = 1 + (gate.retries ?? DEFAULT_RETRIES);
  const { session, request } = gate;
  let lastReason = "nothing schema-valid came back";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const prompt =
      attempt === 0
        ? request.prompt
        : [
            buildSchemaRetryPrompt(request.prompt, lastReason),
            "",
            describeAttempt(session.toolResults()),
          ].join("\n");
    try {
      const envelope = await session.checkpoint({ ...request, prompt });
      if (!envelope.truncated) {
        return envelope;
      }
      lastReason =
        "the JSON was cut short and only a partial object could be salvaged";
    } catch (error) {
      if (!(error instanceof StageError)) {
        throw error;
      }
      // A StageError on the LAST loop attempt falls through to the closing ask below —
      // rethrowing here would skip the one mechanism built for exactly this moment.
      lastReason = error.message.split("\n")[0] ?? lastReason;
    }
    // A stage that used every step it was given was still WORKING when it was cut off.
    // Asking the same question again buys another identical crawl; asking it to close
    // buys the answer. Measured: two 32-step attempts, both cut off, on PR #101.
    const used = session.metrics().at(-1)?.stepsUsed;
    if (
      used !== undefined &&
      request.maxSteps !== undefined &&
      used >= request.maxSteps
    ) {
      lastReason = `the stage used all ${request.maxSteps} of its steps and never got to its answer`;
      break;
    }
  }

  const closingTools = gate.recovery?.tools;
  try {
    const closing = await session.checkpoint({
      ...request,
      prompt: buildClosingPrompt({
        reason: lastReason,
        digest: describeAttempt(session.toolResults()),
        hasTools: closingTools !== undefined && closingTools.length > 0,
        ...(gate.recovery?.context !== undefined
          ? { context: gate.recovery.context }
          : {}),
      }),
      tools: closingTools !== undefined ? [...closingTools] : NO_TOOLS,
      maxSteps: gate.recovery?.maxSteps ?? CLOSING_MAX_STEPS,
      recovery: true,
    });
    if (!closing.truncated) {
      return closing;
    }
    lastReason =
      "the JSON was cut short and only a partial object could be salvaged";
  } catch (error) {
    if (!(error instanceof StageError)) {
      throw error;
    }
    lastReason = error.message.split("\n")[0] ?? lastReason;
  }

  const banked = session.metrics().at(-1)?.rawPath ?? "(nothing banked)";
  throw new StageError(
    request.stage,
    `${lastReason} — after ${attempts} attempt(s) and a closing ask`,
    banked,
  );
};
