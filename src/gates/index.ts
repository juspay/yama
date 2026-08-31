/**
 * The gates (TASKS:Y4) — the deterministic checks between agentic stages.
 *
 * Runtime exports only; gate shapes live in `src/types/gates.ts` and reach consumers
 * through the types barrel. Nothing here calls a model: a gate that needed judgement to
 * decide whether the last judgement was sound would not be a gate.
 */
export {
  buildClosingPrompt,
  buildSchemaRetryPrompt,
  checkpointWithSchemaGate,
  describeAttempt,
} from "./schema.js";
export {
  buildChecklistNudge,
  checkChecklist,
  distinctTasks,
  enforceChecklist,
} from "./checklist.js";
export {
  buildPreparationNudge,
  checkCoverage,
  checklistProblems,
  preparationFatal,
} from "./coverage.js";
export { groundFindings } from "./grounded.js";
export { dedupePostedFindings } from "./markers.js";
export {
  NO_PRIOR_FINDINGS,
  classifyPriorFindings,
  unresolvedPriorFindings,
} from "./recurrence.js";
export {
  confirmAcceptedWrites,
  confirmCreated,
  confirmFromComments,
  confirmPosted,
  confirmToolRan,
  mergeConfirmations,
  postingFailure,
} from "./posting.js";
export {
  decideVerdict,
  rankFindings,
  reviewEstablishedNothing,
  withRecoveryCaveat,
} from "./verdict.js";
export { exitCodeFor } from "./exit.js";
