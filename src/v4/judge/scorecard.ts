/**
 * The scorecard — how good was this review?
 *
 * Two kinds of number live here, and conflating them is the trap:
 *
 *  - **In-run metrics** are self-reported. Coverage, noise, cost. They say
 *    whether the run did what it set out to do. A review can score perfectly on
 *    all of them while finding nothing real.
 *  - **Post-merge metrics** are ground truth. Precision comes from what humans
 *    actually did with the comments, and recall from what they found that Yama
 *    missed. These are the only numbers that justify changing anything.
 *
 * Both are reported, labelled, and never averaged together.
 */

import type {
  FindingLedgerSnapshot,
  GroundTruth,
  HealthAlert,
  QualityScore,
  RunMetrics,
  StageOutcome,
} from "../types/index.js";

export function computeRunMetrics(input: {
  ledger: FindingLedgerSnapshot;
  stages: StageOutcome[];
  filesPlanned: number;
  filesExamined: number;
  changedLines: number;
  durationMs: number;
  turns: number;
  delegations: number;
  tokensUsed?: number;
}): RunMetrics {
  const submitted = input.ledger.submitted;
  return {
    // A run that planned nothing has not covered everything — it has covered
    // nothing. Reporting 100% there is exactly the false all-clear the rest of
    // this architecture exists to remove: the number would look perfect on the
    // run that reviewed least. Full coverage is only true when there was
    // genuinely nothing to review.
    coverage:
      input.filesPlanned === 0
        ? input.changedLines === 0
          ? 1
          : 0
        : input.filesExamined / input.filesPlanned,
    filesPlanned: input.filesPlanned,
    filesExamined: input.filesExamined,
    noisePer100Lines:
      input.changedLines === 0
        ? 0
        : (input.ledger.posted.length / input.changedLines) * 100,
    findingsPosted: input.ledger.posted.length,
    changedLines: input.changedLines,
    gateAcceptRate:
      submitted === 0 ? 0 : input.ledger.accepted.length / submitted,
    unposted: input.ledger.unposted.length,
    degradedStages: input.stages
      .filter(
        (stage) => stage.status === "degraded" || stage.status === "failed",
      )
      .map((stage) => stage.stage),
    durationMs: input.durationMs,
    turns: input.turns,
    delegations: input.delegations,
    tokensUsed: input.tokensUsed,
  };
}

/**
 * Thresholds for calling a rule noisy.
 *
 * Both matter: precision alone would condemn a rule that fired twice and was
 * dismissed twice, which is not enough evidence to retire anything.
 */
export const NOISY_RULE = { minPosted: 10, maxPrecision: 0.4 };

export function computeQuality(truth: GroundTruth): QualityScore {
  const judged = truth.actedOn + truth.dismissed;
  const precision = judged === 0 ? 0 : truth.actedOn / judged;

  const realProblems = truth.actedOn + truth.missedByYama;
  const recall = realProblems === 0 ? 0 : truth.actedOn / realProblems;

  const noisyRules = truth.byRule
    .filter((rule) => rule.posted >= NOISY_RULE.minPosted)
    .map((rule) => ({
      ruleId: rule.ruleId,
      precision: rule.posted === 0 ? 0 : rule.actedOn / rule.posted,
      posted: rule.posted,
    }))
    .filter((rule) => rule.precision < NOISY_RULE.maxPrecision);

  return {
    precision,
    recall,
    ...(judged > 0 && realProblems > 0
      ? {
          f1:
            precision + recall === 0
              ? 0
              : (2 * precision * recall) / (precision + recall),
        }
      : {}),
    noisyRules,
  };
}

export function checkHealth(metrics: RunMetrics): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  // This is the one that matters most. Findings computed and not posted is the
  // exact shape of a review that looks clean and is not.
  if (metrics.unposted > 0) {
    alerts.push({
      metric: "unposted",
      severity: "critical",
      message:
        `${metrics.unposted} finding(s) were accepted but never posted. The pull ` +
        `request shows fewer problems than the review found.`,
    });
  }

  if (metrics.coverage < 0.95) {
    alerts.push({
      metric: "coverage",
      severity: "warn",
      message:
        `Only ${Math.round(metrics.coverage * 100)}% of planned files were examined ` +
        `(${metrics.filesExamined}/${metrics.filesPlanned}).`,
    });
  }

  if (metrics.noisePer100Lines > 3) {
    alerts.push({
      metric: "noise",
      severity: "warn",
      message:
        `${metrics.noisePer100Lines.toFixed(1)} comments per 100 changed lines. ` +
        `Reviews this dense get ignored.`,
    });
  }

  if (metrics.degradedStages.length > 0) {
    alerts.push({
      metric: "stages",
      severity: "warn",
      message: `Stages did not complete: ${metrics.degradedStages.join(", ")}.`,
    });
  }

  return alerts;
}

/** Render the scorecard for the run report. */
export function renderScorecard(
  metrics: RunMetrics,
  quality?: QualityScore,
): string {
  const lines = ["## Review scorecard", "", "### This run", ""];

  lines.push(
    `- Coverage: ${Math.round(metrics.coverage * 100)}% (${metrics.filesExamined}/${metrics.filesPlanned} planned files)`,
    `- Findings posted: ${metrics.findingsPosted}`,
    `- Noise: ${metrics.noisePer100Lines.toFixed(1)} per 100 changed lines`,
    `- Gate accept rate: ${Math.round(metrics.gateAcceptRate * 100)}%`,
    `- Unposted findings: ${metrics.unposted}`,
    `- Turns: ${metrics.turns}, delegations: ${metrics.delegations}`,
    `- Duration: ${(metrics.durationMs / 1000).toFixed(1)}s`,
  );

  if (metrics.tokensUsed !== undefined) {
    lines.push(`- Tokens: ${metrics.tokensUsed.toLocaleString()}`);
  }

  if (quality) {
    lines.push(
      "",
      "### Measured against what humans did (ground truth)",
      "",
      `- Precision: ${Math.round(quality.precision * 100)}%`,
      `- Recall: ${Math.round(quality.recall * 100)}%`,
    );
    if (quality.f1 !== undefined) {
      lines.push(`- F1: ${Math.round(quality.f1 * 100)}%`);
    }
    if (quality.noisyRules.length > 0) {
      lines.push("", "Rules worth retiring:");
      for (const rule of quality.noisyRules) {
        lines.push(
          `- \`${rule.ruleId}\` — ${Math.round(rule.precision * 100)}% precision over ${rule.posted} findings`,
        );
      }
    }
  }

  const alerts = checkHealth(metrics);
  if (alerts.length > 0) {
    lines.push("", "### Alerts", "");
    for (const alert of alerts) {
      lines.push(`- **${alert.severity}** ${alert.metric}: ${alert.message}`);
    }
  }

  return lines.join("\n");
}
