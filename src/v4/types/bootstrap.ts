/**
 * Types for the bootstrap layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ProductCapability } from "./product.js";
import type { ModelChains } from "./factory.js";
import type { RegistryLogger } from "./registry.js";
import type { ResolvedConfig, RuleEntry } from "./config.js";
import type { RunContext } from "./run.js";

/** What bootstrap examines. Supplied by the caller; this module is pure. */
export type BootstrapInput = {
  /** Merged pull requests, newest first. */
  mergedPullRequests: Array<{
    id: number;
    title: string;
    /** Human review comments. Bot comments are excluded by the caller. */
    comments: Array<{ author: string; body: string; path?: string }>;
    changedPaths: string[];
  }>;
  /** Top-level directories, for the first capability sketch. */
  topLevelPaths: string[];
  /** Repository docs found on disk, by path. */
  docs: Array<{ path: string; excerpt: string }>;
};

export type BootstrapPlan = {
  files: Array<{ path: string; content: string; rationale: string }>;
  /** What bootstrap looked at, so a reviewer can judge its basis. */
  evidence: {
    pullRequestsExamined: number;
    humanCommentsExamined: number;
    docsFound: string[];
  };
  warnings: string[];
  /** The pull request body, explaining what to check. */
  pullRequestBody: string;
};

export type BootstrapDraft = {
  rules: RuleEntry[];
  capabilities: ProductCapability[];
  profile: string;
};

export type BootstrapRunOptions = {
  config: ResolvedConfig;
  context: RunContext;
  chains: ModelChains;
  /** How many merged pull requests to read. Defaults to BOOTSTRAP_WINDOW. */
  window?: number;
  logger?: RegistryLogger;
  env?: NodeJS.ProcessEnv;
};

export type BootstrapRunResult = {
  /** Absent when there was nothing to mine or nothing usable came back. */
  plan?: BootstrapPlan;
  warnings: string[];
};
