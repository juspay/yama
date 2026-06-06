/**
 * Yama V2 Configuration Type Definitions
 */

import { FocusArea, BlockingCriteria } from "./v2.types.js";

// ============================================================================
// Main Configuration Type
// ============================================================================

export interface YamaConfig {
  version: number;
  configType: string;
  display: DisplayConfig;
  ai: AIConfig;
  mcpServers: MCPServersConfig;
  review: ReviewConfig;
  descriptionEnhancement: DescriptionEnhancementConfig;
  memoryBank: MemoryBankConfig;
  knowledgeBase: KnowledgeBaseConfig;
  memory: MemoryConfig;
  projectStandards?: ProjectStandardsConfig;
  monitoring: MonitoringConfig;
  performance: PerformanceConfig;
  /**
   * Optional explicit default VCS provider used as the lowest-priority
   * fallback by ProviderDetector when neither the request nor the
   * environment indicate a provider. Defaults to Bitbucket when unset.
   */
  defaultProvider?: "github" | "bitbucket";
}

// Backward-compatible alias.
export type YamaV2Config = YamaConfig;

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

/**
 * AI provider identifier. Yama does not maintain its own provider allow-list —
 * the value is forwarded verbatim to NeuroLink, which owns the real list
 * (vertex, google-ai, anthropic, openai, bedrock, azure, litellm, ollama,
 * huggingface, mistral, sagemaker, auto, ...). Typed as `string` so new
 * NeuroLink providers work without a type bump here.
 */
export type AIProvider = string;

export interface AIConfig {
  provider: AIProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  enableAnalytics: boolean;
  enableEvaluation: boolean;
  timeout: string;
  retryAttempts: number;
  enableToolFiltering?: boolean;
  toolFilteringMode?: "off" | "log-only" | "active";
  conversationMemory: ConversationMemoryConfig;
  explore: ExploreAIConfig;
}

export interface ExploreAIConfig {
  enabled: boolean;
  provider?: AIProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: string;
  cacheResults?: boolean;
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

export interface BitbucketConfig {
  enabled?: boolean;
  /** List of tool names to block from Bitbucket MCP server */
  blockedTools?: string[];
  /**
   * Native Bitbucket PR task creation.
   * When enabled, review findings of the configured severities are converted
   * from inline comments into Bitbucket tasks — checklist items that must be
   * resolved before the PR can be merged.
   * Requires Bitbucket Server (self-hosted); not available on Bitbucket Cloud.
   */
  taskCreation?: BitbucketTaskCreationConfig;
}

/**
 * A single conditional task rule.
 * When the AI detects that a PR satisfies the trigger conditions, it calls
 * create_pr_task once with the configured text. Rules are evaluated in STEP 2
 * (after reading the PR shell / changed files list), before the file-by-file
 * review starts. Each rule fires at most once per review.
 *
 * Example (Lighthouse repo yama.config.json):
 *   {
 *     "name": "automation-test-required",
 *     "triggerWhen": {
 *       "filesMatch": ["automation/", "ai-tab/"],
 *       "diffContains": ["slash command", "AI tab"]
 *     },
 *     "createTask": {
 *       "text": "Attach automation test cases and video proof for this PR."
 *     }
 *   }
 */
export interface ConditionalTaskRule {
  /**
   * Unique identifier for this rule.
   * Appears in ReviewResult.tasks[].triggeredByRule for traceability.
   */
  name: string;
  /** Optional human-readable explanation of when / why this rule fires. */
  description?: string;
  /**
   * Trigger conditions. The rule fires when ANY condition below is met.
   * The AI evaluates these semantically against the changed files and diff.
   */
  triggerWhen: {
    /**
     * File path patterns (glob-style or substring, case-insensitive).
     * The rule fires if ANY changed file path matches ANY entry in this list.
     * Examples: ["automation/", "src/ai-tab/", "slash"]
     */
    filesMatch?: string[];
    /**
     * Text / code patterns (case-insensitive substring).
     * The rule fires if ANY of these appear in the diff content OR changed file paths.
     * Examples: ["slash command", "AI tab", "automation suite"]
     */
    diffContains?: string[];
    /**
     * Always fire this rule for every PR review, regardless of changed files.
     * Useful for org-wide mandatory checklists.
     */
    always?: boolean;
  };
  /** The PR-level task to create when this rule fires. */
  createTask: {
    /** Full task text shown on the Bitbucket PR checklist. */
    text: string;
  };
}

/**
 * Configuration for converting specific review comments into Bitbucket PR tasks.
 * Tasks are native Bitbucket checklist items that block PR merging until resolved.
 * Uses the convert_pr_item MCP tool (Bitbucket Server only).
 */
export interface BitbucketTaskCreationConfig {
  /** Master switch. Requires Bitbucket Server. */
  enabled: boolean;
  /**
   * Which comment severities are automatically converted to tasks.
   * Defaults to ["CRITICAL", "MAJOR"]. Set explicitly to include MINOR.
   */
  severities?: Array<"CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION">;
  /**
   * Keyword the AI appends to any comment body to escalate that specific
   * comment to a Bitbucket task, regardless of its severity level.
   * Defaults to "[TASK]". Set to "" to disable keyword-based task creation
   * and rely solely on the configured severities.
   */
  taskKeyword?: string;
  /**
   * Conditional task rules evaluated once per review (after reading the
   * changed files list) before the file-by-file review starts.
   * Each rule creates a PR-level task when its trigger conditions are met.
   * This is the primary mechanism for repo-specific mandatory checklists
   * (e.g. "if PR touches automation code → require test evidence").
   */
  conditionalTaskRules?: ConditionalTaskRule[];
}

export interface GitHubConfig {
  enabled: boolean;
  /** List of tool names to block from GitHub MCP server */
  blockedTools?: string[];
  /**
   * Transport for the GitHub MCP server.
   * Defaults to "http" (GitHub's hosted remote MCP server). Use "stdio" only
   * for a self-hosted / Docker GitHub MCP server (requires `command`/`args`).
   */
  transport?: "http" | "stdio";
  /**
   * Endpoint for the remote HTTP GitHub MCP server.
   * Defaults to "https://api.githubcopilot.com/mcp/". Override to point at a
   * self-hosted / enterprise remote MCP endpoint.
   */
  url?: string;
  /** Command to launch a self-hosted stdio GitHub MCP server (transport: "stdio"). */
  command?: string;
  /** Arguments for the self-hosted stdio GitHub MCP server command. */
  args?: string[];
}

export interface JiraConfig {
  enabled: boolean;
  /** List of tool names to block from Jira MCP server */
  blockedTools?: string[];
}

export interface MCPServersConfig {
  bitbucket?: BitbucketConfig;
  github?: GitHubConfig;
  jira: JiraConfig;
}

// ============================================================================
// Review Configuration
// ============================================================================

export interface ReviewConfig {
  enabled: boolean;
  workflowInstructions: string;
  focusAreas: FocusArea[];
  blockingCriteria?: BlockingCriteria[];
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
// Knowledge Base Configuration (Reinforcement Learning)
// ============================================================================

export interface KnowledgeBaseConfig {
  /** Enable knowledge base feature */
  enabled: boolean;
  /** Path to knowledge base file (relative to project root) */
  path: string;
  /** Patterns to identify AI comment authors (case-insensitive) */
  aiAuthorPatterns: string[];
  /** Number of learnings before auto-summarization triggers */
  maxEntriesBeforeSummarization: number;
  /** Number of entries to retain after summarization */
  summaryRetentionCount: number;
  /** Auto-commit knowledge base changes (default for --commit flag) */
  autoCommit: boolean;
}

// ============================================================================
// Memory Configuration (Per-Repo Condensed Memory via NeuroLink)
// ============================================================================

/** Storage backend configuration for Hippocampus memory */
export type MemoryStorageConfig =
  | { type: "sqlite"; path?: string }
  | {
      type: "redis";
      host?: string;
      port?: number;
      password?: string;
      db?: number;
      keyPrefix?: string;
      ttl?: number;
    }
  | { type: "s3"; bucket: string; prefix?: string }
  | {
      type: "custom";
      onGet: (ownerId: string) => Promise<string | null>;
      onSet: (ownerId: string, memory: string) => Promise<void>;
      onDelete: (ownerId: string) => Promise<void>;
      onClose?: () => Promise<void>;
    };

/**
 * Yama-specific memory configuration.
 * Mirrors NeuroLink's Memory type (HippocampusConfig & { enabled }) with
 * Yama-specific fields for file-based storage.
 */
export interface MemoryConfig {
  /** Enable per-repo condensed memory feature */
  enabled: boolean;
  /** Directory for file-based memory storage (relative to project root) */
  storagePath: string;
  /** Maximum word count for condensed memory per repository (default: 50) */
  maxWords?: number;
  /** Custom condensation prompt (overrides default review-specific prompt) */
  prompt?: string;
  /** Storage backend configuration (default: file-based custom storage managed by Yama) */
  storage?: MemoryStorageConfig;
  /** AI provider/model for memory condensation (defaults to main AI provider) */
  neurolink?: {
    provider?: string;
    model?: string;
    temperature?: number;
  };
  /** Auto-commit memory files to the repo after review (default: false) */
  autoCommit?: boolean;
  /** Git commit message for memory auto-commits (default: "chore: update yama review memory [skip ci]") */
  commitMessage?: string;
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

// ============================================================================
// SDK Initialization Types
// ============================================================================

export interface YamaInitOptions {
  /** Optional path to yama config file */
  configPath?: string;
  /** Instance-level config overrides. Precedence: sdk overrides > config file > env > defaults. */
  configOverrides?: Partial<YamaConfig>;
}
