/**
 * Yama - AI-Native Code Review
 * Main export file
 */

// ============================================================================
// Core Exports
// ============================================================================

export {
  YamaOrchestrator,
  createYama,
  YamaOrchestrator as YamaV2Orchestrator,
  createYama as createYamaV2,
} from "./v2/core/YamaV2Orchestrator.js";
export {
  LearningOrchestrator,
  createLearningOrchestrator,
} from "./v2/core/LearningOrchestrator.js";
export { ConfigLoader } from "./v2/config/ConfigLoader.js";
export { MCPServerManager } from "./v2/core/MCPServerManager.js";
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
  ReviewUpdate,
  ReviewSession,
  ReviewStatistics,
  IssuesBySeverity,
  TokenUsage,
  UnifiedReviewRequest,
} from "./v2/types/v2.types.js";

export type {
  YamaConfig,
  YamaInitOptions,
  YamaConfig as YamaV2Config,
  AIConfig,
  MCPServersConfig,
  ReviewConfig,
  DescriptionEnhancementConfig,
  MemoryConfig,
} from "./v2/types/config.types.js";

export type {
  GetPullRequestResponse,
  GetPullRequestDiffResponse,
  GetIssueResponse,
  SearchCodeResponse,
} from "./v2/types/mcp.types.js";

// ============================================================================
// Version Information
// ============================================================================

export const VERSION = "2.2.1";

// ============================================================================
// Default Export
// ============================================================================

export { createYama as default } from "./v2/core/YamaV2Orchestrator.js";
