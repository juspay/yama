/**
 * Types for the pipeline layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ChangeSet } from "./changes.js";
import type { CheckRunResult } from "./checks.js";
import type { ResolvedConfig, StageName } from "./config.js";
import type { ExistingComment, PostedFinding, Verdict } from "./findings.js";
import type { PostingContext } from "./posting.js";
import type { RecallEntry } from "./recall.js";
import type { ReviewRunOutcome, TurnReport } from "./review.js";
import type { RunContext } from "./run.js";
import type { RunMetrics } from "./scorecard.js";
import type { StageMachineResult } from "./stages.js";
import type { FindingLedger } from "../findings/Ledger.js";

export type PipelineDependencies = {
  config: ResolvedConfig;
  context: RunContext;
  ledger: FindingLedger;
  comments: ExistingComment[];
  /** Recall entries, for the supervisor's rule re-injection. */
  entries: RecallEntry[];
  posting: PostingContext;
  approvals?: string[];

  /** Send a message to the agent's session and report what the turn did. */
  turn(message: string, stage: StageName): Promise<TurnReport>;

  /** Build the change set from the local checkout. */
  buildChangeSet(): Promise<ChangeSet>;

  /** Run configured checks. Code, never the model. */
  runChecks(changeSet: ChangeSet): Promise<CheckRunResult[]>;

  /** Re-read comments before writing, for idempotency. */
  readComments(): Promise<ExistingComment[]>;
  /**
   * The pull request's description as it stands right now.
   *
   * S5's exit predicate reads it rather than believing the agent said it wrote
   * one. Absent means the capability is not mapped, which degrades the
   * predicate to the agent's own claim and says so.
   */
  readDescription?: () => Promise<string | undefined>;
  /** The description before the run, so S5 can prove it actually changed. */
  baselineDescription?: string;
  /** What to tell the agent when asking it to write the description (S5). */
  descriptionInstruction?: string;
  /**
   * Gate and post the findings the project's own checks produced.
   *
   * Architecture §10: check results serve two purposes — they are evidence the
   * agent reads, and they are findings in their own right. Without this the
   * second half never happened: a linter error was visible to the reviewer and
   * invisible to the author.
   */
  publishCheckFindings?: (
    results: CheckRunResult[],
  ) => Promise<{ posted: number; rejected: number }>;
};

export type PipelineResult = {
  stages: StageMachineResult;
  verdict: Verdict;
  changeSet?: ChangeSet;
  checks: CheckRunResult[];
  review: ReviewRunOutcome;
  summaryPosted: boolean;
  statusRecorded: boolean;
  /**
   * How this run scored itself. Self-reported, and labelled as such: it says
   * whether the run did what it set out to do, never whether what it found was
   * real. Only post-merge ground truth answers that.
   */
  metrics?: RunMetrics;
  /** Findings that reached the pull request, for the report and CI outputs. */
  posted?: PostedFinding[];
};
