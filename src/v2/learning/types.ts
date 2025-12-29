/**
 * Learning Types
 * Type definitions for the knowledge base and learning extraction system
 */

// ============================================================================
// Learning Categories
// ============================================================================

/**
 * Categories for extracted learnings
 * Maps to sections in the knowledge base file
 */
export type LearningCategory =
  | "false_positive" // Things AI incorrectly flagged
  | "missed_issue" // Things developer pointed out that AI missed
  | "style_preference" // Team conventions that differ from general practice
  | "domain_context" // Project-specific knowledge AI needs
  | "enhancement_guideline"; // How AI should approach suggestions

/**
 * Human-readable category names for knowledge base sections
 */
export const CATEGORY_SECTION_NAMES: Record<LearningCategory, string> = {
  false_positive: "False Positives (Don't Flag These)",
  missed_issue: "Missed Issues (Should Have Flagged)",
  style_preference: "Style Preferences (Team Conventions)",
  domain_context: "Context & Domain Knowledge",
  enhancement_guideline: "Enhancement Guidelines",
};

// ============================================================================
// Extracted Learning
// ============================================================================

/**
 * A single learning extracted from PR feedback
 */
export interface ExtractedLearning {
  /** Unique hash for deduplication */
  id: string;
  /** Category of the learning */
  category: LearningCategory;
  /** Sub-category within the section (e.g., "Async Patterns", "Security") */
  subcategory?: string;
  /** The actionable, project-level guideline */
  learning: string;
  /** File patterns where this applies (e.g., ["services/*.ts"]) */
  filePatterns?: string[];
  /** Severity for missed_issue learnings */
  severity?: string;
  /** Source info for traceability (not displayed in KB) */
  sourceInfo?: {
    prId: number;
    timestamp: string;
  };
}

// ============================================================================
// Knowledge Base Structure
// ============================================================================

/**
 * Metadata section of the knowledge base
 */
export interface KnowledgeBaseMetadata {
  lastUpdated: string;
  totalLearnings: number;
  lastSummarization?: string;
}

/**
 * A section in the knowledge base (maps to a category)
 */
export interface KnowledgeBaseSection {
  category: LearningCategory;
  subcategories: Map<string, string[]>; // subcategory -> learnings
}

/**
 * Full parsed knowledge base structure
 */
export interface KnowledgeBase {
  metadata: KnowledgeBaseMetadata;
  sections: Map<LearningCategory, KnowledgeBaseSection>;
}

// ============================================================================
// Learn Command Request/Result
// ============================================================================

/**
 * Request for the learn command
 */
export interface LearnRequest {
  workspace: string;
  repository: string;
  pullRequestId: number;
  dryRun?: boolean;
  commit?: boolean;
  summarize?: boolean;
  outputPath?: string;
  outputFormat?: "md" | "json";
}

/**
 * Result from the learn command
 */
export interface LearnResult {
  success: boolean;
  prId: number;
  learningsFound: number;
  learningsAdded: number;
  learningsDuplicate: number;
  learnings: ExtractedLearning[];
  knowledgeBasePath?: string;
  committed?: boolean;
  summarized?: boolean;
  error?: string;
}

// ============================================================================
// Comment Analysis Types
// ============================================================================

/**
 * A comment from a PR
 */
export interface PRComment {
  id: number;
  text: string;
  author: {
    name: string;
    displayName?: string;
    email?: string;
  };
  createdAt: string;
  filePath?: string;
  lineNumber?: number;
  parentId?: number; // For threaded comments
}

/**
 * A pair of AI comment and developer reply
 */
export interface CommentPair {
  aiComment: PRComment;
  developerReply: PRComment;
  filePath?: string;
  codeContext?: string;
}

// ============================================================================
// AI Extraction Types
// ============================================================================

/**
 * Output format from AI learning extraction
 */
export interface AIExtractionOutput {
  category: LearningCategory;
  subcategory?: string;
  learning: string;
  filePatterns?: string[];
  reasoning: string;
}
