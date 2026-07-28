/**
 * Yama V2 Configuration Type Definitions
 */

import { FocusArea, BlockingCriteria } from "./review.js";

// ============================================================================
// Main Configuration Type
// ============================================================================

export type YamaConfig = {
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
  /** Cross-run review state (incremental re-review). Default: file store. */
  state?: StateConfig;
  performance: PerformanceConfig;
  /**
   * Optional explicit default VCS provider used as the lowest-priority
   * fallback by ProviderDetector when neither the request nor the
   * environment indicate a provider. Defaults to Bitbucket when unset.
   */
  defaultProvider?: "github" | "bitbucket";
};

// ============================================================================
// Display Configuration
// ============================================================================

export type DisplayConfig = {
  showBanner: boolean;
  streamingMode: boolean;
  verboseToolCalls: boolean;
  showAIThinking: boolean;
};

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

export type AIConfig = {
  provider: AIProvider;
  model: string;
  /**
   * Sampling temperature. Optional — when unset, the field is omitted from
   * NeuroLink `generate()` calls entirely and the provider default applies.
   */
  temperature?: number;
  maxTokens: number;
  enableAnalytics: boolean;
  enableEvaluation: boolean;
  timeout: string;
  retryAttempts: number;
  conversationMemory: ConversationMemoryConfig;
  explore: ExploreAIConfig;
  /** MCP tool-output limits passed to the NeuroLink instance (`mcp.outputLimits`). */
  mcpOutputLimits?: McpOutputLimitsConfig;
};

export type ExploreAIConfig = {
  enabled: boolean;
  provider?: AIProvider;
  model?: string;
  /** Falls back to `ai.temperature`; when both are unset, omitted from the call. */
  temperature?: number;
  maxTokens?: number;
  timeout?: string;
  cacheResults?: boolean;
};

export type ConversationMemoryConfig = {
  enabled: boolean;
  store: "memory" | "redis";
  maxSessions: number;
  maxTurnsPerSession: number;
  enableSummarization: boolean;
  redis?: RedisConfig;
  /**
   * NeuroLink context auto-compaction (prune → dedup → summarize → sliding
   * window; triggers at `threshold` of the model context window). Passed
   * through verbatim under `conversationMemory.contextCompaction`.
   */
  contextCompaction?: ContextCompactionConfig;
};

export type ContextCompactionConfig = {
  enabled?: boolean;
  /** 0–1 fraction of the context window that triggers compaction (default 0.8). */
  threshold?: number;
  enablePruning?: boolean;
  enableDeduplication?: boolean;
  enableSlidingWindow?: boolean;
  maxToolOutputBytes?: number;
  maxToolOutputLines?: number;
};

/**
 * NeuroLink MCP tool-output limits. `externalize` offloads oversized tool
 * results (e.g. huge PR diffs) to an artifact store the model can page via
 * its retrieval tool instead of flooding the context window.
 */
export type McpOutputLimitsConfig = {
  strategy?: "inline" | "externalize";
  maxBytes?: number;
  warnBytes?: number;
};

export type RedisConfig = {
  host: string;
  port: number;
  password?: string;
  keyPrefix?: string;
  ttl?: number;
};

// ============================================================================
// MCP Servers Configuration
// ============================================================================

/**
 * Which agent(s) an MCP server is exposed to.
 * "review" = the main review/enhance agent; "explore" = the read-only
 * context-explorer sub-agent. Defaults to both when omitted.
 */
export type McpServerRole = "review" | "explore";

/**
 * Which review mode(s) a server applies to. "pr" = reviewing a remote pull
 * request (VCS servers); "local" = reviewing a local git diff. Defaults to both.
 */
export type McpServerMode = "pr" | "local";

/**
 * Generic, declarative MCP server definition — the shape users write in
 * `.yama/mcp.json` (mirrors NeuroLink's `mcpServers`/`MCPServerInfo` schema).
 * Lets any MCP server be added at the project level without a code change.
 * `${ENV_VAR}` placeholders in `env`, `headers`, `url`, and `args` are
 * substituted from the environment at load time.
 */
export type McpServerDefinition = {
  /** Set false to declare-but-disable a server without deleting its entry. */
  enabled?: boolean;
  transport?: "stdio" | "http" | "sse" | "websocket";
  /** stdio: executable to launch. */
  command?: string;
  /** stdio: arguments (supports `${ENV_VAR}` substitution). */
  args?: string[];
  /** stdio: environment for the child process (supports `${ENV_VAR}`). */
  env?: Record<string, string>;
  /** http/sse/ws: remote endpoint (supports `${ENV_VAR}`). */
  url?: string;
  /** http/sse/ws: request headers, e.g. Authorization (supports `${ENV_VAR}`). */
  headers?: Record<string, string>;
  /** Per-server tool denylist — these tool names are hidden from the agent. */
  blockedTools?: string[];
  /**
   * Per-server tool ALLOWLIST (fail-closed). When set, ONLY these tools are
   * exposed to the agent; every other tool the server advertises is blocked.
   * Use this to lock a custom server down to a known-safe read-only subset.
   */
  allowedTools?: string[];
  /** Connection timeout (ms). */
  timeout?: number;
  /**
   * Connection retry/backoff, passed through to NeuroLink. Useful for slow
   * remote HTTP endpoints (e.g. the hosted GitHub MCP) whose TLS handshake +
   * lazy tool discovery can exceed a single attempt.
   */
  retryConfig?: McpRetryConfig;
  /**
   * http/sse: authentication config (oauth2 / bearer / api-key), passed
   * through verbatim to NeuroLink's `addExternalMCPServer`.
   */
  auth?: Record<string, unknown>;
  /**
   * http: transport timeouts (connectionTimeout, requestTimeout, idleTimeout,
   * keepAliveTimeout — all ms), passed through verbatim to NeuroLink.
   */
  httpOptions?: Record<string, unknown>;
  /**
   * http/sse: request rate limiting, passed through verbatim to NeuroLink.
   */
  rateLimiting?: Record<string, unknown>;
  /** Which agents may use this server. Defaults to ["review", "explore"]. */
  roles?: McpServerRole[];
  /** Which review modes this server applies to. Defaults to ["pr", "local"]. */
  modes?: McpServerMode[];
  /**
   * Forward-compatibility: any additional keys are forwarded to NeuroLink
   * verbatim (after `${ENV}` substitution), so new NeuroLink server options
   * are usable from config without a Yama release. Only the Yama-routing keys
   * (`enabled`, `roles`, `modes`, `allowedTools`) are stripped before
   * registration.
   */
  [key: string]: unknown;
};

/** Connection retry/backoff for an MCP server (NeuroLink `retryConfig`). */
export type McpRetryConfig = {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
};

/**
 * The `.yama/mcp.json` document shape (NeuroLink-compatible `mcpServers` map).
 * Keys are server ids; each maps to a full {@link McpServerDefinition}. These
 * project-level servers are merged with the ones in `mcpServers.servers`.
 */
export type McpConfigFile = {
  mcpServers: Record<string, McpServerDefinition>;
};

/**
 * MCP configuration — a single generic map of server-id → definition. Every
 * server (bitbucket, github, serena, local-git, custom) lives here; the codebase
 * special-cases none of them. Enabled servers are registered for their roles and
 * modes with their config-driven tool filtering applied.
 */
export type MCPServersConfig = {
  servers: Record<string, McpServerDefinition>;
};

// ============================================================================
// Review Configuration
// ============================================================================

export type ReviewConfig = {
  enabled: boolean;
  /**
   * Finding verification before posting: "off" (dedup only), "basic"
   * (tools-off critic pass), "strict" (critic + code evidence check;
   * uncertain findings are rejected). Default: basic.
   */
  verification?: VerificationMode;
  workflowInstructions: string;
  focusAreas: FocusArea[];
  blockingCriteria?: BlockingCriteria[];
  excludePatterns: string[];
  contextLines: number;
  maxFilesPerReview: number;
  fileAnalysisTimeout: string;
  toolPreferences: ToolPreferencesConfig;
};

export type ToolPreferencesConfig = {
  lazyLoading: boolean;
  cacheToolResults: boolean;
  parallelToolCalls: boolean;
  maxToolCallsPerFile: number;
  enableCodeSearch: boolean;
  enableDirectoryListing: boolean;
};

// ============================================================================
// Description Enhancement Configuration
// ============================================================================

export type DescriptionEnhancementConfig = {
  enabled: boolean;
  instructions: string;
  requiredSections: RequiredSection[];
  preserveContent: boolean;
  autoFormat: boolean;
};

export type RequiredSection = {
  key: string;
  name: string;
  required: boolean;
  description: string;
};

// ============================================================================
// Memory Bank Configuration
// ============================================================================

export type MemoryBankConfig = {
  enabled: boolean;
  path: string;
  fallbackPaths: string[];
  standardFiles?: string[];
};

// ============================================================================
// Knowledge Base Configuration (Reinforcement Learning)
// ============================================================================

export type KnowledgeBaseConfig = {
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
};

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
export type MemoryConfig = {
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
};

// ============================================================================
// Project Standards Configuration
// ============================================================================

export type ProjectStandardsConfig = {
  customPromptsPath: string;
  additionalFocusAreas: FocusArea[];
  customBlockingRules: BlockingCriteria[];
  severityOverrides: Record<string, string>;
};

// ============================================================================
// Monitoring Configuration
// ============================================================================

export type MonitoringConfig = {
  enabled: boolean;
  logToolCalls: boolean;
  logAIDecisions: boolean;
  logTokenUsage: boolean;
  exportFormat: "json" | "csv";
  exportPath: string;
  /** Per-run review report artifact (markdown + JSON). */
  report?: RunReportConfig;
};

/**
 * Per-run report: the human-readable record of what the review actually did —
 * bootstrap standards, explore investigations, gate batches with critic
 * verdicts, finalization, and the reconciled verdict. Written locally (a log,
 * not a PR side effect), so CI can archive it next to the state file.
 */
export type RunReportConfig = {
  /** Default true. */
  enabled?: boolean;
  /** Directory for report files. Default ".yama/reports". */
  path?: string;
};

// ============================================================================
// Performance Configuration
// ============================================================================

export type PerformanceConfig = {
  /**
   * OPTIONAL wall-clock cap per agentic review turn (the fallback for
   * loop.turnTimeoutMs — each generate() call gets its own clock; retries,
   * finalization, and enhancement turns are capped individually, not the
   * whole CLI run). Unset by default: reviews are bounded by WORK
   * (loop.maxSteps + the submit_review gate), not by time — a wall clock
   * cuts the loop mid-review and loses quality, so only set this when an
   * external scheduler truly requires it.
   */
  maxReviewDuration?: string;
  tokenBudget: TokenBudgetConfig;
  costControls: CostControlsConfig;
  /** Agentic-loop guards, passed to NeuroLink generate() calls. */
  loop?: LoopGuardConfig;
};

/**
 * Bounds for the agentic tool-calling loop. All optional. Step/stall/tool
 * guards protect against hangs and runaways; there is deliberately no default
 * whole-turn wall clock (see PerformanceConfig.maxReviewDuration).
 */
export type LoopGuardConfig = {
  /** Max tool-loop steps per generate() call (NeuroLink default is 200). */
  maxSteps?: number;
  /** Whole-turn wall-clock cap in ms (falls back to maxReviewDuration).
   *  Off by default — prefer step bounds over time bounds. */
  turnTimeoutMs?: number;
  /** No-progress watchdog in ms. */
  stallTimeoutMs?: number;
  /** Per-tool-call timeout in ms. */
  toolTimeoutMs?: number;
};

export type TokenBudgetConfig = {
  maxTokensPerReview: number;
  warningThreshold: number;
};

export type CostControlsConfig = {
  maxCostPerReview: number;
  warningThreshold: number;
};

// ============================================================================
// SDK Initialization Types
// ============================================================================

export type YamaInitOptions = {
  /** Optional path to yama config file */
  configPath?: string;
  /** Instance-level config overrides. Precedence: sdk overrides > config file > env > defaults. */
  configOverrides?: Partial<YamaConfig>;
};

import type { StateConfig } from "./state.js";
import type { VerificationMode } from "./harness.js";

// ── Provider detection (moved from utils/ProviderDetector.ts) ───────────────

export type VCSProvider = "github" | "bitbucket";

// ── Observability (moved from utils/ObservabilityConfig.ts) ─────────────────

export type ObservabilityConfig = {
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled: boolean;
  };
};

// ── NeuroLink factory options (moved from core/NeuroLinkFactory.ts) ─────────

export type NeuroLinkFactoryOptions = {
  /**
   * Conversation-memory configuration passed through to NeuroLink, or `false`
   * to disable it (the explorer sub-agent runs stateless).
   */
  conversationMemory?: ConversationMemoryConfig | false;
  /**
   * When provided (and conversation memory is enabled), the per-repo condensed
   * memory config is attached so NeuroLink/Hippocampus persists review memory.
   */
  memoryManager?: import("../memory/MemoryManager.js").MemoryManager | null;
  /**
   * Optional instance-level tool denylist (glob-capable) applied via NeuroLink's
   * `tools.exclude`. Generally left unset — tool filtering is config-driven per
   * MCP server (`blockedTools`/`allowedTools`); this is only for a caller that
   * needs an extra instance-wide exclusion.
   */
  excludeTools?: readonly string[];
  /**
   * MCP tool-output limits for this instance (`mcp.outputLimits`).
   * `externalize` pages oversized tool results instead of inlining them.
   */
  mcpOutputLimits?: McpOutputLimitsConfig;
};
