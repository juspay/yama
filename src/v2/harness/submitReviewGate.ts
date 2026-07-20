/**
 * Pure gate logic for submit_review: deterministic dedup + critic-verdict
 * application. The agent proposes findings; only what passes this gate may be
 * posted to the pull request.
 */

import {
  CriticVerdict,
  SubmitReviewAccepted,
  SubmitReviewRejected,
  SubmitReviewResult,
  VerificationMode,
} from "../types/index.js";

export type GateInput = {
  /** Candidate findings, already normalized and id-stamped. */
  findings: SubmitReviewAccepted[];
  verdicts: CriticVerdict[];
  /** Open finding ids from previous runs (state) — already have comments. */
  previouslyReportedIds: ReadonlySet<string>;
  /** Ids accepted earlier in THIS run — already cleared for posting. */
  alreadyAcceptedIds: ReadonlySet<string>;
  /** Learned false-positive ids (knowledge base / dismissals). */
  suppressedIds?: ReadonlySet<string>;
  mode: VerificationMode;
  dryRun: boolean;
};

export function gateFindings(input: GateInput): SubmitReviewResult {
  const verdictById = new Map(input.verdicts.map((v) => [v.id, v]));
  const seenInBatch = new Set<string>();
  const accepted: SubmitReviewAccepted[] = [];
  const rejected: SubmitReviewRejected[] = [];

  for (const finding of input.findings) {
    if (seenInBatch.has(finding.id)) {
      rejected.push({
        finding,
        reason: "duplicate of another finding in this submission",
      });
      continue;
    }
    seenInBatch.add(finding.id);

    if (input.previouslyReportedIds.has(finding.id)) {
      rejected.push({
        finding,
        reason: `already reported in a previous run (id ${finding.id}) — a comment exists; do not post again`,
      });
      continue;
    }
    if (input.alreadyAcceptedIds.has(finding.id)) {
      rejected.push({
        finding,
        reason: "already accepted earlier in this run — do not post again",
      });
      continue;
    }
    if (input.suppressedIds?.has(finding.id)) {
      rejected.push({
        finding,
        reason:
          "matches a team-confirmed false positive (knowledge base) — suppressed",
      });
      continue;
    }

    const verdict = verdictById.get(finding.id);
    if (verdict?.verdict === "refuted") {
      rejected.push({
        finding,
        reason: `refuted by verification: ${verdict.reason || "no reason given"}`,
      });
      continue;
    }
    if (verdict?.verdict === "uncertain" && input.mode === "strict") {
      rejected.push({
        finding,
        reason: `insufficient evidence (strict verification): ${verdict.reason || ""}. Gather concrete file:line evidence and resubmit once if you still believe this is real.`,
      });
      continue;
    }
    accepted.push(finding);
  }

  const instruction = input.dryRun
    ? `${accepted.length} finding(s) accepted for the final verdict. DRY-RUN: do not post any comments. Include accepted findings in your final JSON verdict.`
    : `${accepted.length} finding(s) accepted. Post ONE inline comment per accepted finding (severity marker first), then include them in your final JSON verdict. Do NOT post anything for rejected findings — either improve the evidence and resubmit once, or drop them.`;

  return { accepted, rejected, instruction };
}
