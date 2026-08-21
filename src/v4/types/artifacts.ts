/**
 * Types for the artifacts layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

/** Accumulated understanding of one pull request. */
export type PrArtifact = {
  schemaVersion: 1;
  pullRequestId: number;
  /** Head SHAs reviewed so far, oldest first. */
  reviewedShas: string[];
  /** Free-form notes the agent accumulated. Compacted as it grows. */
  context: string;
  /** Everything the gate has ruled on, across runs. */
  findings: {
    posted: Array<{
      id: string;
      commentId: string;
      severity: string;
      title: string;
      filePath?: string;
      line?: number | null;
    }>;
    rejected: Array<{ id: string; reason: string; title: string }>;
  };
  /** The impact narrative, refined each run. */
  impact?: string;
  runs: Array<{
    sha: string;
    at: string;
    decision?: string;
    postedCount: number;
    degradedStages: string[];
  }>;
};
