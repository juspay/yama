/**
 * Which pull request did this commit merge?
 *
 * Getting this wrong is worse than not learning at all: feedback attributed to
 * the wrong pull request teaches the knowledge base a lie, and lies compound.
 * So every path here either produces a confident answer or refuses.
 *
 * Rebase merges genuinely cannot be resolved from git history — there is no PR
 * number in a rebased commit. Rather than guess, learning is DISABLED and said
 * out loud, with the three ways to make it work.
 */
import type {
  CommitInfo,
  MergeResolution,
  MergeStrategy,
} from "../types/index.js";

/**
 * Detect the repository's merge strategy from recent history.
 *
 * Sampled rather than assumed: a repository's settings can say one thing while
 * its history shows another, and history is what learning has to work with.
 */
export function detectMergeStrategy(commits: CommitInfo[]): MergeStrategy {
  if (commits.length === 0) {
    return "unknown";
  }

  const merges = commits.filter((commit) => commit.parentCount >= 2).length;
  const squashes = commits.filter(
    (commit) => commit.parentCount === 1 && SQUASH_SUBJECT.test(commit.subject),
  ).length;

  // A quarter is a low bar on purpose: many repositories mix direct pushes with
  // pull requests, so the signal is "does this repository use X at all", not
  // "does it use X exclusively".
  const threshold = Math.max(1, Math.floor(commits.length * 0.25));

  if (merges >= threshold) {
    return "merge";
  }
  if (squashes >= threshold) {
    return "squash";
  }
  return "rebase";
}

/** `feat: thing (#142)` or `feat: thing (pull request #142)` */
const SQUASH_SUBJECT = /\((?:pull request )?#(\d+)\)\s*$/i;
/** `Merge pull request #142 from …` */
const MERGE_SUBJECT = /^Merge (?:pull request|pr) #(\d+)\b/i;
/** `PR: #142` trailer, for repositories that add one deliberately. */
const TRAILER = /^\s*(?:PR|Pull-Request):\s*#?(\d+)\s*$/im;

/**
 * Resolve the pull request for a merged commit.
 *
 * @param triggerPullRequestId  The number the CI event supplied. Exact when
 *                              present, which is why `init` writes the workflow
 *                              to run on the merge event rather than on push.
 */
export function resolveMergedPullRequest(
  commit: CommitInfo,
  options: {
    triggerPullRequestId?: number;
    strategy?: MergeStrategy;
    /** Reverse lookup by SHA, where the provider supports it. */
    apiLookup?: number;
  } = {},
): MergeResolution {
  if (options.triggerPullRequestId !== undefined) {
    return {
      resolved: true,
      pullRequestId: options.triggerPullRequestId,
      via: "trigger",
    };
  }

  const mergeMatch = MERGE_SUBJECT.exec(commit.subject);
  if (mergeMatch) {
    return {
      resolved: true,
      pullRequestId: Number(mergeMatch[1]),
      via: "merge-subject",
    };
  }

  const squashMatch = SQUASH_SUBJECT.exec(commit.subject);
  if (squashMatch) {
    return {
      resolved: true,
      pullRequestId: Number(squashMatch[1]),
      via: "squash-subject",
    };
  }

  const trailerMatch = TRAILER.exec(commit.body ?? "");
  if (trailerMatch) {
    return {
      resolved: true,
      pullRequestId: Number(trailerMatch[1]),
      via: "trailer",
    };
  }

  if (options.apiLookup !== undefined) {
    return { resolved: true, pullRequestId: options.apiLookup, via: "api" };
  }

  return {
    resolved: false,
    reason:
      options.strategy === "rebase"
        ? `This repository rebases on merge, so commit ${commit.sha.slice(0, 8)} carries no ` +
          `pull request number. It cannot be recovered from git history.`
        : `Commit ${commit.sha.slice(0, 8)} carries no pull request reference.`,
    remedy:
      "Learning needs one of: (a) run `yama learn` on the merge event so CI supplies the " +
      "number — recommended, and what `yama init` writes; (b) enable pull-request " +
      "reverse-lookup by SHA if your provider supports it; (c) add a `PR: #<n>` trailer to " +
      "merge commits. Until then learning is off. Review is unaffected.",
  };
}

/**
 * The message shown when learning cannot run.
 *
 * Deliberately loud. A silently-disabled learning loop looks identical to one
 * that is working and producing nothing, and teams discover the difference
 * months later.
 */
export function renderLearningDisabled(resolution: {
  reason: string;
  remedy: string;
}): string {
  return [
    "Learning is DISABLED for this commit.",
    "",
    resolution.reason,
    "",
    resolution.remedy,
  ].join("\n");
}

/** Whether the configured trigger can reliably identify pull requests. */
export function validateLearnTrigger(
  trigger: "merge-event" | "push" | "disabled",
  strategy: MergeStrategy,
): { ok: boolean; message?: string } {
  if (trigger === "disabled") {
    return { ok: true };
  }
  if (trigger === "merge-event") {
    return { ok: true };
  }
  if (strategy === "rebase") {
    return {
      ok: false,
      message:
        "learn.trigger is 'push' but this repository rebases on merge, so commits carry no " +
        "pull request number. Feedback would be attributed to the wrong pull request, or to " +
        "none. Switch to 'merge-event'.",
    };
  }
  return { ok: true };
}
