/**
 * The main session (TASKS:Y2.2).
 *
 * One run, one session, stages as sequential structured checkpoints on it. Two things
 * happen at every checkpoint and their order is the point: the VERBATIM model output is
 * banked first, then the structured envelope is validated and banked. A stage that fails
 * its schema has therefore already left its evidence on disk.
 */
import type {
  Engine,
  EngineToolResult,
  RunStageMetric,
  RunStorePaths,
  SessionCheckpointRequest,
  SessionRunner,
  Stage,
  StageOutput,
  StructuredResult,
} from "../types/index.js";
import { writePayload, writeStage } from "../store/index.js";
import { StageError } from "./errors.js";
import { isTransientProviderError } from "../util/transient.js";

/** The whole engine reply, as a readable artifact. Nothing here is elided. */
const renderRaw = <T>(
  stage: Stage,
  attempt: number,
  result: StructuredResult<T>,
): string =>
  [
    `# stage ${stage} (checkpoint ${attempt})`,
    `provider: ${result.raw.provider ?? "unknown"}`,
    `model: ${result.raw.model ?? "unknown"}`,
    `steps: ${result.raw.stepsUsed ?? 0}`,
    `tools: ${(result.raw.toolsUsed ?? []).join(", ") || "(none)"}`,
    `repaired: ${result.raw.repaired} · truncated: ${result.raw.truncated} · trusted: ${result.trusted}`,
    ``,
    `## content`,
    result.raw.content,
    ``,
    `## structured`,
    JSON.stringify(result.raw.structured ?? null, null, 2),
    ``,
    `## tool calls`,
    JSON.stringify(result.raw.toolResults ?? [], null, 2),
    ``,
  ].join("\n");

/** Builds the session for one run. Every stage of the run shares its `sessionId`. */
/**
 * How many times a checkpoint's provider call is attempted, and how long it waits between
 * attempts. The schema gate above this retries a bad ANSWER; this retries a failed CALL,
 * which nothing did — one Cloudflare 524 in front of a proxy ended an entire review, and
 * the error itself said it was retryable.
 *
 * Bounded and short on purpose: enough to ride out a hiccup, not enough to sit on a real
 * outage. A non-transient error is not retried at all, so a wrong key still fails on the
 * first attempt instead of three slow ones later.
 */
const PROVIDER_ATTEMPTS = 3;
const PROVIDER_BACKOFF_MS = [2_000, 8_000] as const;

const callWithTransientRetry = async <T>(
  call: () => Promise<T>,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const more = attempt < PROVIDER_ATTEMPTS - 1;
      if (!more || !isTransientProviderError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, PROVIDER_BACKOFF_MS[attempt] ?? 8_000),
      );
    }
  }
  throw lastError;
};

export const createSessionRunner = (options: {
  engine: Engine;
  paths: RunStorePaths;
  sessionId: string;
}): SessionRunner => {
  const metrics: RunStageMetric[] = [];
  /**
   * Checkpoints taken per stage. A stage can be asked more than once — the schema gate
   * retries, and the work stage runs a round per nudge — and each answer banks to its own
   * file. Overwriting the previous one would destroy the evidence a failure points at.
   */
  const attempts = new Map<Stage, number>();
  /** Tool results of the last checkpoint — Delivery's confirmation reads these. */
  let lastToolResults: EngineToolResult[] = [];

  const checkpoint = async <T>(
    req: SessionCheckpointRequest<T>,
  ): Promise<StageOutput<Stage, T>> => {
    const startedAt = new Date().toISOString();
    const began = Date.now();
    const result = await callWithTransientRetry(() =>
      options.engine.generateStructured({
        sessionId: options.sessionId,
        prompt: req.prompt,
        schema: req.schema,
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
        ...(req.maxSteps !== undefined ? { maxSteps: req.maxSteps } : {}),
      }),
    );

    lastToolResults = result.raw.toolResults ?? [];
    const attempt = (attempts.get(req.stage) ?? 0) + 1;
    attempts.set(req.stage, attempt);
    const banked = await writePayload(
      options.paths,
      attempt === 1 ? `stage-${req.stage}` : `stage-${req.stage}-${attempt}`,
      renderRaw(req.stage, attempt, result),
    );

    const metric: RunStageMetric = {
      stage: req.stage,
      startedAt,
      durationMs: Date.now() - began,
      trusted: result.trusted,
      truncated: result.raw.truncated,
      ...(result.raw.provider !== undefined
        ? { provider: result.raw.provider }
        : {}),
      ...(result.raw.model !== undefined ? { model: result.raw.model } : {}),
      ...(result.raw.stepsUsed !== undefined
        ? { stepsUsed: result.raw.stepsUsed }
        : {}),
      ...(result.raw.toolsUsed !== undefined
        ? { toolsUsed: result.raw.toolsUsed }
        : {}),
      envelopePath: "",
      rawPath: banked.file,
    };
    metrics.push(metric);

    if (result.data === undefined) {
      throw new StageError(
        req.stage,
        result.raw.truncated
          ? "the model's JSON was cut short"
          : "nothing schema-valid came back",
        banked.file,
      );
    }

    const envelope: StageOutput<Stage, T> = {
      stage: req.stage,
      data: result.data,
      trusted: result.trusted,
      truncated: result.raw.truncated,
      completedAt: new Date().toISOString(),
    };
    metric.envelopePath = await writeStage(options.paths, envelope);
    return { ...envelope, path: metric.envelopePath };
  };

  return {
    sessionId: options.sessionId,
    checkpoint,
    metrics: () => metrics.map((metric) => ({ ...metric })),
    toolResults: () => [...lastToolResults],
  };
};
