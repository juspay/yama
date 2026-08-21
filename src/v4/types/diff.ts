/**
 * Types for the diff layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { DeletionPolicy } from "./changeset.js";

export type GitCommand = (
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type LocalDiffOptions = {
  git: GitCommand;
  cwd: string;
  base: string;
  head: string;
  excludePatterns: string[];
  maxFiles: number;
  /** Deleted-file policy, forwarded to the change-set builder. */
  deletions?: DeletionPolicy;
  /** Diff from this commit instead of the merge base — the re-run path. */
  since?: string;
};
