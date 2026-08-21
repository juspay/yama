import type { IdentifiedFinding } from "./findings.js";
/**
 * Types for the guards layer.
 */

export type GuardEvaluation = {
  findings: IdentifiedFinding[];
  /** Guard ids that were violated — feed the verdict. */
  violatedRuleIds: string[];
  /** Check ids a guard requires for the paths this PR touched. */
  requiredCheckIds: string[];
};
