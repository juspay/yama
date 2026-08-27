/**
 * Async delegation, seam-local (TASKS:N2 fallback, docs/engine-spec.md section 5.1).
 *
 * The property that matters is out-of-order completion: `delegate` returns a handle
 * immediately, workers finish whenever they finish, and `collect` hands back whichever
 * landed first. Nothing in the review flow may assume spawn order.
 *
 * Every worker's FULL report is banked before its result is offered up; the conversation
 * only ever sees the bounded summary and the read-back hint. Each outcome is claimed
 * exactly once and then dropped, so two collects cannot double-count one worker.
 */
import { z } from "zod";
import type {
  EngineBankApi,
  EngineCollectRequest,
  EngineDelegateCounts,
  EngineDelegateRequest,
  EngineDelegationApi,
  EngineToolRegistrar,
  EngineWorkerHandle,
  EngineWorkerResult,
  EngineWorkerRunner,
} from "../../types/index.js";
import { createPool } from "./pool.js";
import { clampWorkerTools } from "../policy.js";
import { jsonSchemaOf, readParams } from "../../util/tool.js";

const DelegateSchema = z.object({
  task: z.string().min(1),
  scope: z.string().optional(),
  context: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
});

const CollectSchema = z.object({
  mode: z.enum(["any", "all"]).optional(),
  workerId: z.string().min(1).optional(),
  waitMs: z.number().int().positive().optional(),
});

type Job = {
  workerId: string;
  controller: AbortController;
  /** Set once the worker settled AND its report was banked. */
  result?: EngineWorkerResult;
  /** Completion order, independent of spawn order. */
  finishedSeq: number;
  promise: Promise<EngineWorkerResult>;
};

/** Resolves `true` if the work finished inside `waitMs`, `false` if the wait expired. */
const raceWait = async (
  work: Promise<unknown>,
  waitMs: number | undefined,
): Promise<boolean> => {
  if (waitMs === undefined) {
    await work;
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
};

/** Removes and returns finished jobs, oldest completion first. Claimed exactly once. */
const claimReady = (
  jobs: Map<string, Job>,
  limit: number,
): EngineWorkerResult[] => {
  const ready = [...jobs.values()]
    .filter((job) => job.result !== undefined)
    .sort((a, b) => a.finishedSeq - b.finishedSeq)
    .slice(0, limit);
  for (const job of ready) {
    jobs.delete(job.workerId);
  }
  return ready.flatMap((job) => (job.result ? [job.result] : []));
};

/**
 * Collection, out of order by construction: `any` returns whichever job settled first,
 * `all` waits for every outstanding one, and a named workerId waits for just that job.
 */
const collectFrom = async (
  jobs: Map<string, Job>,
  req: EngineCollectRequest,
): Promise<EngineWorkerResult[]> => {
  if ("workerId" in req) {
    const job = jobs.get(req.workerId);
    if (!job) {
      return [];
    }
    const done = await raceWait(job.promise, req.waitMs);
    if (!done || job.result === undefined) {
      return [];
    }
    jobs.delete(job.workerId);
    return [job.result];
  }

  const outstanding = [...jobs.values()].filter(
    (job) => job.result === undefined,
  );
  if (req.mode === "all") {
    if (outstanding.length > 0) {
      await raceWait(
        Promise.allSettled(outstanding.map((job) => job.promise)),
        req.waitMs,
      );
    }
    return claimReady(jobs, Number.POSITIVE_INFINITY);
  }

  const ready = [...jobs.values()].some((job) => job.result !== undefined);
  if (!ready && outstanding.length > 0) {
    await raceWait(
      Promise.race(outstanding.map((job) => job.promise)),
      req.waitMs,
    );
  }
  return claimReady(jobs, 1);
};

/** Registers the two N2 tools against an already-built delegation API. */
const registerDelegationTools = (
  register: EngineToolRegistrar,
  api: {
    delegate: (req: EngineDelegateRequest) => Promise<EngineWorkerHandle>;
    collect: (req: EngineCollectRequest) => Promise<EngineWorkerResult[]>;
    counts: () => EngineDelegateCounts;
  },
): void => {
  register("delegate_task", {
    description:
      "Hand one checklist item to a background worker with its own session. Returns a workerId immediately; the worker's full report is banked and its summary comes back through collect_results, in whatever order workers finish.",
    inputSchema: jsonSchemaOf(DelegateSchema),
    execute: async (params) => {
      const parsed = readParams(DelegateSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const handle = await api.delegate(parsed.value);
      return { ...handle, ...api.counts() };
    },
  });

  register("collect_results", {
    description:
      "Pick up finished workers. mode 'any' returns whichever finished first, 'all' waits for every outstanding worker, or name one workerId. Each result is handed over exactly once — record it before collecting again.",
    inputSchema: jsonSchemaOf(CollectSchema),
    execute: async (params) => {
      const parsed = readParams(CollectSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const { workerId, mode, waitMs } = parsed.value;
      const request: EngineCollectRequest = workerId
        ? { workerId, ...(waitMs !== undefined ? { waitMs } : {}) }
        : { mode: mode ?? "any", ...(waitMs !== undefined ? { waitMs } : {}) };
      const completed = await api.collect(request);
      const outstanding = api.counts();
      return {
        completed,
        pending: outstanding.pending,
        ready: outstanding.ready,
        timedOut: completed.length === 0 && outstanding.pending > 0,
      };
    },
  });
};

/** Spawns background workers and collects them out of order; registers the two N2 tools. */
export const createDelegationFallback = (options: {
  register: EngineToolRegistrar;
  bank: EngineBankApi;
  /** How one worker actually runs. Injected so this file never imports the engine. */
  run: EngineWorkerRunner;
  maxConcurrent: number;
  /** Read-only allowlist every worker is held to; absent means the request decides. */
  workerTools?: readonly string[];
  signal?: AbortSignal;
}): EngineDelegationApi => {
  const pool = createPool(options.maxConcurrent);
  const jobs = new Map<string, Job>();
  let spawned = 0;
  let finished = 0;

  const counts = (): EngineDelegateCounts => {
    let pending = 0;
    let ready = 0;
    for (const job of jobs.values()) {
      if (job.result === undefined) {
        pending += 1;
      } else {
        ready += 1;
      }
    }
    return { pending, ready };
  };

  const delegate = async (
    request: EngineDelegateRequest,
  ): Promise<EngineWorkerHandle> => {
    const req: EngineDelegateRequest =
      options.workerTools === undefined
        ? request
        : {
            ...request,
            tools: clampWorkerTools(request.tools, options.workerTools),
          };
    const workerId = `w${(spawned += 1)}`;
    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });

    const job: Job = {
      workerId,
      controller,
      finishedSeq: 0,
      // Assigned below; the map entry must exist before the work can settle into it.
      promise: Promise.resolve<EngineWorkerResult>({
        workerId,
        ok: false,
        summary: "",
      }),
    };

    job.promise = (async (): Promise<EngineWorkerResult> => {
      const release = await pool.acquire();
      let outcome;
      try {
        outcome = await options.run(req, controller.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome = {
          ok: false,
          summary: `worker ${workerId} failed: ${message}`,
          report: `# worker ${workerId}\n\ntask: ${req.task}\n\nfailed: ${message}\n`,
          error: message,
        };
      } finally {
        release();
      }
      const report = await options.bank.bank({
        kind: "worker-report",
        label: `delegate-${workerId}`,
        payload: outcome.report,
      });
      const result: EngineWorkerResult = {
        workerId,
        ok: outcome.ok,
        summary: outcome.summary,
        report,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      };
      job.result = result;
      job.finishedSeq = finished += 1;
      return result;
    })();
    // Nothing awaits this handle: an unobserved rejection would kill the process.
    job.promise.catch(() => undefined);

    jobs.set(workerId, job);
    return { workerId };
  };

  const collect = (req: EngineCollectRequest): Promise<EngineWorkerResult[]> =>
    collectFrom(jobs, req);

  const cancel = async (workerId?: string): Promise<number> => {
    const targets = workerId
      ? [jobs.get(workerId)].filter((job) => job !== undefined)
      : [...jobs.values()];
    let aborted = 0;
    for (const job of targets) {
      if (job.result === undefined) {
        job.controller.abort();
        aborted += 1;
      }
    }
    return aborted;
  };

  registerDelegationTools(options.register, { delegate, collect, counts });

  return { delegate, collect, counts, cancel };
};
