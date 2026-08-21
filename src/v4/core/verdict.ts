/**
 * The verdict — derived from what actually landed, never from what a model said.
 *
 * Two properties this must hold, both learned the hard way:
 *
 *  1. **It reads gate-accepted findings, not claimed ones.** A finding the
 *     agent described in prose but never submitted cannot block; one the gate
 *     accepted blocks even when its comment failed to post, because posting is
 *     visibility, not truth. Unposted blockers are called out in the summary.
 *  2. **A partial run may never approve.** If any stage ended degraded, the
 *     review did not see everything it set out to see. It may still block —
 *     what it did find is real — but "APPROVED" would be a claim it has not
 *     earned.
 *
 * Pure and total.
 */

import type {
  DeriveVerdictOptions,
  FindingSeverity,
  ReviewDecision,
  Verdict,
  VerdictInput,
} from "../types/index.js";

const countBySeverity = (
  findings: Array<{ severity: FindingSeverity }>,
): Record<FindingSeverity, number> => {
  const counts: Record<FindingSeverity, number> = {
    CRITICAL: 0,
    MAJOR: 0,
    MINOR: 0,
    SUGGESTION: 0,
  };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
};

/**
 * Derive the decision.
 *
 * `blockOn` lets a project decide what blocks. Removing a reason from that list
 * does not hide the finding — it still gets posted and still appears in the
 * summary — it only stops it from failing the build. That separation matters:
 * teams adopting Yama usually want to see everything long before they want it
 * gating merges.
 */
export function deriveVerdict(
  input: VerdictInput,
  options: DeriveVerdictOptions,
): Verdict {
  const { config } = options;
  const reasons: string[] = [];
  const blockOn = new Set(config.blockOn);
  // Accepted, not posted: what the gate let through is what the review FOUND.
  // Posting is how a finding becomes visible, not what makes it real — a
  // CRITICAL whose comment failed to post still blocks, and a dry run still
  // reaches an honest decision.
  const counts = countBySeverity(input.accepted);

  let decision: ReviewDecision = "APPROVED";
  const block = (reason: string): void => {
    decision = "BLOCKED";
    reasons.push(reason);
  };

  if (counts.CRITICAL > 0 && blockOn.has("CRITICAL")) {
    block(
      `${counts.CRITICAL} critical finding(s) — a change that ships a critical defect ` +
        `cannot be approved.`,
    );
  }

  if (blockOn.has("MAJOR_THRESHOLD") && counts.MAJOR >= config.majorThreshold) {
    block(
      `${counts.MAJOR} major finding(s), at or above the threshold of ${config.majorThreshold}.`,
    );
  }

  if (blockOn.has("blocking-rule") && input.blockingRuleIds.length > 0) {
    block(`Blocking rule(s) violated: ${input.blockingRuleIds.join(", ")}.`);
  }

  if (
    blockOn.has("blocking-check") &&
    input.failedBlockingCheckIds.length > 0
  ) {
    block(
      `Blocking check(s) failed: ${input.failedBlockingCheckIds.join(", ")}.`,
    );
  }

  if (
    blockOn.has("unapproved-ownership") &&
    input.unapprovedOwnershipRuleIds.length > 0
  ) {
    block(
      `Ownership approval outstanding for: ${input.unapprovedOwnershipRuleIds.join(", ")}.`,
    );
  }

  // Findings that were posted but do not meet a blocking bar still mean the
  // change is not clean. Saying APPROVED over visible comments reads as the
  // review contradicting itself.
  if (decision === "APPROVED" && input.posted.length > 0) {
    decision = "CHANGES_REQUESTED";
    reasons.push(
      `${input.posted.length} finding(s) posted — none blocking, but the change is not clean.`,
    );
  }

  // A partial run may block on what it saw. It may not approve what it did not.
  if (input.partial && decision === "APPROVED") {
    decision = "CHANGES_REQUESTED";
    reasons.push(
      "The review did not complete every stage, so it cannot vouch for the whole change.",
    );
  }

  if (reasons.length === 0) {
    reasons.push("No findings, and every configured gate passed.");
  }

  return { decision, reasons, advisory: !config.enabled };
}

/** One-line summary for CI output and logs. */
export function describeVerdict(verdict: Verdict): string {
  const prefix = verdict.advisory ? "(advisory) " : "";
  return `${prefix}${verdict.decision}: ${verdict.reasons[0]}`;
}
