/**
 * Stage payloads (TASKS:Y3.1, Y3.2). Every model-facing shape is inferred from the zod
 * schema that validates it (`src/stages/schema.ts`), so schema and type cannot drift.
 */
import type { z } from "zod";
import type {
  BriefRuleSchema,
  CollationSchema,
  DeliveryReportSchema,
  InsertionPlanSchema,
  InsertionTaskSchema,
  MergedFindingSchema,
  OperatingBriefSchema,
  PriorFindingReviewSchema,
  PriorFindingStateSchema,
  WorkOutcomeSchema,
  WorkedTaskSchema,
} from "../stages/schema.js";
import type { DeliveryAction } from "./config.js";
import type {
  ChecklistGateResult,
  PostedComment,
  PostingConfirmation,
  PriorFindingsGateResult,
} from "./gates.js";
import type {
  Finding,
  RankedFindings,
  Severity,
  StageOutput,
  Verdict,
  WorkerReport,
} from "./findings.js";
import type { Stage } from "./run.js";
import type { EngineBankedRef } from "./engine.js";
import type { GitDiff } from "./tools.js";

/** One rule distilled out of the rulebook, with the file it came from. */
export type BriefRule = z.infer<typeof BriefRuleSchema>;

/** WarmUp's output: how this repository wants to be reviewed (PLAN.md section 1). */
export type OperatingBrief = z.infer<typeof OperatingBriefSchema>;

/** One review pointer the agent committed to. */
export type InsertionTask = z.infer<typeof InsertionTaskSchema>;

/** Task Insertion's output: the reading of the change plus the checklist it produced. */
export type InsertionPlan = z.infer<typeof InsertionPlanSchema>;

/**
 * Everything Task Insertion produced (TASKS:Y3.2, Y7.1). The diff is banked whole; the
 * incremental one is present only when a previous run left a sha to measure from, and it
 * is additional context, never a replacement — the checklist is written against the WHOLE
 * change, because that is what is being merged.
 */
export type InsertionStageResult = {
  plan: StageOutput<Stage, InsertionPlan>;
  diff: GitDiff;
  /** Paths `review.exclude` dropped from the diff — reported, never silently discarded. */
  excluded?: string[];
  banked: EngineBankedRef;
  /** `lastReviewedSha..head`, banked separately. Absent for a fresh run. */
  incremental?: GitDiff;
  incrementalBanked?: EngineBankedRef;
  /** What became of each finding the previous review left open. */
  prior: PriorFindingsGateResult;
};

/**
 * Where the knowledge of a previous review came from (TASKS:Y7.1). The run store is a CI
 * artifact and can be lost; the markers on the target never are, so a run that finds no
 * store still recognises a re-review from what is already commented on the pull request.
 */
export type RecurrenceSource = "run-report" | "markers" | "none";

/**
 * Whether this run has seen this target before (TASKS:Y3.2 / Y7.1).
 *
 * Two independent sources, deliberately: the STORE carries what the last run found (the
 * findings themselves, and the sha it reviewed, which is what makes an incremental diff
 * possible), and the MARKERS carry what it actually said out loud on the target. Either
 * one alone makes a run recurring; neither is trusted to stand in for the other.
 */
export type RecurrenceState = {
  kind: "fresh" | "recurring";
  /** Where the answer came from: the run report, the markers on the target, or nothing. */
  source: RecurrenceSource;
  /** Head sha of the previous run — the left-hand side of the incremental diff. */
  lastReviewedSha?: string;
  /** ISO-8601 finish time of the previous run. */
  lastReviewedAt?: string;
  /** Findings the previous run left open, whole; a recurring run must classify each one. */
  priorFindings: Finding[];
  /** Their ids, in ledger order — what the prompt and the report name. */
  priorFindingIds: string[];
  /**
   * Findings already commented on the target, bound to the comment carrying the marker
   * (TASKS:Y4.3). Read before the first stage, so the review knows what it has already
   * said even when the store is gone.
   */
  previouslyReported: PostedComment[];
  /** Why the preflight marker scan read nothing, when it read nothing. */
  markerProblem?: string;
};

/** What became of a finding the previous review left open (TASKS:Y7.1). */
export type PriorFindingState = z.infer<typeof PriorFindingStateSchema>;

/** The agent's account of one prior finding: what became of it, and why it says so. */
export type PriorFindingReview = z.infer<typeof PriorFindingReviewSchema>;

/** What the agent did with one checklist item during the work stage (TASKS:Y3.3). */
export type WorkedTask = z.infer<typeof WorkedTaskSchema>;

/** One round of working the checklist: findings found, and what each item came to. */
export type WorkOutcome = z.infer<typeof WorkOutcomeSchema>;

/** A duplicate finding folded into the one that survived it (TASKS:Y3.4). */
export type MergedFinding = z.infer<typeof MergedFindingSchema>;

/** The collate stage's own output, before the policy turns it into a verdict. */
export type Collation = z.infer<typeof CollationSchema>;

/**
 * Everything the work stage produced (TASKS:Y3.3). The findings accumulate across rounds,
 * the worker records are what the shell drained and banked, and `checklist` is the
 * completeness gate's last word — an incomplete review is reported, never hidden.
 */
export type WorkStageResult = {
  /** Envelope of the last round; every round is banked as it happens. */
  output: StageOutput<Stage, WorkOutcome>;
  findings: Finding[];
  workers: WorkerReport[];
  checklist: ChecklistGateResult;
  /** Agent turns spent, the first one included. */
  rounds: number;
};

/** What the collate stage produced (TASKS:Y3.4): the ranked list and the policy's verdict. */
export type CollateStageResult = {
  output: StageOutput<Stage, Collation>;
  ranked: RankedFindings;
  /** Decided by `decideVerdict` from the config, never by the model. */
  verdict: Verdict;
};

/* ---------------------------------------------------------------- delivery */

/** One comment Delivery intends to post, already rendered and already marked. */
export type DeliveryComment = {
  findingId: string;
  file: string;
  line: number;
  severity: Severity;
  /** The body exactly as it must be posted, marker included (TASKS:Y5.3). */
  body: string;
};

/**
 * What Delivery is going to do, decided before the agent is asked to do any of it
 * (PLAN.md section 1). The agent executes this plan; it does not get to extend it.
 */
export type DeliveryPlan = {
  /** Config x capability x probe. Anything missing from here is a named degradation. */
  actions: DeliveryAction[];
  /** Findings with no marker on the target yet — the only ones that get posted. */
  comments: DeliveryComment[];
  /** Already on the target from an earlier run, bound to the comment carrying them. */
  alreadyPosted: PostedComment[];
  /** Markers this run did not find again (TASKS:Y7.1 classifies them). */
  stale: string[];
  /** The summary comment body, marker included; absent when that action is off. */
  summary?: string;
  verdict: Verdict;
  /** Findings held back by the severity floor or the per-run inline cap. */
  withheld: string[];
  /**
   * The whole pull-request description as it must be set (TASKS:Y7.3): the author's own
   * text untouched, with Yama's sections inside its marked block. Absent when the
   * `describe` action is off or the current description could not be read.
   */
  description?: string;
};

/** The agent's own account of Delivery. A claim — the shell confirms it separately. */
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;

/**
 * What Delivery actually achieved (TASKS:Y3.5, Y4.4). Every boolean here is read off a
 * tool RESULT, never off the agent's report: "we meant to" is not "it is on the PR".
 */
export type DeliveryStageResult = {
  output?: StageOutput<Stage, DeliveryReport>;
  plan: DeliveryPlan;
  confirmation: PostingConfirmation;
  /** Findings whose inline post never anchored, delivered by the posted summary instead. */
  summaryOnly?: string[];
  summaryPosted: boolean;
  verdictSet: boolean;
  described: boolean;
  /** The loud message when something intended did not land. */
  failure?: string;
  /** Why Delivery did nothing, when it did nothing. */
  skipped?: string;
};
