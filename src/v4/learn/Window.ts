/**
 * The learning window — which pull requests still need to be learned from.
 *
 * A single merge event is not a reliable unit of work. Runs get cancelled, CI
 * has outages, a workflow gets disabled for a week, several pull requests merge
 * while one learn job is queued. If each run only ever learns from the pull
 * request that triggered it, every one of those situations loses feedback
 * permanently and silently.
 *
 * So learning tracks a WATERMARK — the last commit it has fully learned from —
 * and each run processes everything merged since. Usually that is one pull
 * request. Sometimes it is five. The mechanism is the same either way.
 *
 * The watermark advances only past pull requests that were actually learned. A
 * failure in the middle leaves the rest in the window for the next run, which is
 * what makes "handle one or many" safe rather than merely convenient.
 */

import type {
  LearnWatermark,
  ProviderMergedPullRequest,
  ResolveWindowInput,
  ResolvedWindow,
  WindowCommit,
  WindowEntry,
} from "../types/index.js";

const MAX_PROCESSED = 200;

/**
 * How far back a first run reaches.
 *
 * A repository adopting Yama has years of history. Learning from all of it would
 * be expensive, slow, and mostly wrong — conventions from three years ago are
 * not this team's conventions. `yama bootstrap` is the deliberate,
 * human-reviewed way to mine history; this is the automatic path, and it starts
 * from now.
 */
export const FIRST_RUN_LOOKBACK = 1;

export function emptyWatermark(branch: string): LearnWatermark {
  return { schemaVersion: 1, branch, processed: [] };
}

const SQUASH_SUBJECT = /\((?:pull request )?#(\d+)\)\s*$/i;
const MERGE_SUBJECT = /^Merge (?:pull request|pr) #(\d+)\b/i;
const TRAILER = /^\s*(?:PR|Pull-Request):\s*#?(\d+)\s*$/im;

/**
 * Squash and merge-commit repositories: read the pull request number out of the
 * commits themselves.
 *
 * No provider call, no clock, no ambiguity — the number is right there in the
 * subject. A commit with no marker is a direct push, which taught nobody
 * anything and is skipped rather than guessed at.
 */
export function windowFromCommits(commits: WindowCommit[]): {
  entries: WindowEntry[];
  skipped: Array<{ sha: string; reason: string }>;
} {
  const entries: WindowEntry[] = [];
  const skipped: Array<{ sha: string; reason: string }> = [];
  const seen = new Set<number>();

  for (const commit of commits) {
    const match =
      MERGE_SUBJECT.exec(commit.subject) ??
      SQUASH_SUBJECT.exec(commit.subject) ??
      TRAILER.exec(commit.body ?? "");

    if (!match) {
      skipped.push({
        sha: commit.sha,
        reason:
          "no pull request reference — a direct push, or a rebased commit",
      });
      continue;
    }

    const pullRequestId = Number(match[1]);
    if (seen.has(pullRequestId)) {
      // A squash-and-merge of a branch that itself contained a merge commit can
      // reference the same pull request twice.
      continue;
    }
    seen.add(pullRequestId);

    entries.push({
      pullRequestId,
      sha: commit.sha,
      mergedAt: commit.committedAt,
      via: "commit-subject",
    });
  }

  return { entries, skipped };
}

/**
 * Rebase repositories: ask the provider what merged after the watermark.
 *
 * Rebased commits carry no pull request number and no merge commit, so the
 * commit log genuinely cannot answer this. The provider can, because it recorded
 * the merge even though git did not.
 *
 * The boundary is exclusive on `after`: a pull request merged at exactly the
 * watermark timestamp was already learned from, and re-learning it would double
 * every occurrence count it contributed.
 */
export function windowFromProvider(
  merged: ProviderMergedPullRequest[],
  after: string | undefined,
): WindowEntry[] {
  return (
    merged
      .filter((entry) => (after === undefined ? true : entry.mergedAt > after))
      .map((entry) => ({
        pullRequestId: entry.id,
        sha: entry.mergeCommitSha,
        mergedAt: entry.mergedAt,
        via: "provider-listing" as const,
      }))
      // Oldest first: corrections must be linked in the order they happened, or a
      // fix would be recorded before the change it fixes.
      .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
  );
}

/**
 * Resolve what this run should learn from.
 *
 * The trigger's own pull request is always included, even when the strategy
 * cannot see it: the CI event is exact, and a run triggered by a merge must
 * never conclude there is nothing to learn from that merge.
 */
export function resolveWindow(input: ResolveWindowInput): ResolvedWindow {
  const warnings: string[] = [];
  const firstRun = input.watermark.lastLearnedSha === undefined;
  const alreadyProcessed = new Set(
    input.watermark.processed.map((entry) => entry.pr),
  );

  let entries: WindowEntry[] = [];
  let skipped: Array<{ sha: string; reason: string }> = [];

  if (input.strategy === "rebase") {
    if (!input.providerMerged) {
      warnings.push(
        "This repository rebases on merge, so commits carry no pull request number " +
          "and the window can only come from the provider. No listing was supplied, " +
          "so only the triggering pull request will be learned from.",
      );
    } else {
      entries = windowFromProvider(
        input.providerMerged,
        input.watermark.lastLearnedAt,
      );
    }
  } else {
    const derived = windowFromCommits(input.commits);
    entries = derived.entries;
    skipped = derived.skipped;
  }

  // The trigger is exact. Add it if the strategy missed it — which is the normal
  // case on a rebase repository with no provider listing.
  if (
    input.triggerPullRequestId !== undefined &&
    !entries.some((entry) => entry.pullRequestId === input.triggerPullRequestId)
  ) {
    entries.push({
      pullRequestId: input.triggerPullRequestId,
      // "Now" rather than the epoch when the event carried no timestamp. The
      // merge just happened, so now is the honest value — and an epoch-0
      // timestamp would be written into the watermark, after which every rebase
      // window would ask the provider for everything merged since 1970.
      mergedAt:
        input.triggerMergedAt ?? (input.now?.() ?? new Date()).toISOString(),
      via: "trigger",
    });
  }

  const before = entries.length;
  entries = entries
    .filter((entry) => !alreadyProcessed.has(entry.pullRequestId))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  if (before > entries.length) {
    warnings.push(
      `${before - entries.length} pull request(s) in the window were already learned ` +
        `from and were skipped.`,
    );
  }

  // A first run on a repository with years of history must not try to learn from
  // all of it. `yama bootstrap` is the deliberate path for mining history.
  if (firstRun && entries.length > FIRST_RUN_LOOKBACK) {
    const dropped = entries.length - FIRST_RUN_LOOKBACK;
    entries = entries.slice(-FIRST_RUN_LOOKBACK);
    warnings.push(
      `First run: ${dropped} older pull request(s) were skipped rather than learned ` +
        `from in bulk. Run \`yama bootstrap\` to mine history deliberately — it opens ` +
        `a pull request for review instead of committing directly.`,
    );
  }

  if (entries.length > 1) {
    warnings.push(
      `Catching up on ${entries.length} merged pull requests. Learning is applied ` +
        `oldest first so corrections link to what they corrected.`,
    );
  }

  return { entries, skipped, firstRun, warnings };
}

/**
 * Advance the watermark past pull requests that were actually learned from.
 *
 * `learned` is the subset that SUCCEEDED. Anything that failed stays outside the
 * watermark and comes back in the next window. Advancing past a failure would
 * lose that pull request's feedback permanently, which is the failure this whole
 * module exists to prevent.
 */
export function advanceWatermark(
  watermark: LearnWatermark,
  learned: WindowEntry[],
): LearnWatermark {
  if (learned.length === 0) {
    return watermark;
  }

  const ordered = [...learned].sort((a, b) =>
    a.mergedAt.localeCompare(b.mergedAt),
  );
  const newest = ordered[ordered.length - 1];

  // Only move forward. An out-of-order run — a manual re-run of an old pull
  // request, say — must not rewind the watermark and cause everything after it
  // to be learned from twice.
  const advances =
    watermark.lastLearnedAt === undefined ||
    newest.mergedAt > watermark.lastLearnedAt;

  const processed = [
    ...ordered
      .map((entry) => ({
        pr: entry.pullRequestId,
        sha: entry.sha,
        at: entry.mergedAt,
      }))
      .reverse(),
    ...watermark.processed,
  ].slice(0, MAX_PROCESSED);

  return {
    ...watermark,
    ...(advances
      ? {
          lastLearnedSha: newest.sha ?? watermark.lastLearnedSha,
          lastLearnedAt: newest.mergedAt,
        }
      : {}),
    processed,
  };
}

/** Human-readable account of the window, for the run log and the commit body. */
export function describeWindow(window: ResolvedWindow): string {
  const lines: string[] = [];

  if (window.entries.length === 0) {
    lines.push("Nothing new to learn from.");
  } else {
    lines.push(
      `Learning from ${window.entries.length} pull request(s), oldest first:`,
      ...window.entries.map(
        (entry) =>
          `  #${entry.pullRequestId} (${entry.mergedAt}, via ${entry.via})`,
      ),
    );
  }

  if (window.skipped.length > 0) {
    lines.push(
      "",
      `${window.skipped.length} commit(s) carried no pull request reference and were ` +
        `skipped:`,
      ...window.skipped
        .slice(0, 5)
        .map((entry) => `  ${entry.sha.slice(0, 8)} — ${entry.reason}`),
    );
  }

  for (const warning of window.warnings) {
    lines.push("", warning);
  }

  return lines.join("\n");
}
