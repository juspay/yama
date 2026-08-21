/**
 * ChangeSet — the parsed diff, in code.
 *
 * v3 asked the model to respect `excludePatterns` and to comment only on
 * changed lines. Both were prompt text, and both were routinely ignored. Here
 * they are set membership tests over a structure Yama built itself.
 */

/** How a file appears in the diff. */
export type FileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "binary";

/** One contiguous changed region. */
export type Hunk = {
  /** First line number on the OLD side, 1-based. */
  oldStart: number;
  oldLines: number;
  /** First line number on the NEW side, 1-based. */
  newStart: number;
  newLines: number;
};

export type FileChange = {
  /** Path on the new side; for a deletion, the path that was removed. */
  path: string;
  /** Previous path, for renames. */
  previousPath?: string;
  kind: FileChangeKind;
  hunks: Hunk[];
  /** Line numbers added or modified on the new side. The comment-anchor set. */
  addedLines: Set<number>;
  /** Line numbers removed from the old side. */
  removedLines: Set<number>;
  additions: number;
  deletions: number;
  /** Excluded by config or detected as generated; kept for reporting. */
  excluded?: boolean;
  excludedReason?: string;
};

export type ChangeSet = {
  baseSha?: string;
  headSha?: string;
  /** Files Yama will review. */
  files: FileChange[];
  /** Files filtered out, with the reason. Reported, never silently dropped. */
  excluded: FileChange[];
  /** True when maxFiles truncated the set — the review is knowingly partial. */
  truncated: boolean;
  totalAdditions: number;
  totalDeletions: number;
};
