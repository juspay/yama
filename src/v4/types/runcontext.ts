import type { ResolvedConfig } from "./config.js";
import type { RunIdentity, RunMode } from "./run.js";
/**
 * Types for the runcontext layer.
 */

export type CreateRunContextOptions = {
  config: ResolvedConfig;
  identity: RunIdentity;
  mode: RunMode;
  /** Parent cancellation, e.g. a CLI SIGINT handler. */
  parentSignal?: AbortSignal;
  /** Overrides the generated run id. Used by tests and resumed runs. */
  runId?: string;
  now?: () => number;
};
