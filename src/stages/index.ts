/**
 * The stage flow (PLAN.md section 1). Runtime exports only; stage payload shapes live in
 * `src/types/stages.ts`, inferred from the schemas in `./schema.ts`.
 */
import type { Stage } from "../types/index.js";

export {
  CollationSchema,
  DeliveryReportSchema,
  InsertionPlanSchema,
  LearnTriageSchema,
  MemoryFactSchema,
  OperatingBriefSchema,
  PriorFindingReviewSchema,
  WorkOutcomeSchema,
} from "./schema.js";
export { buildWarmUpPrompt, runWarmUp } from "./warmup.js";
export {
  acquireTargetDiff,
  excludeFromDiff,
  buildTaskInsertionPrompt,
  runTaskInsertion,
} from "./taskInsertion.js";
export {
  acquireIncrementalDiff,
  describePriorFinding,
  detectRecurrence,
  scanReportedFindings,
  withReportedMarkers,
} from "./recurrence.js";
export {
  WORK_TRAILING_PROMPT,
  buildWorkPrompt,
  renderCollectedWorkers,
  runWork,
} from "./work.js";
export { buildCollatePrompt, runCollate } from "./collate.js";
export {
  buildDeliveryPlan,
  buildDeliveryPrompt,
  confirmDelivery,
  readTargetDescription,
  renderFindingComment,
  renderSummaryComment,
  runDelivery,
} from "./delivery.js";
export {
  DESCRIPTION_END,
  DESCRIPTION_START,
  hasDescriptionBlock,
  mergeDescription,
  renderDescriptionBlock,
} from "./describe.js";

/**
 * Stage order for one run. Delivery is deliberately last and config-driven — the agent
 * cannot plan it away or invent extra delivery work (PLAN.md section 1).
 */
export const STAGES: readonly Stage[] = [
  "warmup",
  "taskInsertion",
  "work",
  "collate",
  "delivery",
];

/** Stages that are terminal for local and dry-run modes. */
export const TERMINAL_STAGE_FOR_DRY_RUN: Stage = "collate";
export { renderTargetFacts } from "./target.js";
