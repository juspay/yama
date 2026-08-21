/**
 * Types for the changeset layer.
 */

export type BuildChangeSetOptions = {
  diff: string;
  baseSha?: string;
  headSha?: string;
  excludePatterns: string[];
  maxFiles: number;
  /** What to do with deleted files. Default "content" — today's behaviour. */
  deletions?: DeletionPolicy;
};

/**
 * How deleted files enter a review.
 *
 * - "content": full diff content is in scope and counts against `maxFiles` —
 *   the original behaviour, and the default so existing configs are unchanged.
 * - "ignore": deleted files are moved to `excluded` with reason "deleted".
 *   They stay visible to ownership and guards (which read excluded files too),
 *   but do not consume `maxFiles` slots and the agent is not asked to review
 *   code that no longer exists. On PR #85, deletions were 93 of 280 files and
 *   pushed 81 real files out of a 200-file scope.
 */
export type DeletionPolicy = "content" | "ignore";
