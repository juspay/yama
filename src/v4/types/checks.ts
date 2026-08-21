/**
 * Check execution types.
 *
 * A check is a project-authored command whose output Yama turns into findings.
 * This is the highest-blast-radius surface in the product — it executes code
 * from the repository — so the types make the trust boundary explicit rather
 * than leaving it to convention.
 */

import type { GenerateHost } from "./session.js";
import type { ModelChain } from "./model.js";
import type { RunContext } from "./run.js";

import type { CheckConfig, FindingSeverity } from "./config.js";

/** Where the check configuration and its scripts were resolved from. */
export type CheckTrustSource =
  /** The base branch. The only trusted source for a pull request. */
  | "base"
  /** The working tree. Trusted only outside pull-request review. */
  | "worktree";

/** One finding a parser recovered from a check's output. */
export type CheckFinding = {
  filePath?: string;
  line?: number | null;
  /** Parser-native severity label, mapped through the check's severity map. */
  level?: string;
  severity: FindingSeverity;
  ruleId?: string;
  message: string;
};

export type CheckRunStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "error"
  | "timeout";

export type CheckRunResult = {
  checkId: string;
  status: CheckRunStatus;
  /** Process exit code, when the check actually ran. */
  exitCode?: number;
  durationMs: number;
  findings: CheckFinding[];
  /** Findings dropped by `maxFindings`, reported so truncation is never silent. */
  droppedFindings: number;
  /** Why a check was skipped or errored. */
  reason?: string;
  /** True when the result came from cache rather than a fresh run. */
  cached?: boolean;
  /** Raw output, truncated. Kept for the run report and for `parse: agent`. */
  output?: string;
};

/** A check plus the resolved configuration it will run with. */
export type PreparedCheck = {
  config: CheckConfig;
  /** Paths this check applies to, after `when.paths` filtering. */
  paths: string[];
  /** Cache key over (check id, command, relevant file contents). */
  cacheKey: string;
};

/** What a runner needs from the environment. Injected so this stays testable. */
export type CommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}>;

/** A parser turns raw output into findings. Pure. */
export type CheckOutputParser = (
  output: { stdout: string; stderr: string; exitCode: number },
  context: { checkId: string; severityMap?: Record<string, FindingSeverity> },
) => CheckFinding[];

/**
 * What an extraction pass needs.
 *
 * Named separately from the check runner's own options because extraction is
 * the one part of the checks path that talks to a model, and keeping that
 * boundary explicit is what lets the runner stay pure and testable.
 */
export type ExtractionOptions = {
  host: GenerateHost;
  chain: ModelChain;
  context: RunContext;
  /** The extractor's instruction, resolved from the prompt catalog. */
  instruction: string;
};
