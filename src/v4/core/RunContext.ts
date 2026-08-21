/**
 * Run context — identity, cancellation, and the concurrency pool that every
 * agent in a run shares.
 *
 * Deliberately NOT here: token budgets and default wall clocks. A review is
 * bounded by work. The only throttle is how many sub-agents may run at once, and
 * the only clock is one an operator explicitly asked for.
 */

import { randomBytes } from "node:crypto";
import type {
  ConcurrencyPool,
  ConcurrencyPower,
  CreateRunContextOptions,
  RunContext,
  RunIdentity,
} from "../types/index.js";
import { CONCURRENCY_TIERS } from "../config/defaults.js";

/**
 * A counting semaphore.
 *
 * Waiters are served FIFO so a sub-agent cannot be starved by later arrivals,
 * and each release hands the permit directly to the next waiter rather than
 * incrementing a counter — which keeps the invariant `available + held == size`
 * true even if a caller releases twice.
 */
class Semaphore implements ConcurrencyPool {
  private permits: number;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort?: () => void;
    signal?: AbortSignal;
  }> = [];

  constructor(readonly size: number) {
    this.permits = size;
  }

  get available(): number {
    return this.permits;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Concurrency permit not acquired: run was cancelled.");
    }

    if (this.permits > 0) {
      this.permits -= 1;
      return this.releaseOnce();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index !== -1) {
            this.queue.splice(index, 1);
          }
          reject(
            new Error("Concurrency permit not acquired: run was cancelled."),
          );
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  /**
   * Guard against double-release: a caller that releases twice would inflate the
   * pool past its configured ceiling, which is exactly the failure the tier is
   * meant to prevent.
   */
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (next) {
        if (next.onAbort && next.signal) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.resolve(this.releaseOnce());
        return;
      }
      this.permits += 1;
    };
  }
}

/** Milliseconds from a duration string like "15m", "90s", "2h", or a number. */
export function parseDurationMs(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? "ms").toLowerCase();
  const scale =
    unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return amount * scale;
}

/** Stable, human-scannable session id. Doubles as the PR-artifact key prefix. */
export function buildSessionId(identity: RunIdentity): string {
  const parts = [
    "yama",
    identity.owner || "local",
    identity.repo || "repo",
    identity.pullRequestId !== undefined
      ? `pr${identity.pullRequestId}`
      : identity.branch
        ? `branch-${identity.branch}`
        : "unresolved",
  ];
  return parts
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:_.-]+/g, "-");
}

export function createRunContext(options: CreateRunContextOptions): RunContext {
  const { config, identity, mode } = options;
  const now = options.now ?? (() => Date.now());

  const power: ConcurrencyPower = config.review.concurrency.power;
  const tier = CONCURRENCY_TIERS[power];
  const pool = new Semaphore(tier.pool);

  const controller = new AbortController();
  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      controller.abort(options.parentSignal.reason);
    } else {
      options.parentSignal.addEventListener(
        "abort",
        () => controller.abort(options.parentSignal?.reason),
        { once: true },
      );
    }
  }

  const startedAt = now();
  const deadlineMs = parseDurationMs(config.review.deadline);
  const deadlineAt =
    deadlineMs === undefined ? undefined : startedAt + deadlineMs;

  return {
    runId: options.runId ?? randomBytes(8).toString("hex"),
    sessionId: buildSessionId(identity),
    identity,
    mode,
    projectRoot: config.projectRoot,
    startedAt,
    signal: controller.signal,
    abort: (reason: string) => controller.abort(reason),
    pool,
    delegationsPerTurn: tier.delegationsPerTurn,
    concurrency: power,
    deadlineAt,
    remainingMs: () =>
      deadlineAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, deadlineAt - now()),
  };
}

/**
 * Refresh identity fields discovered mid-run (PR number, head SHA) without
 * losing the run's session id — a session that renamed itself after resolving
 * the PR would orphan the conversation the supervisor is watching.
 */
export function withResolvedIdentity(
  context: RunContext,
  patch: Partial<RunIdentity>,
): RunContext {
  return { ...context, identity: { ...context.identity, ...patch } };
}
