/**
 * Types for the scorecard layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

export type RunMetrics = {
  /** Planned files actually examined. */
  coverage: number;
  filesPlanned: number;
  filesExamined: number;
  /** Posted comments per 100 changed lines. The noise number. */
  noisePer100Lines: number;
  findingsPosted: number;
  changedLines: number;
  /** Gate accepted ÷ submitted. Low means the agent proposes badly. */
  gateAcceptRate: number;
  /** Findings accepted but never posted. Should always be zero. */
  unposted: number;
  degradedStages: string[];
  durationMs: number;
  turns: number;
  delegations: number;
  tokensUsed?: number;
};

/** Ground truth, available only after a pull request merges. */
export type GroundTruth = {
  postedFindings: number;
  actedOn: number;
  dismissed: number;
  /** Problems humans found that Yama did not report. */
  missedByYama: number;
  /** Per-rule outcomes, for retiring noisy rules with evidence. */
  byRule: Array<{ ruleId: string; posted: number; actedOn: number }>;
};

export type QualityScore = {
  /** Of what Yama posted and humans judged, how much was real. */
  precision: number;
  /** Of everything real, how much Yama found. */
  recall: number;
  /** Harmonic mean. Reported only when both inputs exist. */
  f1?: number;
  /** Rules whose precision is low enough to justify retiring them. */
  noisyRules: Array<{ ruleId: string; precision: number; posted: number }>;
};

/** Health alerts, keyed to the failures this architecture was built to prevent. */
export type HealthAlert = {
  metric: string;
  severity: "warn" | "critical";
  message: string;
};
