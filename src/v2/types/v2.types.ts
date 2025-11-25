/**
 * Yama V2 TypeScript Type Definitions
 * AI-Native MCP Architecture Types
 */

// ============================================================================
// Review Request & Response Types
// ============================================================================

export interface ReviewRequest {
  workspace: string;
  repository: string;
  pullRequestId?: number;
  branch?: string;
  dryRun?: boolean;
  verbose?: boolean;
  configPath?: string;
}

export interface ReviewResult {
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
}

export interface ReviewStatistics {
  filesReviewed: number;
  issuesFound: IssuesBySeverity;
  requirementCoverage: number; // 0-100
  codeQualityScore: number; // 0-10
  toolCallsMade: number;
  cacheHits: number;
  totalComments: number;
}

export interface IssuesBySeverity {
  critical: number;
  major: number;
  minor: number;
  suggestions: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

// ============================================================================
// Streaming Types
// ============================================================================

export interface ReviewUpdate {
  type:
    | "tool_call"
    | "ai_thinking"
    | "comment_posted"
    | "decision"
    | "progress";
  timestamp: string;
  sessionId: string;
  data: any;
}

export interface ToolCallUpdate {
  toolName: string;
  args: any;
  result?: any;
  error?: string;
  duration?: number;
}

export interface ProgressUpdate {
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
}

// ============================================================================
// Session Management Types
// ============================================================================

export interface ReviewSession {
  sessionId: string;
  request: ReviewRequest;
  startTime: Date;
  endTime?: Date;
  status: "running" | "completed" | "failed";
  toolCalls: ToolCallRecord[];
  result?: ReviewResult;
  error?: Error;
  metadata: SessionMetadata;
}

export interface ToolCallRecord {
  timestamp: Date;
  toolName: string;
  args: any;
  result: any;
  error?: string;
  duration: number;
  tokenUsage?: TokenUsage;
}

export interface SessionMetadata {
  yamaVersion: string;
  aiProvider: string;
  aiModel: string;
  totalTokens: number;
  totalCost: number;
  cacheHitRatio: number;
}

// ============================================================================
// MCP Tool Types
// ============================================================================

export interface MCPToolResponse {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    cached?: boolean;
    duration?: number;
    source?: string;
  };
}

export interface BitbucketPRDetails {
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
}

export interface JiraTicketDetails {
  key: string;
  summary: string;
  description: string;
  status: string;
  acceptanceCriteria?: string;
  requirements?: string[];
  issueType: string;
  priority: string;
}

// ============================================================================
// Prompt Building Types
// ============================================================================

export interface PromptLayer {
  name: string;
  priority: number;
  content: string;
  source: "base" | "config" | "project";
}

export interface FocusArea {
  name: string;
  priority: "CRITICAL" | "MAJOR" | "MINOR";
  description: string;
}

export interface BlockingCriteria {
  condition: string;
  action: "BLOCK" | "REQUEST_CHANGES" | "WARN";
  reason: string;
}

// ============================================================================
// AI Context Types
// ============================================================================

export interface ToolContext {
  sessionId: string;
  workspace: string;
  repository: string;
  pullRequestId?: number;
  branch?: string;
  dryRun: boolean;
  metadata: {
    yamaVersion: string;
    startTime: string;
    jiraTicket?: string;
  };
}

export interface AIAnalysisContext {
  prDetails: BitbucketPRDetails;
  jiraTicket?: JiraTicketDetails;
  projectStandards?: string;
  memoryBankContext?: string;
  clinerules?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export class YamaV2Error extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: any,
  ) {
    super(message);
    this.name = "YamaV2Error";
  }
}

export class MCPServerError extends YamaV2Error {
  constructor(message: string, context?: any) {
    super("MCP_SERVER_ERROR", message, context);
    this.name = "MCPServerError";
  }
}

export class ConfigurationError extends YamaV2Error {
  constructor(message: string, context?: any) {
    super("CONFIGURATION_ERROR", message, context);
    this.name = "ConfigurationError";
  }
}

export class ReviewTimeoutError extends YamaV2Error {
  constructor(message: string, context?: any) {
    super("REVIEW_TIMEOUT", message, context);
    this.name = "ReviewTimeoutError";
  }
}

export class TokenBudgetExceededError extends YamaV2Error {
  constructor(message: string, context?: any) {
    super("TOKEN_BUDGET_EXCEEDED", message, context);
    this.name = "TokenBudgetExceededError";
  }
}
