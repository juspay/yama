/**
 * Types for the runner layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ChangeSet } from "./changes.js";
import type { CheckRunResult, CommandRunner, PreparedCheck } from "./checks.js";
import type { ResolvedConfig } from "./config.js";

export type ExecuteCheckOptions = {
  check: PreparedCheck;
  runner: CommandRunner;
  cwd: string;
  signal?: AbortSignal;
  cache?: Map<string, CheckRunResult>;
  now?: () => number;
};

/** What running the configured checks needs from the environment. */
export type RunChecksOptions = {
  config: ResolvedConfig;
  changeSet: ChangeSet;
  projectRoot: string;
  /** Bounded concurrency from the run context. */
  pool: <T>(tasks: Array<() => Promise<T>>) => Promise<T[]>;
  /** Injected so tests never spawn a process. */
  runner?: CommandRunner;
  signal?: AbortSignal;
  cache?: Map<string, CheckRunResult>;
  /** True when the pull request comes from a fork. */
  isFork?: boolean;
};
