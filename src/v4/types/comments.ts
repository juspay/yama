/**
 * Types for the comments layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { IdentifiedFinding, PostedFinding, Verdict } from "./findings.js";
import type { ImpactReport } from "./product.js";

export type SummaryInput = {
  verdict: Verdict;
  posted: PostedFinding[];
  /** Accepted but not confirmed posted. Reported so silence is never implied. */
  unposted: IdentifiedFinding[];
  checks: Array<{
    checkId: string;
    status: string;
    findings: number;
    dropped: number;
  }>;
  /** Files reviewed vs excluded, so scope is visible. */
  filesReviewed: number;
  filesExcluded: number;
  truncated: boolean;
  /** Stages that ended degraded. */
  degradedStages: string[];
  /** Findings the project's own checks contributed, and that reached the PR. */
  checkFindingsPosted?: number;
  /**
   * What this change does to the product, derived from the capability map and
   * the impact ledger.
   *
   * Absent when the repository has no map or the change touches nothing in it —
   * the documented degraded state, not an error.
   */
  impactReport?: ImpactReport;
  /** Product-impact narrative, when the impact specialist produced one. */
  impact?: string;
};
