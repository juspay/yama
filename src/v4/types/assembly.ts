/**
 * Types for the assembly layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { PrArtifact } from "./artifacts.js";
import type { RuleEntry } from "./config.js";
import type { ExistingComment } from "./findings.js";
import type { ImpactLogEntry, ProductCapability } from "./product.js";
import type { RecallEntry } from "./recall.js";
import type { RunIdentity } from "./run.js";

export type RunAssembly = {
  /** Finding ids that already have a comment on the pull request. */
  alreadyReported: Set<string>;
  /** Learned false positives. */
  suppressed: Set<string>;
  /** Everything the agent can recall, including this pull request's history. */
  entries: RecallEntry[];
  /** The commit the last run reviewed, for an incremental diff. */
  previousSha?: string;
  /** True when this is not the first run on this pull request. */
  isRerun: boolean;
  runNumber: number;
  /** Discrepancies worth reporting rather than silently resolving. */
  warnings: string[];
};

export type AssembleInput = {
  identity: RunIdentity;
  comments: ExistingComment[];
  artifact: PrArtifact;
  rules: RuleEntry[];
  /** The product capability map, when the repository has one. */
  product?: ProductCapability[];
  /** Per-merge impact ledger, for historical risk at recall time. */
  impactLog?: ImpactLogEntry[];
  botIdentity?: string;
};

/**
 * Candidate pull requests for a branch.
 *
 * When several match, the caller reports the ambiguity rather than picking.
 * Reviewing the wrong pull request posts comments on someone else's work, which
 * is worse than not running at all.
 */
export type PullRequestCandidate = {
  id: number;
  title?: string;
  sourceBranch?: string;
  state?: string;
};

export type BranchResolution =
  | { resolved: true; pullRequestId: number }
  | { resolved: false; reason: string; candidates: PullRequestCandidate[] };
