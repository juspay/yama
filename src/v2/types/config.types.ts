/**
 * Yama V2 Configuration Type Definitions
 */

import { FocusArea, BlockingCriteria } from "./v2.types.js";

// ============================================================================
// Main Configuration Type
// ============================================================================

export interface YamaV2Config {
  version: number;
  configType: string;
  display: DisplayConfig;
  ai: AIConfig;
  mcpServers: MCPServersConfig;
  review: ReviewConfig;
  descriptionEnhancement: DescriptionEnhancementConfig;
  memoryBank: MemoryBankConfig;
  projectStandards?: ProjectStandardsConfig;
  monitoring: MonitoringConfig;
  performance: PerformanceConfig;
}

// ============================================================================
// Display Configuration
// ============================================================================

export interface DisplayConfig {
  showBanner: boolean;
  streamingMode: boolean;
  verboseToolCalls: boolean;
  showAIThinking: boolean;
}

// ============================================================================
// AI Configuration
// ============================================================================

export interface AIConfig {
  provider: "auto" | "google-ai" | "anthropic" | "openai" | "bedrock" | "azure";
  model: string;
  temperature: number;
  maxTokens: number;
  enableAnalytics: boolean;
  enableEvaluation: boolean;
  timeout: string;
  retryAttempts: number;
  conversationMemory: ConversationMemoryConfig;
}

export interface ConversationMemoryConfig {
  enabled: boolean;
  store: "memory" | "redis";
  maxSessions: number;
  maxTurnsPerSession: number;
  enableSummarization: boolean;
  redis?: RedisConfig;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  keyPrefix?: string;
  ttl?: number;
}

// ============================================================================
// MCP Servers Configuration
// ============================================================================

export interface MCPServersConfig {
  initializationTimeout: number; // Timeout in milliseconds (e.g., 120000 for 2 minutes)
  jira: {
    enabled: boolean;
  };
}

// ============================================================================
// Review Configuration
// ============================================================================

export interface ReviewConfig {
  enabled: boolean;
  workflowInstructions: string;
  focusAreas: FocusArea[];
  blockingCriteria: BlockingCriteria[];
  excludePatterns: string[];
  contextLines: number;
  maxFilesPerReview: number;
  fileAnalysisTimeout: string;
  toolPreferences: ToolPreferencesConfig;
}

export interface ToolPreferencesConfig {
  lazyLoading: boolean;
  cacheToolResults: boolean;
  parallelToolCalls: boolean;
  maxToolCallsPerFile: number;
  enableCodeSearch: boolean;
  enableDirectoryListing: boolean;
}

// ============================================================================
// Description Enhancement Configuration
// ============================================================================

export interface DescriptionEnhancementConfig {
  enabled: boolean;
  instructions: string;
  requiredSections: RequiredSection[];
  preserveContent: boolean;
  autoFormat: boolean;
}

export interface RequiredSection {
  key: string;
  name: string;
  required: boolean;
  description: string;
}

// ============================================================================
// Memory Bank Configuration
// ============================================================================

export interface MemoryBankConfig {
  enabled: boolean;
  path: string;
  fallbackPaths: string[];
  standardFiles?: string[];
}

// ============================================================================
// Project Standards Configuration
// ============================================================================

export interface ProjectStandardsConfig {
  customPromptsPath: string;
  additionalFocusAreas: FocusArea[];
  customBlockingRules: BlockingCriteria[];
  severityOverrides: Record<string, string>;
}

// ============================================================================
// Monitoring Configuration
// ============================================================================

export interface MonitoringConfig {
  enabled: boolean;
  logToolCalls: boolean;
  logAIDecisions: boolean;
  logTokenUsage: boolean;
  exportFormat: "json" | "csv";
  exportPath: string;
}

// ============================================================================
// Performance Configuration
// ============================================================================

export interface PerformanceConfig {
  maxReviewDuration: string;
  tokenBudget: TokenBudgetConfig;
  costControls: CostControlsConfig;
}

export interface TokenBudgetConfig {
  maxTokensPerReview: number;
  warningThreshold: number;
}

export interface CostControlsConfig {
  maxCostPerReview: number;
  warningThreshold: number;
}
