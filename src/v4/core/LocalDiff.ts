/**
 * Reading the change from the local checkout.
 *
 * The repository is already on disk — that is how `.yama/` was found — so the
 * diff comes from git rather than from the VCS API. This is the single change
 * that removes most of a review's tool calls: the agent no longer has to ask a
 * remote service, one request at a time, what it could read locally.
 *
 * The VCS fallback exists for shallow clones, where git genuinely cannot answer.
 */

import type {
  ChangeSet,
  GitCommand,
  LocalDiffOptions,
} from "../types/index.js";
import { buildChangeSet } from "../changes/ChangeSet.js";

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

/**
 * Resolve the merge base of two refs.
 *
 * `base...head` (three dots) is what a pull request actually shows: changes on
 * head since it diverged, excluding anything that landed on base meanwhile.
 * Using two dots would report other people's merges as part of this change.
 */
export async function resolveMergeBase(
  git: GitCommand,
  cwd: string,
  base: string,
  head: string,
): Promise<string> {
  const result = await git(["merge-base", base, head], { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new DiffError(
      `Could not find where ${head} diverged from ${base}. ` +
        `A shallow clone is the usual cause — check out with fetch-depth: 0.`,
    );
  }
  return result.stdout.trim();
}

/** Is this a shallow clone? A shallow clone produces a WRONG diff, not an absent one. */
export async function isShallow(
  git: GitCommand,
  cwd: string,
): Promise<boolean> {
  const result = await git(["rev-parse", "--is-shallow-repository"], { cwd });
  return result.stdout.trim() === "true";
}

/**
 * Build the change set from the local repository.
 *
 * On a re-run, `since` narrows the diff to what has been pushed since the last
 * review. The full change is still available; this is what makes a second run
 * cost a fraction of the first.
 */
export async function readLocalChangeSet(
  options: LocalDiffOptions,
): Promise<ChangeSet> {
  const { git, cwd } = options;

  if (await isShallow(git, cwd)) {
    throw new DiffError(
      "This is a shallow clone, so the diff against the base branch would be wrong " +
        "rather than merely incomplete. Check out with fetch-depth: 0.",
    );
  }

  const from =
    options.since ??
    (await resolveMergeBase(git, cwd, options.base, options.head));

  const result = await git(
    [
      "diff",
      "--no-color",
      // Rename detection keeps a moved file from reading as a delete plus an add.
      "--find-renames",
      "--unified=3",
      from,
      options.head,
    ],
    { cwd },
  );

  if (result.exitCode !== 0) {
    throw new DiffError(
      `git diff ${from}..${options.head} failed: ${result.stderr.trim() || "unknown error"}`,
    );
  }

  return buildChangeSet({
    diff: result.stdout,
    baseSha: from,
    headSha: options.head,
    excludePatterns: options.excludePatterns,
    maxFiles: options.maxFiles,
    ...(options.deletions ? { deletions: options.deletions } : {}),
  });
}

/** Content hashes for the paths in scope, for content-addressed check caching. */
export async function hashFiles(
  git: GitCommand,
  cwd: string,
  ref: string,
  paths: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  if (paths.length === 0) {
    return hashes;
  }
  const result = await git(["ls-tree", "-r", ref, "--", ...paths], { cwd });
  if (result.exitCode !== 0) {
    return hashes;
  }
  for (const line of result.stdout.split("\n")) {
    // "<mode> blob <sha>\t<path>"
    const match = /^\S+\s+blob\s+(\S+)\t(.+)$/.exec(line);
    if (match) {
      hashes.set(match[2], match[1]);
    }
  }
  return hashes;
}
