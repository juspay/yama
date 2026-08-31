/**
 * Run-store shapes (TASKS:Y2.3). One directory per run under `.yama/artifacts/`, holding
 * every stage envelope, every banked payload, the findings ledger and the run report.
 *
 * An absent store is never an error — the run rebuilds it. What the store must never do is
 * lose content: full payloads go to files, and only bounded previews travel in conversation.
 */
import type { ConfigDegradation, DeliveryAction } from "./config.js";
import type { Finding, TaskItem, Verdict } from "./findings.js";
import type { RunMode, RunTarget, Stage } from "./run.js";
import type { RecurrenceSource } from "./stages.js";

/** Absolute locations inside one run's store directory. */
export type RunStorePaths = {
  /** `<root>/.yama/artifacts/<slug>` */
  dir: string;
  /** Per-stage structured envelopes, one JSON file per stage. */
  stagesDir: string;
  /** Banked payloads: worker reports, stage transcripts, diffs. */
  reportsDir: string;
  /** Background-command stdout/stderr streams. */
  checksDir: string;
  /** Worker report records, one JSON file per worker. */
  workersDir: string;
  /** The findings ledger. */
  ledgerFile: string;
  /** The per-run report. */
  runFile: string;
};

/** What one stage checkpoint cost and how far it can be trusted (TASKS:Y4.1). */
export type RunStageMetric = {
  stage: Stage;
  startedAt: string;
  durationMs: number;
  /** Complete, unrepaired, schema-valid JSON. Anything else needs the schema gate. */
  trusted: boolean;
  /** The engine salvaged a partial JSON body. */
  truncated: boolean;
  provider?: string;
  model?: string;
  stepsUsed?: number;
  toolsUsed?: string[];
  /** Where the structured envelope was banked. */
  envelopePath: string;
  /** Where the verbatim model output was banked. */
  rawPath: string;
};

/** Findings accumulated by a run, in the order they were added. Dedup happens later. */
export type FindingsLedger = {
  updatedAt: string;
  findings: Finding[];
};

/**
 * What the deterministic gates saw (TASKS:Y8.3). Every number here is observed by code,
 * never reported by the model — that is the point of writing them down.
 */
export type RunGateStats = {
  /** Stage envelopes whose JSON was repaired or salvaged (TASKS:Y4.1). */
  untrustedStages: number;
  /** No item left pending, and no item closed without a reason (TASKS:Y4.2). */
  checklistComplete: boolean;
  checklistPending: number;
  checklistUnexplained: number;
  /** Agent turns the work stage spent, the first one included. */
  workRounds: number;
  /** Worker reports the shell collected and banked. */
  workersCollected: number;
  /** Findings as reported by the work stage, before the collate stage deduped them. */
  findingsReported: number;
  findingsAfterDedupe: number;
};

/**
 * What reached the platform. Posting is confirmed by comment id, never assumed
 * (TASKS:Y4.4) — until Delivery lands (TASKS:Y3.5) `posted` is 0 and `skipped` says why.
 */
/** Whether this repository CONFIGURED verdict delivery — the CLI's exit contract
 * depends on intent, not on what survived the capability probe: a BLOCK in a repo that
 * promised review-state delivery must be proven there, even when delivery was skipped
 * because every capability degraded. */
export type RunDeliveryStats = {
  /** Actions this run could actually perform: config x capability x target mode. */
  actions: DeliveryAction[];
  /** Findings the run would post, after the delivery severity floor. */
  intended: number;
  /** Confirmed by a comment id carrying the finding's marker. */
  posted: number;
  /** Intended but unconfirmed — the run says these out loud. */
  unposted: string[];
  /** Inline post never anchored; the posted summary carries the finding instead. */
  summaryOnly?: string[];
  /** Already on the target from an earlier run, so this one did not post them again. */
  alreadyPosted?: number;
  /** Markers on the target this run did not find again — Y7.1 classifies them. */
  stale?: string[];
  /** The summary comment landed and carries this run's marker. */
  summaryPosted?: boolean;
  /** The platform's own review state was set. */
  verdictSet?: boolean;
  /** True when yama.yaml configured `delivery.verdict` — see the type's doc note. */
  verdictProofRequired?: boolean;
  /** The description-enhancement hook ran (TASKS:Y7.3). */
  described?: boolean;
  /** Why nothing was delivered, when nothing was. */
  skipped?: string;
  /** The loud message when delivery did not land as intended (TASKS:Y4.4). */
  failure?: string;
};

/**
 * What a recurring run made of the review before it (TASKS:Y7.1). Present on every run:
 * a fresh one reports `fresh` with zeroes, which is how a reader tells "nothing carried
 * over" from "recurrence was never checked".
 */
export type RunRecurrenceStats = {
  kind: "fresh" | "recurring";
  source: RecurrenceSource;
  /** Head sha the previous run reviewed — the left-hand side of the incremental diff. */
  lastReviewedSha?: string;
  lastReviewedAt?: string;
  /** Findings the previous run left open. */
  priorOpen: number;
  /** Of those: shown fixed, no longer touched by the change, still open. */
  fixed: string[];
  moot: string[];
  stillOpen: string[];
  /** Prior findings the agent never accounted for. Carried as open, named here. */
  unresolved: string[];
  /** Findings already commented on the target when this run started (marker preflight). */
  previouslyReported: number;
  /** Whether an incremental patch was available, and how much of the change it was. */
  incrementalFiles?: number;
  /** Why the preflight marker scan read nothing, when it read nothing. */
  markerProblem?: string;
};

/** The per-run report: what ran, what it cost, and what it decided (TASKS:Y8.3). */
export type RunReport = {
  runId: string;
  mode: RunMode;
  target: RunTarget;
  startedAt: string;
  finishedAt?: string;
  /** Head commit this run reviewed. A later run compares against it (TASKS:Y7.1). */
  headSha?: string;
  stages: RunStageMetric[];
  /** Paths `review.exclude` kept out of this run's diff. Present only when some were. */
  excludedFiles?: string[];
  /** Checklist as it stood when the run ended — a closed item is a documented gap. */
  tasks: TaskItem[];
  /** Capabilities that were off, carried through so a reader knows what was not looked at. */
  degradations: ConfigDegradation[];
  /** What the gates between the stages observed. */
  gates?: RunGateStats;
  /** What this run inherited from the review before it (TASKS:Y7.1). */
  recurrence?: RunRecurrenceStats;
  /** What was delivered to the platform, and what was not. */
  delivery?: RunDeliveryStats;
  verdict?: Verdict;
  /** Set when the run stopped early; the stages above still happened. */
  error?: string;
};
