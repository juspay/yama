/**
 * Yama - AI-Native Code Review
 * Main export file
 */

import { createRequire } from "node:module";

// ============================================================================
// Core Exports
// ============================================================================

// `YamaOrchestrator` is exported below as a class, which exposes it to SDK
// consumers as BOTH a value and a type (with all of its public methods). A
// separate `export type { YamaOrchestrator }` is intentionally omitted because
// it would collide with this value export (TS2300: Duplicate identifier).
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

/**
 * Single source of truth for the Yama version: read from package.json at runtime
 * (this module sits one level below package.json in both src/ and dist/, so the
 * relative require resolves in dev and in the published build). Falls back to a
 * sentinel if the file can't be read, instead of drifting from a hardcoded
 * literal.
 */
function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = resolveVersion();

// ============================================================================
// Default Export
// ============================================================================

export { createYama as default } from "./v2/core/YamaV2Orchestrator.js";
