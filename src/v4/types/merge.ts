/**
 * Types for the merge layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

export type MergeStrategy = "squash" | "merge" | "rebase" | "unknown";

export type CommitInfo = {
  sha: string;
  subject: string;
  body?: string;
  /** Number of parents. Two means a merge commit. */
  parentCount: number;
};

export type MergeResolution =
  | { resolved: true; pullRequestId: number; via: ResolutionSource }
  | { resolved: false; reason: string; remedy: string };

export type ResolutionSource =
  | "trigger"
  | "squash-subject"
  | "merge-subject"
  | "trailer"
  | "api";
