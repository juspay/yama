/**
 * The product model — what the code DOES, in product terms, and what each merge
 * did to it.
 *
 * This is the part of Yama that no linter and no diff-reading reviewer can
 * replicate, because it is not derivable from the change under review. It is
 * accumulated: every merge writes down what it did to which capability, and the
 * next review of that capability gets to read it.
 *
 * Both files are git-tracked and human-editable. A wrong entry is one revert
 * away, and the corrections a team makes are the highest-quality signal in the
 * system.
 */

/** A product capability: what a region of code means to a user. */
export type ProductCapability = {
  id: string;
  name: string;
  /** Paths that implement it. */
  paths: string[];
  /** Entry points — functions, endpoints, commands — that expose it. */
  entrypoints?: string[];
  /** Whether a defect here is visible to a user. */
  userVisible?: boolean;
  /**
   * How it fails. The most valuable field: a capability that fails SILENTLY is
   * far more dangerous than one that throws, and the diff never says which.
   */
  failureMode?: string;
  /** Capability ids this one depends on. */
  dependsOn?: string[];
  criticality?: "high" | "medium" | "low";
  /** Free-form notes accumulated by learning. */
  notes?: string;
};

export type ProductCapabilityFile = {
  capabilities: ProductCapability[];
};

/** What one merged pull request did to the product. */
export type ImpactLogEntry = {
  pullRequestId: number;
  mergedAt: string;
  /** Capability ids this change touched. */
  capabilities: string[];
  changeKind: ChangeKind;
  summary: string;
  /** What a user would notice. Empty for internal changes. */
  userVisibleEffect?: string;
  risk?: "high" | "medium" | "low";
  /** Tests that cover the change. */
  testedBy?: string[];
  /**
   * Pull requests that later corrected this one. Backfilled by learning when a
   * revert or fix lands, and the source of the "changes here tend to need
   * correction" signal.
   */
  laterCorrectedBy?: number[];
  /** True when this entry IS a correction of an earlier change. */
  corrects?: number[];
};

export type ChangeKind =
  | "contract-change"
  | "behavior-change"
  | "perf"
  | "internal"
  | "fix"
  | "revert";

/** What the impact specialist produces during a review. */
export type ImpactReport = {
  capabilities: Array<{ id: string; name: string; criticality?: string }>;
  changeKind: ChangeKind;
  blastRadius: string;
  userVisibleEffect?: string;
  /** Failure modes of the touched capabilities. */
  silentFailureModes: string[];
  /** How often changes here have needed correcting. */
  historicalRisk?: {
    totalChanges: number;
    corrected: number;
    recentCorrections: number[];
  };
  suggestedTests: string[];
  /** What could not be traced. Stated rather than assumed safe. */
  unresolved: string[];
};
