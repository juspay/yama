/**
 * Run-scoped types: identity, cancellation, concurrency, and the stage machine.
 */

import type { ConcurrencyPower, ResolvedConfig, StageName } from "./config.js";
import type { GitCommand } from "./diff.js";
import type { ModelChains } from "./factory.js";
import type { RegistryLogger } from "./registry.js";

/** Which pull request this run is about, and where its code lives. */
export type RunIdentity = {
  /** VCS provider label — data only; never selects code paths. */
  provider: string;
  /** Owner / workspace / organisation. */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number, once resolved. Absent until the resolve stage. */
  pullRequestId?: number;
  /** Source branch, when the run was triggered by branch rather than number. */
  branch?: string;
  headSha?: string;
  baseSha?: string;
  baseBranch?: string;
  /** True when the PR originates from a fork — gates check execution. */
  fork?: boolean;
  /** PR author handle; excluded from ownership tagging. */
  author?: string;
};

/** How this run may touch the world. */
export type RunMode = "live" | "dry-run";

/**
 * A concurrency permit pool.
 *
 * The agent decides whether to fan out; this only caps how many sub-agents may
 * run at once. Acquire returns a release function; callers must release in a
 * `finally` or the pool leaks permits for the rest of the run.
 */
export type ConcurrencyPool = {
  readonly size: number;
  readonly available: number;
  readonly waiting: number;
  acquire(signal?: AbortSignal): Promise<() => void>;
};

/** Everything a run carries, shared by the main agent and every sub-agent. */
export type RunContext = {
  runId: string;
  sessionId: string;
  identity: RunIdentity;
  mode: RunMode;
  projectRoot: string;
  startedAt: number;
  /** Cancels every in-flight model call and tool execution in the run. */
  signal: AbortSignal;
  abort(reason: string): void;
  /** Sub-agent permits. */
  pool: ConcurrencyPool;
  /** Maximum sub-agents the main agent may launch in a single turn. */
  delegationsPerTurn: number;
  concurrency: ConcurrencyPower;
  /**
   * Optional hard deadline in epoch milliseconds. There is NO default — a review
   * is bounded by work, not by a clock. Present only when an operator set one.
   */
  deadlineAt?: number;
  /** Milliseconds left before the deadline, or Infinity when none is set. */
  remainingMs(): number;
};

// ── Stage machine ────────────────────────────────────────────────────────────

/** Why a stage finished the way it did. */
export type StageStatus = "passed" | "degraded" | "skipped" | "failed";

/**
 * The verdict of a stage's exit predicate.
 *
 * A failure MUST name what is missing, specifically. "3 findings unposted" is
 * useless to an agent; "findings a1, a7 accepted but unposted" is actionable,
 * and the difference is the whole reason the remediation loop works.
 */
export type StageCheck =
  | { ok: true }
  | { ok: false; missing: string[]; guidance: string };

export type StageOutcome = {
  stage: StageName;
  status: StageStatus;
  attempts: number;
  /** Populated when the stage ended degraded or failed. */
  missing?: string[];
  detail?: string;
  durationMs: number;
};

export type RunOutcome = {
  runId: string;
  identity: RunIdentity;
  mode: RunMode;
  stages: StageOutcome[];
  /** True when any stage ended degraded — a partial run may never approve. */
  partial: boolean;
  startedAt: number;
  finishedAt: number;
};

/** What one review run needs from its caller. */
export type ReviewRunOptions = {
  config: ResolvedConfig;
  context: RunContext;
  chains: ModelChains;
  /** Git command runner, injected so the assembly stays testable. */
  git: GitCommand;
  base: string;
  head: string;
  /** True when the pull request comes from a fork — checks are off by default. */
  isFork?: boolean;
  logger?: RegistryLogger;
  /** Overridden by tests; production passes the real environment. */
  env?: NodeJS.ProcessEnv;
};
