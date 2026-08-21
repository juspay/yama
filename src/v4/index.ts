/**
 * Yama v4 public surface.
 *
 * The one sanctioned re-exporter of types. Everything else imports from
 * `../types/index.js`.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type * from "./types/index.js";

// ── Configuration ────────────────────────────────────────────────────────────
export { ConfigError, loadConfig, substituteEnv } from "./config/Loader.js";
export {
  ModelChainError,
  describeChain,
  memberAt,
  normalizeModelChain,
  resolveSlot,
} from "./config/ModelChain.js";
export {
  CONCURRENCY_TIERS,
  DEFAULT_EXCLUDE_PATTERNS,
  STAGE_ORDER,
  optionalDefaults,
} from "./config/defaults.js";
export { adaptV3Config, findV3ConfigPath } from "./config/v3Compat.js";
export {
  buildMigrationPlan,
  importCodeowners,
  renderMigrationPlan,
} from "./config/migrate.js";

// ── Run ──────────────────────────────────────────────────────────────────────
export {
  buildSessionId,
  createRunContext,
  parseDurationMs,
  withResolvedIdentity,
} from "./core/RunContext.js";
export { SessionRunner, normalizeTurn } from "./core/SessionRunner.js";
export {
  describeOutcomes,
  missing,
  passed,
  renderRemediation,
  runStages,
} from "./core/StageMachine.js";
export { supervise, WASTE_THRESHOLDS } from "./core/Supervisor.js";
export {
  reviewPredicate,
  runReviewPipeline,
  runReviewTurns,
} from "./core/ReviewPipeline.js";
export { deriveVerdict, describeVerdict } from "./core/verdict.js";
export {
  assembleRun,
  buildRunMessage,
  resolveBranch,
} from "./core/RunAssembly.js";
export {
  SLOT_ENFORCEMENT,
  buildInstanceConfig,
  describeSlotEnforcement,
  probeChain,
  resolveModelChains,
  toModelPool,
} from "./core/NeurolinkFactory.js";
export {
  formatDoctorReport,
  inspectCapabilityPairs,
  inspectLearnWrite,
  runDoctor,
} from "./core/Doctor.js";

// ── Connections ──────────────────────────────────────────────────────────────
export {
  ConnectionRegistry,
  normalizeToolName,
} from "./connections/Registry.js";
export {
  CapabilityError,
  CapabilityResolver,
  assertLiveCapabilities,
  resolveCapabilities,
} from "./connections/Capabilities.js";

// ── Changes ──────────────────────────────────────────────────────────────────
export {
  buildChangeSet,
  changedPaths,
  fileInChangeSet,
  findFile,
  lineWasChanged,
  parseUnifiedDiff,
} from "./changes/ChangeSet.js";
export { matchesAnyPath, matchesPath, normalizePath } from "./policy/paths.js";
export { evaluateGuards } from "./policy/guards.js";

// ── Findings ─────────────────────────────────────────────────────────────────
export { applySeverityFloor, gateFindings } from "./findings/Gate.js";
export { FindingLedger, extractCommentId } from "./findings/Ledger.js";
export {
  buildFindingId,
  isBotAuthored,
  parseMarkers,
  renderMarker,
  scanMarkers,
  withMarker,
} from "./findings/Markers.js";

// ── Checks ───────────────────────────────────────────────────────────────────
export {
  CheckSecurityError,
  assertCheckConfigUntampered,
  capFindings,
  checkOutcomes,
  executeCheck,
  failedBlockingChecks,
  flaggedLocations,
  prepareChecks,
  scopeFindings,
  shouldRunCheck,
  toFindings,
} from "./checks/Runner.js";
export { PARSERS, getParser } from "./checks/parsers/index.js";
export { extractFindings, extractedFindingsSchema } from "./checks/extract.js";
export {
  evaluateOwnership,
  renderOwnershipComment,
  selectOwnershipRules,
} from "./checks/builtin/owners.js";

// ── Agent surface ────────────────────────────────────────────────────────────
export {
  SYSTEM_INSTRUCTION,
  buildTaskMessage,
} from "./agents/systemInstruction.js";
export {
  SUB_AGENTS,
  DELEGATION_CAPS,
  findSubAgent,
  reportToCandidates,
} from "./agents/subAgents.js";
export {
  entriesFromProduct,
  entriesFromRules,
  entryFromPrContext,
  recall,
} from "./tools/recall.js";
export { buildYamaTools, toolsForStage } from "./tools/registry.js";
export { isMutatingGitTool, parseGitCommand } from "./tools/gitSafe.js";
export { resolveInSandbox } from "./tools/sandbox.js";
export {
  beginReview,
  postInlineComment,
  postMissingFindings,
  postOwnersComment,
  postSummary,
  setReviewStatus,
  submitReview,
} from "./tools/posting.js";
export {
  renderFindingComment,
  renderSummaryComment,
} from "./tools/commentFormat.js";

// ── Artifacts ────────────────────────────────────────────────────────────────
export {
  consumeArtifact,
  emptyArtifact,
  lastReviewedSha,
  listArtifacts,
  loadArtifact,
  recordRun,
  reportedIds,
  saveArtifact,
  summarizeForRecall,
} from "./artifacts/PrArtifact.js";

// ── Product model ────────────────────────────────────────────────────────────
export {
  buildImpactContext,
  capabilitiesForChange,
  dependentsOf,
  historicalRisk,
  historyFor,
  inferCorrections,
  linkCorrection,
  deriveImpactReport,
  renderImpactReport,
} from "./product/Capabilities.js";

// ── Prompts ──────────────────────────────────────────────────────────────────
export {
  describePrompts,
  localCatalog,
  localPrompt,
  requestedIds,
  resolvePrompts,
} from "./prompts/PromptStore.js";
export {
  DESCRIPTION_INSTRUCTION,
  EXTRACTION_INSTRUCTION,
  LOCAL_PROMPTS,
  PROMPT_IDS,
  TRIAGE_INSTRUCTION,
  promptIdForSubAgent,
} from "./prompts/local.js";

// ── Structured output ────────────────────────────────────────────────────────
export { generateStructured } from "./core/StructuredCall.js";
export { mergeTurnOutcome, turnOutcomeSchema } from "./agents/turnContract.js";

// ── Judge ────────────────────────────────────────────────────────────────────
export {
  CONFIDENCE_RUBRIC,
  JUDGE_ROLE,
  applyAgreementBonus,
  buildJudgePrompt,
  collectScores,
  confidenceSchema,
  countAgreement,
  createInlineJudge,
  mergeReports,
  needsJudgement,
} from "./judge/inline.js";
export {
  checkHealth,
  computeQuality,
  computeRunMetrics,
  renderScorecard,
} from "./judge/scorecard.js";

// ── Learn ────────────────────────────────────────────────────────────────────
export {
  detectMergeStrategy,
  renderLearningDisabled,
  resolveMergedPullRequest,
  validateLearnTrigger,
} from "./learn/MergeResolver.js";
export {
  GitWriteError,
  assertScopedPaths,
  commitAndPush,
  learnCommitMessage,
  prepareCredentials,
} from "./learn/GitWriter.js";
export {
  BOOTSTRAP_INSTRUCTIONS,
  BOOTSTRAP_WINDOW,
  buildBootstrapPlan,
  hasEnoughHistory,
} from "./learn/Bootstrap.js";
export {
  bootstrapDraftSchema,
  normalizePullRequests,
  readRepositoryDocs,
  readTopLevelPaths,
  renderBootstrapEvidence,
  renderBootstrapPlan,
  runBootstrap,
} from "./learn/BootstrapRunner.js";
export {
  FIRST_RUN_LOOKBACK,
  advanceWatermark,
  describeWindow,
  emptyWatermark,
  resolveWindow,
  windowFromCommits,
  windowFromProvider,
} from "./learn/Window.js";
export {
  loadWatermark,
  saveWatermark,
  watermarkPath,
  watermarkRelativePath,
} from "./learn/WatermarkStore.js";
export { isCI, loadLocalEnv, parseEnvFile } from "./cli/env.js";
export {
  DiffError,
  hashFiles,
  readLocalChangeSet,
  resolveMergeBase,
} from "./core/LocalDiff.js";
export {
  PROMOTION,
  applyHumanComments,
  applyYamaOutcomes,
  computePrecision,
  triageSchema,
  renderLearningSummary,
  retireDormantRules,
} from "./learn/Triage.js";

// ── Runtime, assembly, and the live probe ────────────────────────────────────
export { createRuntime, registerDelegates } from "./core/Runtime.js";
export {
  applyStageTools,
  enabledSubAgents,
  excludedToolsForStage,
} from "./core/ToolExposure.js";
export { runReview } from "./core/ReviewRunner.js";
export { normalizeComments } from "./connections/Comments.js";
export {
  capabilityParams,
  invokeCapability,
  targetParams,
} from "./connections/invoke.js";
export { renderRunReport, writeRunReport } from "./core/RunReport.js";
export { probeLive } from "./core/DoctorProbe.js";
export { createTurnBinding } from "./tools/progress.js";
export {
  buildWorkspaceTools,
  gitTool,
  listFilesTool,
  readFileTool,
  searchCodeTool,
} from "./tools/workspace.js";
export {
  needsExtraction,
  runConfiguredChecks,
  shellRunner,
} from "./checks/execute.js";
export {
  LEARNED_RULES_PATH,
  appendImpactLog,
  authoredRuleIds,
  partitionLearned,
  writeLearnedRules,
} from "./learn/KnowledgeWriter.js";
export { learnFromEntry, runLearn } from "./learn/LearnRunner.js";
