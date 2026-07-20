/**
 * Yama - AI-Native Code Review
 * Main export file
 */

// ============================================================================
// Core Exports
// ============================================================================

// `YamaOrchestrator` is exported below as a class, which exposes it to SDK
// consumers as BOTH a value and a type (with all of its public methods). A
// separate `export type { YamaOrchestrator }` is intentionally omitted because
// it would collide with this value export (TS2300: Duplicate identifier).
export { YamaOrchestrator, createYama } from "./v2/core/YamaOrchestrator.js";
// Backward-compatible aliases for the pre-rename public SDK surface (rule 12:
// existing consumers keep working on a minor version).
/** @deprecated Use {@link YamaOrchestrator} / {@link createYama} instead. */
export {
  YamaOrchestrator as YamaV2Orchestrator,
  createYama as createYamaV2,
} from "./v2/core/YamaOrchestrator.js";
export {
  LearningOrchestrator,
  createLearningOrchestrator,
} from "./v2/core/LearningOrchestrator.js";
export { ConfigLoader } from "./v2/config/ConfigLoader.js";
export { MCPServerManager } from "./v2/core/MCPServerManager.js";
export { McpRegistry } from "./v2/core/McpRegistry.js";
export { SessionManager } from "./v2/core/SessionManager.js";
export { PromptBuilder } from "./v2/prompts/PromptBuilder.js";
export { MemoryManager } from "./v2/memory/MemoryManager.js";

// ============================================================================
// Type Exports
// ============================================================================

export type {
  LocalReviewFinding,
  LocalReviewRequest,
  LocalReviewResult,
  ReviewRequest,
  ReviewMode,
  ReviewResult,
  EnhancementResult,
  ReviewUpdate,
  ReviewSession,
  ReviewStatistics,
  IssuesBySeverity,
  TokenUsage,
  UnifiedReviewRequest,
} from "./v2/types/index.js";

export type {
  YamaConfig,
  /** @deprecated Use {@link YamaConfig} instead. */
  YamaConfig as YamaV2Config,
  YamaInitOptions,
  AIConfig,
  MCPServersConfig,
  McpServerDefinition,
  McpConfigFile,
  McpServerRole,
  ReviewConfig,
  DescriptionEnhancementConfig,
  MemoryConfig,
} from "./v2/types/index.js";

export type {
  GetPullRequestResponse,
  GetPullRequestDiffResponse,
  SearchCodeResponse,
} from "./v2/types/index.js";

// ============================================================================
// Version Information
// ============================================================================

/**
 * Yama version — single source of truth lives in the leaf module
 * `v2/utils/version.ts` (re-exported here for the public SDK surface).
 */
export { VERSION } from "./v2/utils/version.js";

// ============================================================================
// Default Export
// ============================================================================

export { createYama as default } from "./v2/core/YamaOrchestrator.js";
