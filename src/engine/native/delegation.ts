/**
 * Async delegation, engine-native (TASKS:N2, docs/engine-spec.md section 3).
 *
 * `registerDelegationTools()` puts `delegate_task` and `collect_results` on the registry
 * under the fallback's names, so prompts survive the swap. What the engine adds that a
 * seam-local map could not:
 *
 *   - ONE pool, shared with `registerAgentTool`, raised and never lowered — the fallback's
 *     semaphore bounded only the workers it had started itself;
 *   - a depth ceiling, so a worker cannot spawn workers nobody is left to collect;
 *   - waste signals and a `continueAgent` handle for a worker that was cut short;
 *   - `cacheable: false`, without which two identical `collect_results` calls hand back the
 *     SAME worker twice and silently lose the other one.
 *
 * Two things stay Yama's job. The worker toolset is clamped by the HOST (TASKS:Y5.1), never
 * by the model's request; and every worker's full report is mirrored into the run store, so
 * the evidence is in the CI artifact and `reportPath` points at a file that exists.
 */
import type { DelegateOutcome, NeuroLink } from "@juspay/neurolink";
import type {
  EngineCollectRequest,
  EngineDelegateCounts,
  EngineDelegateRequest,
  EngineDelegationApi,
  EngineModel,
  EngineWorkerHandle,
  EngineWorkerResult,
  RunStorePaths,
} from "../../types/index.js";
import { clampWorkerTools } from "../policy.js";
import { mirrorArtifact, toEngineRef } from "./artifacts.js";

/** Spawns background workers through the engine and collects them out of order. */
export const createDelegationNative = (options: {
  nl: NeuroLink;
  paths: RunStorePaths;
  /** Provider and model for a worker session. */
  model: EngineModel;
  /** House rules the worker runs under; the engine writes its own worker preamble. */
  systemPrompt: string;
  maxConcurrent: number;
  /** Read-only allowlist every worker is held to; absent means the request decides. */
  workerTools?: readonly string[];
  /** Session of the stage in flight — collection is scoped to it. */
  currentSession: () => string;
}): EngineDelegationApi => {
  options.nl.registerDelegationTools({
    maxConcurrent: options.maxConcurrent,
    // Without these, a model-invoked `delegate_task` spawn falls back to provider
    // auto-selection — observed live, workers walked vertex → openai → bedrock →
    // anthropic before reaching the configured chain.
    spawnDefaults: {
      ...(options.model.provider !== undefined
        ? { provider: options.model.provider }
        : {}),
      ...(options.model.model !== undefined
        ? { model: options.model.model }
        : {}),
    },
  });

  // The engine owns the authoritative counters and feeds them straight into every
  // `tasks_list` and `collect_results` result. It does not expose them to host code, so
  // this is the last snapshot a collect reported, plus whatever has been spawned since.
  // Callers that need the truth read it off a tool result, which is where the model reads it.
  let pending = 0;
  let ready = 0;

  const counts = (): EngineDelegateCounts => ({ pending, ready });

  const delegate = async (
    req: EngineDelegateRequest,
  ): Promise<EngineWorkerHandle> => {
    const tools =
      options.workerTools === undefined
        ? req.tools
        : clampWorkerTools(req.tools, options.workerTools);
    const handle = await options.nl.spawnDelegate({
      task: req.task,
      // The engine writes the "you are a background worker" preamble; Yama's system
      // instruction is the house rules, and a worker that does not carry them reviews by
      // different standards than the session that spawned it.
      context: [options.systemPrompt, req.context].filter(Boolean).join("\n\n"),
      sessionId: options.currentSession(),
      ...(req.scope !== undefined ? { scope: req.scope } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(options.model.provider !== undefined
        ? { provider: options.model.provider }
        : {}),
      ...(options.model.model !== undefined
        ? { model: options.model.model }
        : {}),
    });
    pending += 1;
    return { workerId: handle.workerId };
  };

  /** One settled worker, with its full report copied into the run store. */
  const toResult = async (
    outcome: DelegateOutcome,
  ): Promise<EngineWorkerResult> => {
    const path = await mirrorArtifact({
      nl: options.nl,
      paths: options.paths,
      artifactId: outcome.report.artifactId,
    });
    return {
      workerId: outcome.workerId,
      ok: outcome.ok,
      summary: outcome.summary,
      report: toEngineRef(outcome.report),
      ...(path !== undefined ? { reportPath: path } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  };

  const collect = async (
    req: EngineCollectRequest,
  ): Promise<EngineWorkerResult[]> => {
    const sessionId = options.currentSession();
    const request =
      "workerId" in req
        ? { workerId: req.workerId, sessionId, ...waitOf(req) }
        : { mode: req.mode, sessionId, ...waitOf(req) };
    // An unknown or already-claimed worker is "nothing new", not a failure — the same
    // answer the seam-local fallback gave, so a caller cannot tell the paths apart.
    const result = await options.nl
      .collectDelegates(request)
      .catch(() => undefined);
    if (result === undefined) {
      return [];
    }
    pending = result.pending;
    ready = result.ready;
    return Promise.all(result.completed.map(toResult));
  };

  return {
    delegate,
    collect,
    counts,
    cancel: (workerId?: string): Promise<number> =>
      options.nl.cancelDelegates(workerId),
  };
};

/** `waitMs` only when the caller named one, so the engine's own default still applies. */
const waitOf = (req: EngineCollectRequest): { waitMs?: number } =>
  req.waitMs !== undefined ? { waitMs: req.waitMs } : {};
