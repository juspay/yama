import { RuleComplianceEntry } from "./rules.js";
/**
 * Yama V2 TypeScript Type Definitions
 * AI-Native MCP Architecture Types
 */

// ============================================================================
// Review Request & Response Types
// ============================================================================

export type ReviewRequest = {
  /** Head commit SHA when known (CI env) — recorded in review state. */
  headSha?: string;
  mode: "pr";

  // Auto-detected or explicitly set
  provider?: "github" | "bitbucket";

  // Bitbucket parameters (backward compatible)
  workspace?: string;
  repository?: string;

  // GitHub parameters (new)
  owner?: string;
  repo?: string;
  prNumber?: number;

  // Alternative: use pull request ID (Bitbucket) or issue number (GitHub)
  pullRequestId?: number;

  // Both
  branch?: string;
  cloneUrl?: string;
  dryRun?: boolean;
  verbose?: boolean;
  configPath?: string;
  prompt?: string;
  focus?: string[];
  outputSchemaVersion?: string;
};

export type ReviewMode = "pr" | "local";
export type LocalDiffSource = "staged" | "uncommitted" | "range";

export type LocalReviewRequest = {
  mode: "local";
  repoPath?: string;
  diffSource?: LocalDiffSource;
  baseRef?: string;
  headRef?: string;
  includePaths?: string[];
  dryRun?: boolean;
  verbose?: boolean;
  configPath?: string;
  prompt?: string;
  focus?: string[];
  outputSchemaVersion?: string;
  maxDiffChars?: number;
};

export type UnifiedReviewRequest = ReviewRequest | LocalReviewRequest;

export type ReviewResult = {
  mode?: ReviewMode;
  prId: number;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED";
  statistics: ReviewStatistics;
  summary: string;
  duration: number;
  tokenUsage: TokenUsage;
  costEstimate: number;
  sessionId: string;
  descriptionEnhanced?: boolean;
  totalComments?: number;
  /** How the agentic loop actually ended — surfaced, never hidden. */
  completion?: ReviewCompletion;
  /** Normalized findings from the structured verdict (source for state). */
  issues?: LocalReviewFinding[];
  /**
   * Verdict issues that never passed the submit_review gate — unverified
   * claims, quarantined out of `issues`: they do not drive the decision, are
   * not posted, and are not persisted to state. Surfaced for transparency.
   */
  ungatedIssues?: LocalReviewFinding[];
  /** Prior-finding ids the agent verified as fixed this run. */
  resolvedIssueIds?: string[];
  /** Per-rule compliance derived from findings (.yama/rules). */
  ruleCompliance?: RuleComplianceEntry[];
};

/**
 * Honest completion metadata for a review generate() call. A review that hit
 * a step cap, context cap, time limit, or truncated JSON is PARTIAL and must
 * never be reported as a clean approval.
 */
export type ReviewCompletion = {
  stopReason:
    | "completed"
    | "step-cap"
    | "context-cap"
    | "time-limit"
    | "stalled"
    | "aborted"
    | "provider-error"
    | "unknown";
  stepsUsed?: number;
  jsonTruncated?: boolean;
  jsonRepaired?: boolean;
  /** True when the loop ended for any reason other than natural completion. */
  partial: boolean;
};

/** Result of a standalone PR description-enhancement run. */
export type EnhancementResult = {
  success: boolean;
  enhanced: boolean;
  sessionId: string;
};

export type LocalReviewFinding = {
  id: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";
  category: string;
  title: string;
  description: string;
  filePath?: string;
  line?: number;
  suggestion?: string;
  /** Rule key (projectStandards.severityOverrides / .yama rules). */
  rule?: string;
};

export type LocalReviewResult = {
  mode: "local";
  decision: "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED";
  summary: string;
  issues: LocalReviewFinding[];
  enhancements: LocalReviewFinding[];
  statistics: {
    filesChanged: number;
    additions: number;
    deletions: number;
    issuesFound: number;
    enhancementsFound: number;
    issuesBySeverity: IssuesBySeverity;
  };
  duration: number;
  tokenUsage: TokenUsage;
  costEstimate: number;
  sessionId: string;
  schemaVersion: string;
  metadata: {
    repoPath: string;
    diffSource: LocalDiffSource;
    baseRef?: string;
    headRef?: string;
    truncated: boolean;
  };
};

export type ReviewStatistics = {
  filesReviewed: number;
  issuesFound: IssuesBySeverity;
  requirementCoverage: number; // 0-100
  codeQualityScore: number; // 0-10
  toolCallsMade: number;
  cacheHits: number;
  totalComments: number;
};

export type IssuesBySeverity = {
  critical: number;
  major: number;
  minor: number;
  suggestions: number;
};

export type TokenUsage = {
  input: number;
  output: number;
  total: number;
};

// ============================================================================
// Streaming Types
// ============================================================================

export type ReviewUpdate = {
  type:
    | "tool_call"
    | "ai_thinking"
    | "comment_posted"
    | "decision"
    | "progress";
  timestamp: string;
  sessionId: string;
  data: any;
};

export type ToolCallUpdate = {
  toolName: string;
  args: any;
  result?: any;
  error?: string;
  duration?: number;
};

export type ProgressUpdate = {
  phase:
    | "context_gathering"
    | "file_analysis"
    | "decision_making"
    | "description_enhancement";
  progress: number; // 0-100
  message: string;
  currentFile?: string;
  filesProcessed?: number;
  totalFiles?: number;
};

// ============================================================================
// Session Management Types
// ============================================================================

export type ReviewSession = {
  sessionId: string;
  request: ReviewRequest;
  startTime: Date;
  endTime?: Date;
  status: "running" | "completed" | "failed";
  toolCalls: ToolCallRecord[];
  result?: ReviewResult;
  error?: Error;
  metadata: SessionMetadata;
  explorations?: ExplorationRecord[];
};

export type ToolCallRecord = {
  timestamp: Date;
  toolName: string;
  args: any;
  result: any;
  error?: string;
  duration: number;
  tokenUsage?: TokenUsage;
};

export type SessionMetadata = {
  yamaVersion: string;
  aiProvider: string;
  aiModel: string;
  totalTokens: number;
  totalCost: number;
  cacheHitRatio: number;
};

export type ExplorationRecord = {
  task: string;
  cacheKey: string;
  focus: string[];
  result: ExplorationResult;
  createdAt: Date;
  cached: boolean;
};

export type ExplorationResult = {
  task: string;
  summary: string;
  findings: ExplorationFinding[];
  evidence: ExplorationEvidence[];
  openQuestions: string[];
  recommendedNextStep: "continue_review" | "explore_more" | "avoid_commenting";
  completedAt: string;
};

export type ExplorationFinding = {
  claim: string;
  confidence: "high" | "medium" | "low";
};

export type ExplorationEvidence = {
  sourceType: "file" | "commit" | "diff" | "memory" | "rules" | "kb";
  ref: string;
  snippet?: string;
  reason: string;
};

// ============================================================================
// MCP Tool Types
// ============================================================================

export type MCPToolResponse = {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    cached?: boolean;
    duration?: number;
    source?: string;
  };
};

export type BitbucketPRDetails = {
  id: number;
  title: string;
  description: string;
  author: string;
  state: "OPEN" | "MERGED" | "DECLINED";
  sourceRef: string;
  targetRef: string;
  createdDate: string;
  updatedDate: string;
  reviewers: any[];
  comments: any[];
  fileChanges: string[];
};

// ============================================================================
// Prompt Building Types
// ============================================================================

export type PromptLayer = {
  name: string;
  priority: number;
  content: string;
  source: "base" | "config" | "project";
};

export type FocusArea = {
  name: string;
  priority: "CRITICAL" | "MAJOR" | "MINOR";
  description: string;
};

export type BlockingCriteria = {
  condition: string;
  action: "BLOCK" | "REQUEST_CHANGES" | "WARN";
  reason: string;
};

// ============================================================================
// AI Context Types
// ============================================================================

export type ToolContext = {
  sessionId: string;
  workspace: string;
  repository: string;
  pullRequestId?: number;
  branch?: string;
  dryRun: boolean;
  metadata: {
    yamaVersion: string;
    startTime: string;
  };
};

export type AIAnalysisContext = {
  prDetails: BitbucketPRDetails;
  projectStandards?: string;
  memoryBankContext?: string;
  clinerules?: string;
};

// ============================================================================
// Error Types
// ============================================================================

export class YamaError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: any,
  ) {
    super(message);
    this.name = "YamaError";
  }
}

export class MCPServerError extends YamaError {
  constructor(message: string, context?: any) {
    super("MCP_SERVER_ERROR", message, context);
    this.name = "MCPServerError";
  }
}

export class ConfigurationError extends YamaError {
  constructor(message: string, context?: any) {
    super("CONFIGURATION_ERROR", message, context);
    this.name = "ConfigurationError";
  }
}

export class ReviewTimeoutError extends YamaError {
  constructor(message: string, context?: any) {
    super("REVIEW_TIMEOUT", message, context);
    this.name = "ReviewTimeoutError";
  }
}

export class TokenBudgetExceededError extends YamaError {
  constructor(message: string, context?: any) {
    super("TOKEN_BUDGET_EXCEEDED", message, context);
    this.name = "TokenBudgetExceededError";
  }
}

// Backward-compatible alias.
export { YamaError as YamaV2Error };

// ── Review decision (moved from core/reviewDecision.ts) ─────────────────────

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED";

/** Backward-compatible alias kept for external consumers. */
export type ReviewDecisionResult = ReviewDecision;

export type DecisionPolicy = {
  /** Number of MAJOR findings at/above which an approval is downgraded. */
  majorBlockThreshold?: number;
  /**
   * True when the review loop did not run to natural completion (step cap,
   * context cap, timeout, truncated output). A partial review can block but
   * can never approve.
   */
  partial?: boolean;
};

// ── Local diff context (moved from core/LocalDiffSource.ts) ─────────────────

export type LocalDiffContext = {
  repoPath: string;
  diffSource: "staged" | "uncommitted" | "range";
  baseRef?: string;
  headRef?: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
};
