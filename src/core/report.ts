/**
 * The run report (TASKS:Y8.3) — what ran, what it cost, what the gates saw, what it decided.
 *
 * It is written before the first stage and rewritten after every one, so a run that dies in
 * the middle still leaves a store a human can read. Everything in it is observed by code:
 * stage durations and JSON health come from the session, gate numbers from the gates, and
 * the delivery block says plainly what was posted and what was not (TASKS:Y4.4).
 */
import type {
  ConfigDegradation,
  DeliveryStageResult,
  GitDiff,
  PriorFindingsGateResult,
  RecurrenceState,
  RunContext,
  RunDeliveryStats,
  RunGateStats,
  RunRecurrenceStats,
  RunReport,
  RunStageMetric,
  WorkStageResult,
} from "../types/index.js";

/** A fresh report for a run that has not run a stage yet. */
export const startRunReport = (input: {
  run: RunContext;
  degradations: ConfigDegradation[];
  headSha?: string;
}): RunReport => ({
  runId: input.run.runId,
  mode: input.run.target.mode,
  target: input.run.target,
  startedAt: new Date().toISOString(),
  ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
  stages: [],
  tasks: [],
  degradations: input.degradations,
});

/** What the gates saw, read off the stage metrics and the work stage's own result. */
export const gateStats = (input: {
  metrics: readonly RunStageMetric[];
  work: WorkStageResult;
  findingsAfterDedupe: number;
}): RunGateStats => ({
  untrustedStages: input.metrics.filter((metric) => !metric.trusted).length,
  checklistComplete: input.work.checklist.complete,
  checklistPending: input.work.checklist.pending.length,
  checklistUnexplained: input.work.checklist.unexplained.length,
  workRounds: input.work.rounds,
  workersCollected: input.work.workers.length,
  findingsReported: input.work.findings.length,
  findingsAfterDedupe: input.findingsAfterDedupe,
});

/**
 * Delivery, as it actually went (TASKS:Y3.5, Y4.4).
 *
 * Every number here is read off a tool RESULT, never off the agent's report: "we meant to"
 * is not the same as "it is on the pull request". A run that delivered nothing says why.
 */
export const deliveryStats = (
  delivery: DeliveryStageResult,
  options: { verdictProofRequired?: boolean } = {},
): RunDeliveryStats => ({
  ...(options.verdictProofRequired !== undefined
    ? { verdictProofRequired: options.verdictProofRequired }
    : {}),
  actions: [...delivery.plan.actions],
  intended: delivery.plan.comments.length,
  posted: delivery.confirmation.posted.length,
  unposted: [...delivery.confirmation.unposted],
  ...(delivery.summaryOnly !== undefined && delivery.summaryOnly.length > 0
    ? { summaryOnly: [...delivery.summaryOnly] }
    : {}),
  alreadyPosted: delivery.plan.alreadyPosted.length,
  stale: [...delivery.plan.stale],
  summaryPosted: delivery.summaryPosted,
  verdictSet: delivery.verdictSet,
  described: delivery.described,
  ...(delivery.skipped !== undefined ? { skipped: delivery.skipped } : {}),
  ...(delivery.failure !== undefined ? { failure: delivery.failure } : {}),
});

/**
 * What this run inherited from the one before it (TASKS:Y7.1).
 *
 * Written for every run, fresh ones included: "0 carried over" and "recurrence was never
 * looked at" are different facts, and only one of them is fine.
 */
export const recurrenceStats = (input: {
  recurrence: RecurrenceState;
  prior: PriorFindingsGateResult;
  incremental?: GitDiff;
}): RunRecurrenceStats => ({
  kind: input.recurrence.kind,
  source: input.recurrence.source,
  ...(input.recurrence.lastReviewedSha !== undefined
    ? { lastReviewedSha: input.recurrence.lastReviewedSha }
    : {}),
  ...(input.recurrence.lastReviewedAt !== undefined
    ? { lastReviewedAt: input.recurrence.lastReviewedAt }
    : {}),
  priorOpen: input.recurrence.priorFindings.length,
  fixed: [...input.prior.fixed],
  moot: [...input.prior.moot],
  stillOpen: input.prior.open.map((finding) => finding.id),
  unresolved: [...input.prior.unresolved],
  previouslyReported: input.recurrence.previouslyReported.length,
  ...(input.incremental !== undefined
    ? { incrementalFiles: input.incremental.files.length }
    : {}),
  ...(input.recurrence.markerProblem !== undefined
    ? { markerProblem: input.recurrence.markerProblem }
    : {}),
});

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

const stageLine = (metric: RunStageMetric): string =>
  [
    `  ${metric.stage.padEnd(14)}`,
    seconds(metric.durationMs).padStart(7),
    `  ${metric.trusted ? "trusted  " : "UNTRUSTED"}`,
    metric.stepsUsed !== undefined ? `  steps ${metric.stepsUsed}` : "",
    metric.toolsUsed !== undefined && metric.toolsUsed.length > 0
      ? `  tools ${metric.toolsUsed.join(", ")}`
      : "",
  ].join("");

const gateLines = (gates: RunGateStats): string[] => [
  `  checklist  ${gates.checklistComplete ? "complete" : "INCOMPLETE"} — ${gates.checklistPending} pending, ${gates.checklistUnexplained} closed without a reason`,
  `  work       ${gates.workRounds} agent round(s), ${gates.workersCollected} worker report(s) collected`,
  `  findings   ${gates.findingsReported} reported → ${gates.findingsAfterDedupe} after dedupe`,
  `  stages     ${gates.untrustedStages} of the stage outputs came back untrusted`,
];

const recurrenceLines = (recurrence: RunRecurrenceStats): string[] => [
  `  seen before ${recurrence.kind === "recurring" ? `yes, via ${recurrence.source}${recurrence.lastReviewedSha ? ` at ${recurrence.lastReviewedSha.slice(0, 12)}` : ""}` : "no — first review of this target"}`,
  ...(recurrence.priorOpen > 0
    ? [
        `  prior      ${recurrence.priorOpen} open → ${recurrence.fixed.length} fixed, ${recurrence.moot.length} no longer touched, ${recurrence.stillOpen.length} still open`,
      ]
    : []),
  ...(recurrence.unresolved.length > 0
    ? [
        `  UNRESOLVED ${recurrence.unresolved.length} prior finding(s) were never accounted for and are carried as open: ${recurrence.unresolved.join(", ")}`,
      ]
    : []),
  ...(recurrence.previouslyReported > 0
    ? [
        `  commented  ${recurrence.previouslyReported} finding(s) were already on the target when this run started`,
      ]
    : []),
  ...(recurrence.incrementalFiles !== undefined
    ? [
        `  since      ${recurrence.incrementalFiles} file(s) moved since the previous review`,
      ]
    : []),
  ...(recurrence.markerProblem !== undefined
    ? [`  markers    ${recurrence.markerProblem}`]
    : []),
];

const deliveryLines = (delivery: RunDeliveryStats): string[] => [
  `  actions    ${delivery.actions.length > 0 ? delivery.actions.join(", ") : "(none)"}`,
  `  posted     ${delivery.posted} of ${delivery.intended} intended${delivery.unposted.length > 0 ? ` — unposted: ${delivery.unposted.join(", ")}` : ""}`,
  ...(delivery.alreadyPosted !== undefined && delivery.alreadyPosted > 0
    ? [
        `  deduped    ${delivery.alreadyPosted} already on the target from an earlier run`,
      ]
    : []),
  ...(delivery.summaryPosted === true ? ["  summary    posted"] : []),
  ...(delivery.verdictSet === true ? ["  verdict    set on the platform"] : []),
  ...(delivery.described === true ? ["  describe   updated"] : []),
  ...(delivery.skipped !== undefined
    ? [`  skipped    ${delivery.skipped}`]
    : []),
  ...(delivery.failure !== undefined
    ? delivery.failure.split("\n").map((line) => `  FAILED     ${line}`)
    : []),
];

/** The run report as a human reads it. One screen, no colour, nothing elided. */
export const renderRunSummary = (
  report: RunReport,
  storeDir?: string,
): string => {
  const total = report.stages.reduce(
    (sum, metric) => sum + metric.durationMs,
    0,
  );
  const lines: string[] = [
    `yama ${report.runId} · ${report.mode} · ${seconds(total)} in ${report.stages.length} stage(s)`,
    "",
    "stages",
    ...(report.stages.length > 0
      ? report.stages.map(stageLine)
      : ["  (none ran)"]),
  ];

  if (report.gates !== undefined) {
    lines.push("", "gates", ...gateLines(report.gates));
  }
  if (report.recurrence !== undefined) {
    lines.push("", "recurrence", ...recurrenceLines(report.recurrence));
  }
  if (report.delivery !== undefined) {
    lines.push("", "delivery", ...deliveryLines(report.delivery));
  }
  if (report.degradations.length > 0) {
    lines.push(
      "",
      "switched off for this run",
      ...report.degradations.map(
        (degradation) => `  ${degradation.what} — ${degradation.reason}`,
      ),
    );
  }
  if (report.verdict !== undefined) {
    lines.push(
      "",
      `verdict  ${report.verdict.decision.toUpperCase()}`,
      ...report.verdict.reasons.map((reason) => `  ${reason}`),
    );
  }
  if (report.error !== undefined) {
    lines.push("", `the run stopped early: ${report.error}`);
  }
  if (storeDir !== undefined) {
    lines.push("", `everything above is banked in ${storeDir}`);
  }
  return lines.join("\n");
};
