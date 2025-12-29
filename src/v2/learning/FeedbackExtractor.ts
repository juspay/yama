/**
 * Feedback Extractor
 * Identifies AI comments and developer replies from PR comments
 */

import { KnowledgeBaseConfig } from "../types/config.types.js";
import { PRComment, CommentPair } from "./types.js";

/**
 * Text patterns that identify AI-generated comments
 */
const AI_TEXT_PATTERNS = [
  "🔒 CRITICAL",
  "⚠️ MAJOR",
  "💡 MINOR",
  "💬 SUGGESTION",
  "**Issue**:",
  "**Impact**:",
  "**Fix**:",
  "Yama Review",
  "_Review powered by Yama_",
  "🔒 SECURITY",
  "⚡ PERFORMANCE",
];

export class FeedbackExtractor {
  private config: KnowledgeBaseConfig;

  constructor(config: KnowledgeBaseConfig) {
    this.config = config;
  }

  /**
   * Check if a comment is from AI based on author and text patterns
   */
  isAIComment(comment: PRComment): boolean {
    // Check author name patterns
    const authorMatch = this.config.aiAuthorPatterns.some((pattern) =>
      comment.author.name.toLowerCase().includes(pattern.toLowerCase()),
    );

    if (authorMatch) {
      return true;
    }

    // Check text patterns
    const textMatch = AI_TEXT_PATTERNS.some((pattern) =>
      comment.text.includes(pattern),
    );

    return textMatch;
  }

  /**
   * Check if a comment is a developer reply (not from AI)
   */
  isDeveloperComment(comment: PRComment): boolean {
    return !this.isAIComment(comment);
  }

  /**
   * Extract AI comment + developer reply pairs from a list of comments
   */
  extractCommentPairs(comments: PRComment[]): CommentPair[] {
    const pairs: CommentPair[] = [];

    // Group comments by parent (for threaded comments)
    const commentsByParent = new Map<number | undefined, PRComment[]>();
    const commentById = new Map<number, PRComment>();

    for (const comment of comments) {
      commentById.set(comment.id, comment);

      const parentKey = comment.parentId;
      if (!commentsByParent.has(parentKey)) {
        commentsByParent.set(parentKey, []);
      }
      commentsByParent.get(parentKey)!.push(comment);
    }

    // Find AI comments with developer replies
    for (const comment of comments) {
      if (this.isAIComment(comment)) {
        // Look for developer replies to this AI comment
        const replies = commentsByParent.get(comment.id) || [];
        const developerReplies = replies.filter((r) =>
          this.isDeveloperComment(r),
        );

        for (const reply of developerReplies) {
          pairs.push({
            aiComment: comment,
            developerReply: reply,
            filePath: comment.filePath || reply.filePath,
          });
        }
      }
    }

    // Also check for inline comment threads (adjacent comments on same file/line)
    const inlinePairs = this.findInlineCommentPairs(comments);
    pairs.push(...inlinePairs);

    return pairs;
  }

  /**
   * Find comment pairs based on file/line proximity (for inline comments)
   */
  private findInlineCommentPairs(comments: PRComment[]): CommentPair[] {
    const pairs: CommentPair[] = [];
    const processedIds = new Set<number>();

    // Group by file path and line
    const byLocation = new Map<string, PRComment[]>();

    for (const comment of comments) {
      if (comment.filePath && comment.lineNumber) {
        const key = `${comment.filePath}:${comment.lineNumber}`;
        if (!byLocation.has(key)) {
          byLocation.set(key, []);
        }
        byLocation.get(key)!.push(comment);
      }
    }

    // Find AI + developer pairs at same location
    for (const [, locationComments] of byLocation) {
      // Sort by timestamp
      locationComments.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      for (let i = 0; i < locationComments.length; i++) {
        const aiComment = locationComments[i];

        if (!this.isAIComment(aiComment) || processedIds.has(aiComment.id)) {
          continue;
        }

        // Look for developer reply after this AI comment
        for (let j = i + 1; j < locationComments.length; j++) {
          const reply = locationComments[j];

          if (this.isDeveloperComment(reply) && !processedIds.has(reply.id)) {
            pairs.push({
              aiComment,
              developerReply: reply,
              filePath: aiComment.filePath,
            });
            processedIds.add(aiComment.id);
            processedIds.add(reply.id);
            break;
          }
        }
      }
    }

    return pairs;
  }

  /**
   * Convert raw Bitbucket API comment to PRComment
   */
  convertBitbucketComment(rawComment: Record<string, unknown>): PRComment {
    const author = rawComment.author as Record<string, unknown> | undefined;
    const user = rawComment.user as Record<string, unknown> | undefined;
    const authorData = author || user;

    // Handle text extraction - Bitbucket Cloud uses content.raw
    let text = rawComment.text as string | undefined;
    if (!text) {
      const content = rawComment.content;
      if (typeof content === "string") {
        text = content;
      } else if (content && typeof content === "object" && "raw" in content) {
        text = (content as { raw?: string }).raw;
      }
    }

    return {
      id:
        (rawComment.id as number) ||
        parseInt(String(rawComment.id), 10) ||
        Date.now(),
      text: text || "",
      author: {
        name:
          (authorData?.name as string) ||
          (authorData?.username as string) ||
          (authorData?.slug as string) ||
          "Unknown",
        displayName: authorData?.displayName as string | undefined,
        email: authorData?.emailAddress as string | undefined,
      },
      createdAt:
        (rawComment.createdDate as string) ||
        (rawComment.created_on as string) ||
        new Date().toISOString(),
      filePath:
        (rawComment.path as string) ||
        (
          rawComment.inline as {
            path?: string;
          }
        )?.path,
      lineNumber:
        (rawComment.line as number) ||
        (
          rawComment.inline as {
            to?: number;
          }
        )?.to,
      parentId:
        (
          rawComment.parent as {
            id?: number;
          }
        )?.id || undefined,
    };
  }

  /**
   * Extract meaningful feedback from a comment pair
   * Determines if the developer reply contains actionable feedback
   */
  hasActionableFeedback(pair: CommentPair): boolean {
    const reply = pair.developerReply.text.toLowerCase();

    // Skip very short replies (likely just acknowledgments like "ok" or "done")
    if (reply.length < 20) {
      return false;
    }

    // Skip pure acknowledgments
    const acknowledgments = [
      "fixed",
      "done",
      "ok",
      "thanks",
      "thank you",
      "will do",
      "good catch",
      "nice catch",
      "👍",
      "✅",
    ];

    const isJustAcknowledgment = acknowledgments.some(
      (ack) => reply.trim() === ack || reply.trim() === ack + ".",
    );

    if (isJustAcknowledgment) {
      return false;
    }

    // Look for indicators of substantive feedback
    const feedbackIndicators = [
      "actually",
      "but",
      "however",
      "not necessary",
      "don't need",
      "intentional",
      "by design",
      "we prefer",
      "our convention",
      "team decision",
      "won't fix",
      "false positive",
      "not an issue",
      "this is fine",
      "this is okay",
      "that's expected",
      "that's intentional",
      "on purpose",
      "should also",
      "you missed",
      "also check",
      "what about",
      "consider",
    ];

    return feedbackIndicators.some((indicator) => reply.includes(indicator));
  }

  /**
   * Get statistics about comment analysis
   */
  getCommentStats(comments: PRComment[]): {
    total: number;
    aiComments: number;
    developerComments: number;
    pairs: number;
    actionablePairs: number;
  } {
    const pairs = this.extractCommentPairs(comments);
    const actionablePairs = pairs.filter((p) => this.hasActionableFeedback(p));

    return {
      total: comments.length,
      aiComments: comments.filter((c) => this.isAIComment(c)).length,
      developerComments: comments.filter((c) => this.isDeveloperComment(c))
        .length,
      pairs: pairs.length,
      actionablePairs: actionablePairs.length,
    };
  }
}
