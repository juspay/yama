/**
 * One delegated worker, mapped onto NeuroLink's `runIsolatedAgent` (docs/engine-spec.md
 * section 5.1). Lives inside the seam because it is the only fallback piece that needs
 * the engine itself: a fresh session, the host's shared tool registry, waste detection and
 * continuation handles all come for free from that call.
 *
 * The report it hands back is the WHOLE record — narrative, extraction and every tool
 * execution — because the delegation fallback banks it verbatim and the main session reads
 * it back on demand.
 */
import type { NeuroLink } from "@juspay/neurolink";
import type {
  EngineConfig,
  EngineDelegateRequest,
  EngineWorkerOutcome,
  EngineWorkerRunner,
} from "../types/index.js";

/** How much of a worker's narrative travels inline; the rest is read back from the bank. */
const WORKER_SUMMARY_CHARS = 4_000;

/** Builds the worker runner the delegation fallback injects. */
export const createWorkerRunner = (
  nl: NeuroLink,
  cfg: EngineConfig,
): EngineWorkerRunner => {
  const model = cfg.workerModel ?? cfg.model;

  return async (
    req: EngineDelegateRequest,
    signal: AbortSignal,
  ): Promise<EngineWorkerOutcome> => {
    const outcome = await nl.runIsolatedAgent(
      {
        id: "yama-review-worker",
        name: "Yama review worker",
        description:
          "Investigates one item of the review checklist and reports what it found.",
        instructions: [
          cfg.systemPrompt,
          req.context ? `\nBrief for this task:\n${req.context}` : "",
          req.scope ? `\nScope you may look at:\n${req.scope}` : "",
        ].join("\n"),
        ...(model.provider !== undefined ? { provider: model.provider } : {}),
        ...(model.model !== undefined ? { model: model.model } : {}),
        ...(req.tools !== undefined ? { tools: req.tools } : {}),
      },
      req.task,
      { abortSignal: signal },
    );

    const ok = outcome.status === "completed" || outcome.status === "partial";
    const narrative = outcome.content ?? "";
    return {
      ok,
      summary: narrative.slice(0, WORKER_SUMMARY_CHARS),
      report: [
        `# worker report`,
        `status: ${outcome.status}`,
        `duration: ${outcome.durationMs}ms`,
        ``,
        `## task`,
        req.task,
        ``,
        `## narrative`,
        narrative,
        ``,
        `## extracted`,
        JSON.stringify(outcome.data ?? null, null, 2),
        ``,
        `## tool executions`,
        JSON.stringify(outcome.toolExecutions, null, 2),
        ``,
      ].join("\n"),
      ...(ok ? {} : { error: outcome.extractionError ?? outcome.status }),
    };
  };
};
