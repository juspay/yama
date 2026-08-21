/**
 * Assembling a run's starting state.
 *
 * A second run on a pull request must not repeat the first. Three independent
 * sources say what has already been said, and they are combined here rather than
 * trusted individually — because each one fails differently:
 *
 *   - **Comment markers** are the ground truth. They live on the pull request,
 *     so they survive a lost artifact, an expired cache, and a fresh runner.
 *   - **The PR artifact** carries reasoning that markers cannot: what was
 *     explored, what was rejected and why.
 *   - **Suppressions** come from the repository's learned knowledge.
 *
 * Markers win where they disagree. An artifact claiming a finding was posted
 * while the pull request shows no comment for it means the post failed, and
 * believing the artifact would silence a real defect permanently.
 */

import type {
  AssembleInput,
  BranchResolution,
  ChangeSet,
  PullRequestCandidate,
  RunAssembly,
} from "../types/index.js";
import { scanMarkers } from "../findings/Markers.js";
import {
  lastReviewedSha,
  reportedIds,
  summarizeForRecall,
} from "../artifacts/PrArtifact.js";
import {
  entriesFromProduct,
  entriesFromRules,
  entryFromPrContext,
} from "../tools/recall.js";

/**
 * Combine every source of "already said this".
 *
 * The reconciliation between markers and artifact is the load-bearing part.
 * v3 persisted accepted findings as reported without checking whether they
 * posted, which turned a single posting failure into permanent silence after
 * three runs. Here the pull request itself is the authority.
 */
export function assembleRun(input: AssembleInput): RunAssembly {
  const warnings: string[] = [];
  const scan = scanMarkers(input.comments, input.botIdentity);

  const fromArtifact = reportedIds(input.artifact);
  const fromMarkers = scan.reportedFindingIds;

  // In the artifact but not on the pull request: the post did not land. Drop it
  // from `alreadyReported` so this run reports it again.
  const claimedButAbsent = [...fromArtifact].filter(
    (id) => !fromMarkers.has(id),
  );
  if (claimedButAbsent.length > 0 && input.comments.length > 0) {
    warnings.push(
      `${claimedButAbsent.length} finding(s) recorded as posted have no comment on the ` +
        `pull request. Treating them as unreported so they are raised again.`,
    );
  }

  // On the pull request but not in the artifact: a lost or expired artifact.
  // The markers are enough — this is the case the design is built to survive.
  const onPrOnly = [...fromMarkers].filter((id) => !fromArtifact.has(id));
  if (onPrOnly.length > 0 && input.artifact.runs.length === 0) {
    warnings.push(
      `${onPrOnly.length} Yama comment(s) exist from a previous run with no artifact. ` +
        `Deduplication is working from the pull request's comments.`,
    );
  }

  if (scan.untrustedMarkers > 0) {
    warnings.push(
      `${scan.untrustedMarkers} Yama marker(s) appear in comments Yama did not author. ` +
        `They are ignored — a quoted marker must never suppress a finding.`,
    );
  }

  const suppressed = new Set(
    input.rules
      .filter((rule) => rule.status === "suppressed")
      .map((rule) => rule.id.replace(/^suppress\./, "")),
  );

  const entries = [
    ...entriesFromRules(input.rules),
    // The product model, when the repository has one. Without this the recall
    // tool's "product" scope could never return anything, and the impact
    // specialist had no capability map to reason over — the whole product layer
    // was built and then never handed to the agent.
    ...entriesFromProduct(input.product ?? [], input.impactLog ?? []),
  ];
  const prEntry = entryFromPrContext(
    input.artifact.pullRequestId,
    summarizeForRecall(input.artifact, input.identity),
  );
  if (prEntry) {
    entries.push(prEntry);
  }

  return {
    alreadyReported: fromMarkers,
    suppressed,
    entries,
    previousSha: lastReviewedSha(input.artifact),
    isRerun: input.artifact.runs.length > 0 || fromMarkers.size > 0,
    runNumber: input.artifact.runs.length + 1,
    warnings,
  };
}

/**
 * The opening message for a run.
 *
 * A re-run is told what changed since last time and what is already said, so it
 * spends its attention on the delta rather than re-deriving the whole pull
 * request. That is the difference between a second run being cheap and a second
 * run costing exactly as much as the first.
 */
export function buildRunMessage(
  assembly: RunAssembly,
  changeSet: ChangeSet,
): string {
  const lines: string[] = [];

  if (!assembly.isRerun) {
    lines.push(
      `${changeSet.files.length} file(s) changed, ` +
        `+${changeSet.totalAdditions}/-${changeSet.totalDeletions} lines.`,
    );
  } else {
    lines.push(
      `Run ${assembly.runNumber} on this pull request.`,
      assembly.previousSha
        ? `Last reviewed ${assembly.previousSha}. Focus on what changed since then; ` +
            `the rest already has your comments.`
        : `Earlier runs already commented on this pull request.`,
      `${assembly.alreadyReported.size} finding(s) already have comments — do not repeat ` +
        `them. Check instead whether each is now fixed, and say which are.`,
    );
  }

  if (changeSet.truncated) {
    lines.push(
      `The file limit was reached: ${changeSet.excluded.filter((file) => file.excludedReason === "maxFiles").length} ` +
        `file(s) are not in scope. Say so in your summary.`,
    );
  }

  for (const warning of assembly.warnings) {
    lines.push(warning);
  }

  lines.push("", "Review it.");
  return lines.join("\n");
}

export function resolveBranch(
  branch: string,
  candidates: PullRequestCandidate[],
): BranchResolution {
  const open = candidates.filter(
    (candidate) => !candidate.state || /open|active/i.test(candidate.state),
  );
  const pool = open.length > 0 ? open : candidates;

  const exact = pool.filter((candidate) => candidate.sourceBranch === branch);

  // Only an EXACT branch match resolves. Falling back to "the whole pool" made
  // a branch with no pull request resolve to whatever single unrelated pull
  // request happened to be open — and Yama then posted its review onto it.
  // Candidates whose source branch is unknown are offered for a human to pick,
  // never chosen silently.
  if (exact.length === 1) {
    return { resolved: true, pullRequestId: exact[0].id };
  }

  if (exact.length === 0) {
    const unknowns = pool.filter((candidate) => !candidate.sourceBranch);
    return {
      resolved: false,
      reason:
        `No open pull request was found for branch "${branch}".` +
        (unknowns.length > 0
          ? ` ${unknowns.length} open pull request(s) did not report a source branch: ` +
            unknowns
              .map((c) => `#${c.id} (${c.title ?? "untitled"})`)
              .join(", ") +
            ". If one of these is it, re-run with --pr."
          : ""),
      candidates: unknowns,
    };
  }
  const matched = exact;

  return {
    resolved: false,
    reason:
      `Branch "${branch}" matches ${matched.length} open pull requests. ` +
      `Re-run with --pr and the one you mean: ` +
      matched
        .map(
          (candidate) => `#${candidate.id} (${candidate.title ?? "untitled"})`,
        )
        .join(", "),
    candidates: matched,
  };
}
