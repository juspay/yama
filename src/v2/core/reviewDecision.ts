/**
 * Code-derived review decision — the deterministic safety layer over the AI's
 * own verdict.
 *
 * The AI reviewer reports a decision in its structured output (the `decision`
 * field alongside its findings). That self-reported verdict is treated as
 * ADVISORY: a PR that carries CRITICAL findings must never end up APPROVED, no
 * matter what the model reported — so a prompt-injected "approve" in a malicious
 * diff cannot clear real blocking issues (security finding M2). This module is
 * the pure, testable home of that rule.
 */

import {
  DecisionPolicy,
  IssuesBySeverity,
  ReviewDecision,
} from "../types/index.js";

/** How many MAJOR findings force a non-approval. Mirrors the documented
 *  "3+ MAJOR issues → blocks" blocking criterion. */
export const DEFAULT_MAJOR_BLOCK_THRESHOLD = 3;

/**
 * Reconcile the AI's advisory decision with the counted findings.
 *
 * - Any CRITICAL finding → BLOCKED (hard rule, overrides any AI approval).
 * - MAJOR findings at/above the threshold → BLOCKED, matching the documented
 *   "3+ MAJOR issues → blocks the PR" policy (README), regardless of the AI
 *   verdict.
 * - A partial review (policy.partial) may never yield APPROVED.
 * - Otherwise the AI's decision stands.
 *
 * Pure and deterministic: same inputs always yield the same decision.
 */
export function deriveDecision(
  aiDecision: ReviewDecision,
  issues: IssuesBySeverity,
  policy: DecisionPolicy = {},
): ReviewDecision {
  const majorThreshold =
    policy.majorBlockThreshold ?? DEFAULT_MAJOR_BLOCK_THRESHOLD;

  if (issues.critical > 0) {
    return "BLOCKED";
  }

  if (issues.major >= majorThreshold) {
    return "BLOCKED";
  }

  // A partial review (step cap, context cap, timeout, truncated output) has
  // not seen the whole change — it may block, but it may never approve.
  if (policy.partial && aiDecision === "APPROVED") {
    return "CHANGES_REQUESTED";
  }

  return aiDecision;
}
