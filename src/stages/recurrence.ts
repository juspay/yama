/**
 * Recurring runs (TASKS:Y7.1) — recognising a re-review, and measuring what changed since
 * the last one.
 *
 * Two sources, read independently and for different reasons:
 *
 *   - **The run store** carries what the previous run FOUND (its ledger) and the sha it
 *     reviewed. The sha is what makes an incremental diff possible; the ledger is what the
 *     new run has to account for.
 *   - **The markers on the target** carry what the previous run SAID. The store is a CI
 *     artifact and can be lost between runs; the comments on a pull request cannot be. So
 *     a run whose store is empty still recognises itself as a re-review, and still knows
 *     which findings it has already put in front of a human.
 *
 * Neither stands in for the other, and both are read BEFORE the first stage — the store
 * half before this run's report overwrites the previous one.
 */
import { readTargetComments } from "../platform/index.js";
import { readLedger, readRunReport } from "../store/index.js";
import { acquireDiff, gitHasRef, scanMarkers } from "../tools/index.js";
import type {
  CapabilityRegistry,
  Engine,
  Finding,
  GitDiff,
  PostedComment,
  RecurrenceState,
  RunContext,
  RunStorePaths,
} from "../types/index.js";

/** A run with nothing behind it. Every field is present so callers never branch on shape. */
const FRESH: RecurrenceState = {
  kind: "fresh",
  source: "none",
  priorFindings: [],
  priorFindingIds: [],
  previouslyReported: [],
};

/**
 * Fresh or recurring, from the run store (TASKS:Y3.2, Y7.1).
 *
 * Must be called BEFORE this run writes its own report, or it reads itself. An absent
 * store is `fresh`, which is correct rather than merely cheap: the marker scan below still
 * knows what was said, and posting-time dedup still works off the markers (TASKS:Y4.3).
 */
export const detectRecurrence = async (
  paths: RunStorePaths,
  runId: string,
): Promise<RecurrenceState> => {
  const prior = await readRunReport(paths);
  if (prior === undefined || prior.runId === runId) {
    return { ...FRESH };
  }
  const ledger = await readLedger(paths);
  return {
    kind: "recurring",
    source: "run-report",
    ...(prior.headSha !== undefined ? { lastReviewedSha: prior.headSha } : {}),
    ...(prior.finishedAt !== undefined
      ? { lastReviewedAt: prior.finishedAt }
      : {}),
    priorFindings: ledger.findings,
    priorFindingIds: ledger.findings.map((finding) => finding.id),
    previouslyReported: [],
  };
};

/**
 * The preflight marker scan (TASKS:Y7.1): every finding this repository has already
 * commented on the target, bound to the comment carrying it.
 *
 * Read by the shell through the capability, not transcribed by a model — the same ruling
 * posting-time dedup is built on (TASKS:Y4.3). A run whose store was lost becomes
 * `recurring` on the strength of this alone: something has reviewed this target before,
 * and it said these things.
 */
export const scanReportedFindings = async (options: {
  engine: Engine;
  registry: CapabilityRegistry;
}): Promise<{ reported: PostedComment[]; problem?: string }> => {
  const target = await readTargetComments(options);
  const reported: PostedComment[] = [];
  const seen = new Set<string>();
  // Answers, indexed by the comment they answer. A finding's thread is how a later run
  // learns that a human pushed back on it — or that nobody did.
  const answers = new Map<string, { author?: string; body: string }[]>();
  for (const comment of target.comments) {
    if (comment.inReplyTo === undefined) {
      continue;
    }
    answers.set(comment.inReplyTo, [
      ...(answers.get(comment.inReplyTo) ?? []),
      {
        ...(comment.author !== undefined ? { author: comment.author } : {}),
        body: comment.body,
      },
    ]);
  }
  for (const comment of target.comments) {
    for (const findingId of scanMarkers(comment.body)) {
      if (!seen.has(findingId)) {
        seen.add(findingId);
        const replies = answers.get(comment.id);
        reported.push({
          findingId,
          commentId: comment.id,
          ...(replies !== undefined && replies.length > 0 ? { replies } : {}),
        });
      }
    }
  }
  return {
    reported,
    ...(target.problem !== undefined ? { problem: target.problem } : {}),
  };
};

/**
 * Folds the marker scan into the store's answer. Additive in both directions: markers can
 * turn a store-less run recurring, and the store can carry findings that were never
 * commented on (a dry run, or a run whose delivery failed).
 */
export const withReportedMarkers = (
  recurrence: RecurrenceState,
  scan: { reported: PostedComment[]; problem?: string },
): RecurrenceState => ({
  ...recurrence,
  kind:
    recurrence.kind === "recurring" || scan.reported.length > 0
      ? "recurring"
      : "fresh",
  source:
    recurrence.source !== "none"
      ? recurrence.source
      : scan.reported.length > 0
        ? "markers"
        : "none",
  previouslyReported: scan.reported,
  ...(scan.problem !== undefined ? { markerProblem: scan.problem } : {}),
});

/**
 * What this change has added SINCE the previous review (TASKS:Y7.1).
 *
 * It is additional context, never a replacement for the whole diff: the checklist is
 * written against everything that is being merged, because that is what is being merged.
 * What the incremental diff buys is attention — a re-review that knows which three files
 * moved since it last looked spends its budget there.
 *
 * `undefined` when there is nothing to measure from: no previous sha, or a sha this
 * checkout does not have (a shallow clone, or a force-push that rewrote it away).
 */
export const acquireIncrementalDiff = async (
  run: RunContext,
  recurrence: RecurrenceState,
  signal?: AbortSignal,
): Promise<GitDiff | undefined> => {
  const since = recurrence.lastReviewedSha;
  if (since === undefined || !(await gitHasRef(run.root, since, signal))) {
    return undefined;
  }
  const head = run.target.mode === "branch" ? run.target.branch : undefined;
  const diff = await acquireDiff(
    {
      root: run.root,
      base: since,
      ...(head !== undefined ? { head } : {}),
      // A local re-review must still see a file that did not exist last time.
      includeUntracked: run.target.mode === "local",
    },
    signal,
  );
  return diff.empty ? undefined : diff;
};

/** One line per prior finding: what it was, and where it was, for the agent to check. */
export const describePriorFinding = (finding: Finding): string =>
  `  ${finding.id}  ${finding.severity}  ${finding.file}:${finding.line}  ${finding.summary}`;
