/**
 * Run store (TASKS:Y2.3). Runtime exports only — the shapes live in `src/types/store.ts`
 * and reach consumers through the types barrel.
 */
export { StoreError } from "./errors.js";
export { readJson, writeJson } from "./json.js";
export {
  STORE_ENTRIES,
  STORE_ROOT,
  resolveStorePaths,
  runStoreSlug,
  storePathsForDir,
} from "./paths.js";
export {
  ensureStore,
  payloadPath,
  readLedger,
  readPayload,
  readRunReport,
  readStage,
  readWorkerReport,
  writeLedger,
  writePayload,
  writeRunReport,
  writeStage,
  writeWorkerReport,
} from "./runStore.js";
export {
  FindingSchema,
  FindingsLedgerSchema,
  RunDeliveryStatsSchema,
  RunGateStatsSchema,
  RunRecurrenceStatsSchema,
  RunReportSchema,
  StageEnvelopeSchema,
  WorkerReportSchema,
} from "./schema.js";
