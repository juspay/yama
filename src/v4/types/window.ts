/**
 * Types for the window layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ResolvedConfig } from "./config.js";
import type { ModelChains } from "./factory.js";
import type { GitRunner } from "./gitwriter.js";
import type { MergeStrategy } from "./merge.js";
import type { RegistryLogger } from "./registry.js";
import type { RunContext } from "./run.js";

/** Persisted between runs. Small, and committed alongside the knowledge base. */
export type LearnWatermark = {
  schemaVersion: 1;
  /** Branch this watermark tracks. A different branch is a different watermark. */
  branch: string;
  /** Last commit fully learned from. Absent on the very first run. */
  lastLearnedSha?: string;
  /**
   * Merge timestamp of the newest pull request learned from, ISO-8601.
   *
   * Rebase repositories need this: their commits carry no pull request number,
   * so the window is resolved by asking the provider what merged after this
   * moment rather than by reading commit subjects.
   */
  lastLearnedAt?: string;
  /**
   * Pull requests already learned from, newest first. Bounded — this is a
   * dedup guard against a window that overlaps, not an audit log.
   */
  processed: Array<{ pr: number; sha?: string; at: string }>;
};

/** A pull request the window says still needs learning. */
export type WindowEntry = {
  pullRequestId: number;
  /** Merge commit, when the strategy gives one. */
  sha?: string;
  /** Merge timestamp, ISO-8601. Drives ordering. */
  mergedAt: string;
  /** How this entry was identified, for the run report. */
  via: "commit-subject" | "provider-listing" | "trigger";
};

/** Commits between the watermark and HEAD, oldest first. */
export type WindowCommit = {
  sha: string;
  subject: string;
  body?: string;
  parentCount: number;
  committedAt: string;
};

/** Merged pull requests as the provider reports them. */
export type ProviderMergedPullRequest = {
  id: number;
  mergedAt: string;
  mergeCommitSha?: string;
};

export type ResolveWindowInput = {
  strategy: MergeStrategy;
  watermark: LearnWatermark;
  /** Commits since the watermark, oldest first. Empty when unavailable. */
  commits: WindowCommit[];
  /** Merged pull requests from the provider. Required for rebase. */
  providerMerged?: ProviderMergedPullRequest[];
  /** The pull request that triggered this run, when the CI event supplied one. */
  triggerPullRequestId?: number;
  triggerMergedAt?: string;
  /** Clock, injected for tests. */
  now?: () => Date;
};

export type ResolvedWindow = {
  entries: WindowEntry[];
  /** Commits that carried no pull request reference. Reported, never guessed at. */
  skipped: Array<{ sha: string; reason: string }>;
  /** True when this is the first run and the window was deliberately narrowed. */
  firstRun: boolean;
  warnings: string[];
};

/** What a learn run needs from its caller. */
export type LearnRunOptions = {
  config: ResolvedConfig;
  context: RunContext;
  chains: ModelChains;
  window: ResolvedWindow;
  watermark: LearnWatermark;
  gitRunner: GitRunner;
  env?: NodeJS.ProcessEnv;
  logger?: RegistryLogger;
};

export type LearnRunResult = {
  /** Pull requests this run actually processed, in order. */
  learnedFrom: number[];
  changes: string[];
  committed: boolean;
  pushed?: boolean;
  summary?: string;
  warnings: string[];
};
