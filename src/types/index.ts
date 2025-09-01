/**
 * Core TypeScript types for Yama
 * Consolidates all interfaces and types used across the application
 */

// ============================================================================
// AI Provider Types (NeuroLink Integration)
// ============================================================================

export interface AIProviderConfig {
  provider?:
    | "auto"
    | "google-ai"
    | "openai"
    | "anthropic"
    | "azure"
    | "bedrock";
  model?: string;
  enableFallback?: boolean;
  enableAnalytics?: boolean;
  enableEvaluation?: boolean;
  timeout?: string | number;
  temperature?: number;
  maxTokens?: number;
  retryAttempts?: number;
}

export interface AIResponse {
  content: string;
  provider: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  responseTime?: number;
  analytics?: AnalyticsData;
  evaluation?: EvaluationData;
}

export interface AnalyticsData {
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseTime: number;
  cost?: number;
}

export interface EvaluationData {
  overallScore: number;
  qualityMetrics: {
    relevance: number;
    accuracy: number;
    completeness: number;
    clarity: number;
  };
  confidence: number;
}

// ============================================================================
// Git Platform Types
// ============================================================================

export type GitPlatform = "bitbucket" | "github" | "gitlab" | "azure-devops";

export interface GitCredentials {
  username: string;
  token: string;
  baseUrl?: string;
}

export interface GitProviderConfig {
  platform: GitPlatform;
  credentials: GitCredentials;
  defaultWorkspace?: string;
}

// ============================================================================
// Pull Request Types
// ============================================================================

export interface PRIdentifier {
  workspace: string;
  repository: string;
  branch?: string;
  pullRequestId?: number | string;
}

export interface PRInfo {
  id: number | string;
  title: string;
  description: string;
  author: string;
  state: "OPEN" | "MERGED" | "DECLINED" | "CLOSED";
  sourceRef: string;
  targetRef: string;
  createdDate: string;
  updatedDate: string;
  reviewers?: PRReviewer[];
  comments?: PRComment[];
  fileChanges?: string[];
}

export interface PRReviewer {
  user: {
    name: string;
    emailAddress: string;
    displayName: string;
  };
  approved: boolean;
  status: "APPROVED" | "UNAPPROVED" | "NEEDS_WORK";
}

export interface PRComment {
  id: number;
  text: string;
  author: {
    name: string;
    displayName: string;
  };
  createdDate: string;
  updatedDate: string;
  anchor?: {
    filePath: string;
    lineFrom: number;
    lineTo: number;
    lineType: "ADDED" | "REMOVED" | "CONTEXT";
  };
}

export interface PRDiff {
  diff: string;
  fileChanges: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface FileChange {
  path: string;
  changeType: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "added" | "removed" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

// ============================================================================
// Code Review Types (Enhanced from pr-police.js)
// ============================================================================

export type ViolationSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";
export type ViolationType = "inline" | "general";
export type ViolationCategory =
  | "security"
  | "performance"
  | "maintainability"
  | "functionality"
  | "error_handling"
  | "testing"
  | "general";

export interface Violation {
  type: ViolationType;
  file?: string;
  code_snippet?: string;
  search_context?: {
    before: string[];
    after: string[];
  };
  line_type?: "ADDED" | "REMOVED" | "CONTEXT";
  severity: ViolationSeverity;
  category: ViolationCategory;
  issue: string;
  message: string;
  impact: string;
  suggestion?: string;
}

export interface ReviewResult {
  violations: Violation[];
  summary: string;
  improvementsSinceLast?: string;
  positiveObservations: string[];
  statistics: ReviewStatistics;
}

export interface ReviewStatistics {
  filesReviewed: number;
  totalIssues: number;
  criticalCount: number;
  majorCount: number;
  minorCount: number;
  suggestionCount: number;
  batchCount?: number;
  processingStrategy?: "single-request" | "batch-processing";
  averageBatchSize?: number;
  totalProcessingTime?: number;
}

export interface FileBatch {
  files: string[];
  priority: "high" | "medium" | "low";
  estimatedTokens: number;
  batchIndex: number;
}

export interface BatchResult {
  batchIndex: number;
  files: string[];
  violations: Violation[];
  processingTime: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  error?: string;
}

export type FilePriority = "high" | "medium" | "low";

export interface PrioritizedFile {
  path: string;
  priority: FilePriority;
  estimatedTokens: number;
  diff?: string;
}

export interface ReviewOptions {
  workspace: string;
  repository: string;
  branch?: string;
  pullRequestId?: number | string;
  dryRun?: boolean;
  verbose?: boolean;
  excludePatterns?: string[];
  customRules?: string;
  contextLines?: number;
}

// ============================================================================
// Description Enhancement Types (Enhanced from pr-describe.js)
// ============================================================================

export interface RequiredSection {
  key: string;
  name: string;
  required: boolean;
  present?: boolean;
  content?: string;
}

export interface PreservableContent {
  media: string[];
  files: string[];
  links: string[];
  originalText: string;
}

export interface SectionAnalysis {
  requiredSections: RequiredSection[];
  missingCount: number;
  preservedContent: PreservableContent;
  gaps: string[];
}

export interface EnhancementOptions {
  workspace: string;
  repository: string;
  branch?: string;
  pullRequestId?: number | string;
  dryRun?: boolean;
  verbose?: boolean;
  preserveContent?: boolean;
  ensureRequiredSections?: boolean;
  customSections?: RequiredSection[];
}

export interface EnhancementResult {
  originalDescription: string;
  enhancedDescription: string;
  sectionsAdded: string[];
  sectionsEnhanced: string[];
  preservedItems: {
    media: number;
    files: number;
    links: number;
  };
  statistics: {
    originalLength: number;
    enhancedLength: number;
    completedSections: number;
    totalSections: number;
  };
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface GuardianConfig {
  providers: {
    ai: AIProviderConfig;
    git: GitProviderConfig;
  };
  features: {
    codeReview: CodeReviewConfig;
    descriptionEnhancement: DescriptionEnhancementConfig;
    diffStrategy?: DiffStrategyConfig;
    securityScan?: SecurityScanConfig;
    analytics?: AnalyticsConfig;
  };
  memoryBank?: MemoryBankConfig;
  cache?: CacheConfig;
  performance?: PerformanceConfig;
  rules?: CustomRulesConfig;
  reporting?: ReportingConfig;
  monitoring?: MonitoringConfig;
}

export interface CodeReviewConfig {
  enabled: boolean;
  severityLevels: ViolationSeverity[];
  categories: ViolationCategory[];
  excludePatterns: string[];
  contextLines: number;
  customRules?: string;
  systemPrompt?: string;
  analysisTemplate?: string;
  focusAreas?: string[];
  batchProcessing?: BatchProcessingConfig;
}

export interface BatchProcessingConfig {
  enabled: boolean;
  maxFilesPerBatch: number;
  prioritizeSecurityFiles: boolean;
  parallelBatches: boolean;
  batchDelayMs: number;
  singleRequestThreshold: number; // Files count threshold for single request
}

export interface DescriptionEnhancementConfig {
  enabled: boolean;
  preserveContent: boolean;
  requiredSections: RequiredSection[];
  autoFormat: boolean;
  systemPrompt?: string;
  outputTemplate?: string;
  enhancementInstructions?: string;
}

export interface DiffStrategyConfig {
  enabled: boolean;
  thresholds: {
    wholeDiffMaxFiles: number; // Default: 2
    fileByFileMinFiles: number; // Default: 3
  };
  forceStrategy?: "whole" | "file-by-file" | "auto"; // Override to force a specific strategy
}

export interface SecurityScanConfig {
  enabled: boolean;
  level: "strict" | "moderate" | "basic";
  scanTypes: string[];
}

export interface AnalyticsConfig {
  enabled: boolean;
  trackMetrics: boolean;
  exportFormat: "json" | "csv" | "yaml";
}

export interface MemoryBankConfig {
  enabled: boolean;
  path: string;
  fallbackPaths?: string[];
}

export interface CacheConfig {
  enabled: boolean;
  ttl: string;
  maxSize: string;
  storage: "memory" | "redis" | "file";
}

export interface PerformanceConfig {
  batch: {
    enabled: boolean;
    maxConcurrent: number;
    delayBetween: string;
  };
  optimization: {
    reuseConnections: boolean;
    compressRequests: boolean;
    enableHttp2: boolean;
  };
}

export interface CustomRulesConfig {
  [category: string]: CustomRule[];
}

export interface CustomRule {
  name: string;
  pattern: string;
  severity: ViolationSeverity;
  message?: string;
  suggestion?: string;
}

export interface ReportingConfig {
  formats: string[];
  includeAnalytics: boolean;
  includeMetrics: boolean;
  customTemplates?: string;
}

export interface MonitoringConfig {
  enabled: boolean;
  metrics: string[];
  exportFormat?: "json" | "prometheus" | "csv";
  endpoint?: string;
  interval?: string;
}

// ============================================================================
// Operation Types
// ============================================================================

export type OperationType =
  | "review"
  | "enhance-description"
  | "security-scan"
  | "analytics"
  | "all";

export interface OperationOptions {
  workspace: string;
  repository: string;
  branch?: string;
  pullRequestId?: number | string;
  operations: OperationType[];
  dryRun?: boolean;
  verbose?: boolean;
  config?: Partial<GuardianConfig>;
}

export interface OperationResult {
  operation: OperationType;
  status: "success" | "error" | "skipped";
  data?: any;
  error?: string;
  duration: number;
  timestamp: string;
}

export interface ProcessResult {
  pullRequest: PRInfo;
  operations: OperationResult[];
  summary: {
    totalOperations: number;
    successCount: number;
    errorCount: number;
    skippedCount: number;
    totalDuration: number;
  };
}

// ============================================================================
// Streaming Types
// ============================================================================

export interface StreamUpdate {
  operation: OperationType;
  status: "started" | "progress" | "completed" | "error";
  progress?: number;
  message?: string;
  data?: any;
  timestamp: string;
}

export interface StreamOptions {
  onUpdate?: (update: StreamUpdate) => void;
  onError?: (error: Error) => void;
  onComplete?: (result: ProcessResult) => void;
}

// ============================================================================
// Logger Types
// ============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  level: LogLevel;
  verbose: boolean;
  format: "simple" | "json" | "detailed";
  colors: boolean;
}

export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  badge(): void;
  phase(message: string): void;
  success(message: string): void;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry<T = any> {
  key: string;
  value: T;
  ttl: number;
  createdAt: number;
}

export interface CacheOptions {
  ttl?: number;
  maxSize?: number;
  checkPeriod?: number;
}

export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttl?: number): boolean;
  del(key: string): number;
  has(key: string): boolean;
  clear(): void;
  keys(): string[];
  stats(): {
    hits: number;
    misses: number;
    keys: number;
    size: number;
  };
}

// ============================================================================
// Error Types
// ============================================================================

export class GuardianError extends Error {
  constructor(
    public code: string,
    message: string,
    public context?: any,
  ) {
    super(message);
    this.name = "GuardianError";
  }
}

export class ConfigurationError extends GuardianError {
  constructor(message: string, context?: any) {
    super("CONFIGURATION_ERROR", message, context);
    this.name = "ConfigurationError";
  }
}

export class ProviderError extends GuardianError {
  constructor(message: string, context?: any) {
    super("PROVIDER_ERROR", message, context);
    this.name = "ProviderError";
  }
}

export class ValidationError extends GuardianError {
  constructor(message: string, context?: any) {
    super("VALIDATION_ERROR", message, context);
    this.name = "ValidationError";
  }
}

// ============================================================================
// Export all types - Main file, no re-exports needed
// ============================================================================
