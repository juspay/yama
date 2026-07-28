/**
 * Verdict reconciliation — anchors the final review verdict to what the
 * submit_review gate actually verified.
 *
 * The model's structured verdict lists issues, but only findings the gate
 * accepted (deduped + critic-verified) are trustworthy. This became load-
 * bearing the day a partial review's tools-off verdict recovery fabricated a
 * plausible issues list out of the rules prompt and BLOCKED a PR on findings
 * that matched nothing the agent had investigated. Pure and deterministic.
 */

import { LocalReviewFinding } from "../types/index.js";

export type ReconcileVerdictInput = {
  /** Gate-accepted findings, already normalized to LocalReviewFinding. */
  gatedFindings: LocalReviewFinding[];
  /** Issues from the model's structured verdict, already normalized. */
  verdictIssues: LocalReviewFinding[];
};

export type ReconcileVerdictOutput = {
  /**
   * The decision-driving findings: every gate-accepted finding, enriched with
   * the matching verdict issue's richer prose where one exists.
   */
  issues: LocalReviewFinding[];
  /** Verdict issues that matched no gate-accepted finding (advisory only). */
  ungatedIssues: LocalReviewFinding[];
};

const normalize = (value: string | undefined): string =>
  (value || "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Match a gated finding to the verdict issue describing the same problem.
 * Deterministic, tolerant of rephrasing: same file + same title, or same
 * file + same line + same severity. A finding without a filePath never
 * matches — two location-less findings must not glue together on prose
 * alone. (Ids can't be compared directly — the verdict issue ids are
 * model-invented, the gate ids are content hashes.)
 */
function matches(
  gated: LocalReviewFinding,
  issue: LocalReviewFinding,
): boolean {
  const gatedFile = normalize(gated.filePath);
  const sameFile =
    gatedFile.length > 0 && gatedFile === normalize(issue.filePath);
  if (!sameFile) {
    return false;
  }
  if (normalize(gated.title) === normalize(issue.title)) {
    return true;
  }
  return (
    gated.line !== undefined &&
    gated.line === issue.line &&
    gated.severity === issue.severity
  );
}

/**
 * Split the model's verdict issues against the gate's accepted findings.
 *
 * Every gate-accepted finding survives (enriched with the matching verdict
 * issue's richer description/suggestion where one exists); verdict issues
 * matching no accepted finding come back as `ungatedIssues` — unverified
 * claims the caller must treat as advisory only. Each verdict issue is
 * claimed by at most one gated finding. Pure and deterministic.
 */
export function reconcileVerdictWithGate(
  input: ReconcileVerdictInput,
): ReconcileVerdictOutput {
  const claimed = new Set<number>();
  const issues: LocalReviewFinding[] = input.gatedFindings.map((gated) => {
    const matchIndex = input.verdictIssues.findIndex(
      (issue, index) => !claimed.has(index) && matches(gated, issue),
    );
    if (matchIndex === -1) {
      return gated;
    }
    claimed.add(matchIndex);
    const matched = input.verdictIssues[matchIndex];
    // The gate finding is authoritative (severity was critic-verified); the
    // verdict issue may carry richer prose written after further analysis.
    return {
      ...gated,
      description:
        (matched.description?.length || 0) > (gated.description?.length || 0)
          ? matched.description
          : gated.description,
      suggestion: gated.suggestion || matched.suggestion,
    };
  });

  const ungatedIssues = input.verdictIssues.filter(
    (_, index) => !claimed.has(index),
  );

  return { issues, ungatedIssues };
}
