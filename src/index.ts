/**
 * Yama - AI-Native Code Review
 * Main export file
 */

// ============================================================================
// Core Exports
// ============================================================================

export {
  YamaV2Orchestrator,
  createYamaV2,
} from "./v2/core/YamaV2Orchestrator.js";
export { ConfigLoader } from "./v2/config/ConfigLoader.js";
export { MCPServerManager } from "./v2/core/MCPServerManager.js";
export { SessionManager } from "./v2/core/SessionManager.js";
export { PromptBuilder } from "./v2/prompts/PromptBuilder.js";

// ============================================================================
// Type Exports
// ============================================================================

export type {
  ReviewRequest,
  ReviewResult,
  ReviewUpdate,
  ReviewSession,
  ReviewStatistics,
  IssuesBySeverity,
  TokenUsage,
} from "./v2/types/v2.types.js";

export type {
  YamaV2Config,
  AIConfig,
  MCPServersConfig,
  ReviewConfig,
  DescriptionEnhancementConfig,
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

export const VERSION = "2.0.0";

// ============================================================================
// Default Export
// ============================================================================

export { createYamaV2 as default } from "./v2/core/YamaV2Orchestrator.js";
