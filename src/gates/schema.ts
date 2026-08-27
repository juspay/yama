/**
 * The schema gate (TASKS:Y4.1) — one agentic retry, and never a silent partial.
 *
 * A stage checkpoint has three outcomes, and only one of them is usable:
 *
 *   - schema-valid JSON               → the stage is done;
 *   - nothing schema-valid at all     → `SessionRunner.checkpoint` throws `StageError`;
 *   - JSON the engine had to SALVAGE from a cut-short body (`jsonTruncated`) → it may
 *     parse and still be missing half the findings, which is the dangerous case, because
 *     it looks like success.
 *
 * The gate treats the third case as a failure and retries once, telling the model exactly
 * what went wrong. Repaired-but-complete JSON is accepted: nothing was lost, and the
 * metric already records `trusted: false` for the run report to carry.
 *
 * Nothing is truncated to make a retry fit — the verbatim output of every attempt is
 * banked by the session before this gate ever sees it.
 */
import { StageError } from "../core/errors.js";
import type { SchemaGateRequest, Stage, StageOutput } from "../types/index.js";

/** Attempts after the first, when the caller does not say. */
const DEFAULT_RETRIES = 1;

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
    "Nothing you already learned is lost — re-read what you need with the tools rather than guessing.",
    "",
    "The task, unchanged:",
    "",
    original,
  ].join("\n");

/**
 * The finalize ask: no more work, just the JSON. Everything the stage gathered lives in
 * the session, so a model that ran out of steps mid-work can still land what it has —
 * observed live on a repository-rewrite pull request, where a work round died on its step
 * cap holding real findings it never got to emit.
 */
const buildFinalizePrompt = (reason: string): string =>
  [
    `Your previous answer did not produce the required JSON (${reason}).`,
    "Do NOT call any more tools and do NOT continue working. Using only what you have",
    "already gathered in this conversation, emit ONE JSON object that satisfies the",
    "schema. Anything you did not finish belongs in the fields the schema provides for",
    "open items — an honest partial result beats none.",
  ].join("\n");

/**
 * Tool filter for the finalize attempt. An EMPTY list is a fail-open no-op in the
 * runtime (legacy semantics), so "no tools" is expressed as an include-list whose one
 * name matches nothing.
 */
const NO_TOOLS = ["__finalize_no_tools__"];

/** Step room for emitting one JSON object — never for more work. */
const FINALIZE_MAX_STEPS = 6;

/**
 * Runs a stage checkpoint under the schema gate. Returns the envelope of the first attempt
 * that produced complete, schema-valid output; after the retries, one FINALIZE attempt
 * (tools off, minimal steps) asks for the JSON alone — then throws the last `StageError`
 * (which names the banked file) when even that produced nothing valid.
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
        : buildSchemaRetryPrompt(request.prompt, lastReason);
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
      // A StageError on the LAST loop attempt falls through to the finalize ask
      // below — rethrowing here would skip the one mechanism built for exactly
      // this moment (a stage that worked but never emitted its JSON).
      lastReason = error.message.split("\n")[0] ?? lastReason;
    }
  }

  try {
    const finalize = await session.checkpoint({
      ...request,
      prompt: buildFinalizePrompt(lastReason),
      tools: NO_TOOLS,
      maxSteps: FINALIZE_MAX_STEPS,
    });
    if (!finalize.truncated) {
      return finalize;
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
    `${lastReason} — after ${attempts} attempt(s) and a finalize ask`,
    banked,
  );
};
