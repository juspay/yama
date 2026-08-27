/**
 * Validators for everything the run store reads back (TASKS:Y2.3).
 *
 * These artifacts outlive the process that wrote them — CI uploads them, the next run
 * downloads them — so they are validated on the way in. Each schema carries a
 * `satisfies z.ZodType<…>` guard against the hand-written type it must match, which is what
 * keeps validator and type in step without a second copy of the shape.
 */
import { z } from "zod";
import { DELIVERY_ACTIONS } from "../config/schema.js";
import type {
  ConfigDegradation,
  Finding,
  FindingsLedger,
  RunDeliveryStats,
  RunGateStats,
  RunRecurrenceStats,
  RunReport,
  RunStageMetric,
  RunTarget,
  TaskItem,
  Verdict,
  WorkerReport,
} from "../types/index.js";
import { FindingSchema as StageFindingSchema } from "../stages/schema.js";

const Text = z.string();
const Line = z.string().min(1);

export const RunTargetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({ mode: z.literal("branch"), branch: Line, base: Line.optional() }),
  z.object({
    mode: z.literal("pr"),
    pr: z.number().int(),
    base: Line.optional(),
  }),
]) satisfies z.ZodType<RunTarget>;

export const StageSchema = z.enum([
  "warmup",
  "taskInsertion",
  "work",
  "collate",
  "delivery",
]);

/**
 * The finding contract is defined ONCE, where the model is held to it
 * (`src/stages/schema.ts`), and checked here against the hand-written type: what a stage
 * may produce and what the ledger may keep are the same shape by construction.
 */
export const FindingSchema = StageFindingSchema satisfies z.ZodType<Finding>;

export const TaskItemSchema = z.object({
  id: Line,
  title: Text,
  status: z.enum(["pending", "in_progress", "done", "closed"]),
  note: Text.optional(),
}) satisfies z.ZodType<TaskItem>;

export const VerdictSchema = z.object({
  decision: z.enum(["approve", "block", "comment"]),
  reasons: z.array(Text),
}) satisfies z.ZodType<Verdict>;

export const DegradationSchema = z.object({
  what: Text,
  reason: Text,
}) satisfies z.ZodType<ConfigDegradation>;

export const RunStageMetricSchema = z.object({
  stage: StageSchema,
  startedAt: Text,
  durationMs: z.number(),
  trusted: z.boolean(),
  truncated: z.boolean(),
  provider: Text.optional(),
  model: Text.optional(),
  stepsUsed: z.number().optional(),
  toolsUsed: z.array(Text).optional(),
  envelopePath: Text,
  rawPath: Text,
}) satisfies z.ZodType<RunStageMetric>;

export const WorkerReportSchema = z.object({
  workerId: Line,
  taskId: Text,
  status: z.enum(["completed", "failed", "cut_short"]),
  summary: Text,
  reportPath: Text,
  findings: z.array(FindingSchema),
  error: Text.optional(),
}) satisfies z.ZodType<WorkerReport>;

export const FindingsLedgerSchema = z.object({
  updatedAt: Text,
  findings: z.array(FindingSchema),
}) satisfies z.ZodType<FindingsLedger>;

export const RunGateStatsSchema = z.object({
  untrustedStages: z.number().int().min(0),
  checklistComplete: z.boolean(),
  checklistPending: z.number().int().min(0),
  checklistUnexplained: z.number().int().min(0),
  workRounds: z.number().int().min(0),
  workersCollected: z.number().int().min(0),
  findingsReported: z.number().int().min(0),
  findingsAfterDedupe: z.number().int().min(0),
}) satisfies z.ZodType<RunGateStats>;

/**
 * Every field, deliberately. A zod object STRIPS what it does not declare, so a field
 * missing here is a field the next run silently loses on read-back — which is exactly the
 * information a recurring run needs (TASKS:Y7.1).
 */
export const RunDeliveryStatsSchema = z.object({
  actions: z.array(z.enum(DELIVERY_ACTIONS)),
  intended: z.number().int().min(0),
  posted: z.number().int().min(0),
  unposted: z.array(Text),
  alreadyPosted: z.number().int().min(0).optional(),
  stale: z.array(Text).optional(),
  summaryPosted: z.boolean().optional(),
  verdictSet: z.boolean().optional(),
  described: z.boolean().optional(),
  skipped: Text.optional(),
  failure: Text.optional(),
}) satisfies z.ZodType<RunDeliveryStats>;

export const RunRecurrenceStatsSchema = z.object({
  kind: z.enum(["fresh", "recurring"]),
  source: z.enum(["run-report", "markers", "none"]),
  lastReviewedSha: Text.optional(),
  lastReviewedAt: Text.optional(),
  priorOpen: z.number().int().min(0),
  fixed: z.array(Text),
  moot: z.array(Text),
  stillOpen: z.array(Text),
  unresolved: z.array(Text),
  previouslyReported: z.number().int().min(0),
  incrementalFiles: z.number().int().min(0).optional(),
  markerProblem: Text.optional(),
}) satisfies z.ZodType<RunRecurrenceStats>;

export const RunReportSchema = z.object({
  runId: Line,
  mode: z.enum(["local", "branch", "pr"]),
  target: RunTargetSchema,
  startedAt: Text,
  finishedAt: Text.optional(),
  headSha: Text.optional(),
  stages: z.array(RunStageMetricSchema),
  tasks: z.array(TaskItemSchema),
  degradations: z.array(DegradationSchema),
  gates: RunGateStatsSchema.optional(),
  recurrence: RunRecurrenceStatsSchema.optional(),
  delivery: RunDeliveryStatsSchema.optional(),
  verdict: VerdictSchema.optional(),
  error: Text.optional(),
}) satisfies z.ZodType<RunReport>;

/**
 * A stage envelope, payload deliberately unvalidated here: each stage owns its own schema
 * (`src/stages/schema.ts`), and `readStage` applies it on top of this.
 */
export const StageEnvelopeSchema = z.object({
  stage: StageSchema,
  data: z.unknown(),
  path: Text.optional(),
  trusted: z.boolean().optional(),
  truncated: z.boolean().optional(),
  completedAt: Text,
});
