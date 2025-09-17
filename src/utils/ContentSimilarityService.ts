/**
 * Content Similarity Service for Semantic Deduplication
 * Uses AI to compare violations with existing PR comments for semantic similarity
 */

import { Violation, PRComment, AIProviderConfig } from "../types/index.js";
import { logger } from "./Logger.js";

export interface SimilarityResult {
  violationIndex: number;
  commentIndex: number;
  violationId: string;
  commentId: number;
  similarityScore: number;
  reasoning?: string;
}

export interface SimilarityBatch {
  violations: Array<{
    index: number;
    id: string;
    content: string;
  }>;
  comments: Array<{
    index: number;
    id: number;
    content: string;
  }>;
}

/**
 * Service for calculating semantic similarity between violations and PR comments
 */
export class ContentSimilarityService {
  private neurolink: any;
  private aiConfig: AIProviderConfig;

  constructor(aiConfig: AIProviderConfig) {
    this.aiConfig = aiConfig;
  }

  /**
   * Calculate similarity scores between violations and comments in batches
   */
  async batchCalculateSimilarity(
    violations: Violation[],
    comments: PRComment[],
    batchSize: number = 15,
  ): Promise<SimilarityResult[]> {
    const startTime = Date.now();

    logger.debug(
      `🔍 Starting semantic similarity analysis: ${violations.length} violations vs ${comments.length} comments`,
    );

    if (violations.length === 0 || comments.length === 0) {
      logger.debug(
        "⏭️ No violations or comments to compare, skipping similarity analysis",
      );
      return [];
    }

    // Prepare violation and comment content for AI analysis
    const violationData = this.prepareViolationContent(violations);
    const commentData = this.prepareCommentContent(comments);

    logger.debug(
      `📝 Prepared ${violationData.length} violations and ${commentData.length} comments for analysis`,
    );

    // Process in batches to manage token limits
    const allResults: SimilarityResult[] = [];
    const totalBatches = Math.ceil(violations.length / batchSize);

    for (let i = 0; i < violations.length; i += batchSize) {
      const batchIndex = Math.floor(i / batchSize) + 1;
      const violationBatch = violationData.slice(i, i + batchSize);

      logger.debug(
        `🔄 Processing batch ${batchIndex}/${totalBatches} (${violationBatch.length} violations)`,
      );

      try {
        const batchResults = await this.processSimilarityBatch(
          violationBatch,
          commentData,
        );
        allResults.push(...batchResults);

        logger.debug(
          `✅ Batch ${batchIndex} completed: ${batchResults.length} similarity scores calculated`,
        );

        // Add delay between batches to avoid rate limiting
        if (batchIndex < totalBatches) {
          await this.delay(1000);
        }
      } catch (error) {
        logger.error(
          `❌ Batch ${batchIndex} failed: ${(error as Error).message}`,
        );
        // Continue with next batch instead of failing entirely
      }
    }

    const processingTime = Date.now() - startTime;
    logger.success(
      `✅ Semantic similarity analysis completed: ${allResults.length} comparisons in ${processingTime}ms`,
    );

    return allResults;
  }

  /**
   * Prepare violation content for AI analysis
   */
  private prepareViolationContent(violations: Violation[]): Array<{
    index: number;
    id: string;
    content: string;
  }> {
    return violations.map((violation, index) => ({
      index,
      id: `violation_${index}`,
      content: this.extractViolationContent(violation),
    }));
  }

  /**
   * Prepare comment content for AI analysis
   */
  private prepareCommentContent(comments: PRComment[]): Array<{
    index: number;
    id: number;
    content: string;
  }> {
    return comments.map((comment, index) => ({
      index,
      id: comment.id,
      content: this.extractCommentContent(comment),
    }));
  }

  /**
   * Extract meaningful content from violation for comparison
   */
  private extractViolationContent(violation: Violation): string {
    const parts = [
      `Issue: ${violation.issue}`,
      `Message: ${violation.message}`,
      violation.file ? `File: ${violation.file}` : "",
      violation.code_snippet ? `Code: ${violation.code_snippet}` : "",
      `Severity: ${violation.severity}`,
      `Category: ${violation.category}`,
    ].filter(Boolean);

    return parts.join(" | ");
  }

  /**
   * Extract meaningful content from comment for comparison
   */
  private extractCommentContent(comment: PRComment): string {
    const parts = [
      `Comment: ${comment.text}`,
      comment.anchor?.filePath ? `File: ${comment.anchor.filePath}` : "",
      `Author: ${comment.author.displayName || comment.author.name}`,
    ].filter(Boolean);

    return parts.join(" | ");
  }

  /**
   * Process a single batch of violations against all comments
   */
  private async processSimilarityBatch(
    violationBatch: Array<{ index: number; id: string; content: string }>,
    commentData: Array<{ index: number; id: number; content: string }>,
  ): Promise<SimilarityResult[]> {
    const prompt = this.createSimilarityPrompt(violationBatch, commentData);

    try {
      // Initialize NeuroLink if not already done
      if (!this.neurolink) {
        const { NeuroLink } = await import("@juspay/neurolink");
        this.neurolink = new NeuroLink();
      }

      // Use NeuroLink for AI analysis
      const result = await this.neurolink.generate({
        input: { text: prompt },
        systemPrompt:
          "You are an expert code reviewer analyzing semantic similarity between violations and comments. Provide accurate similarity scores based on content analysis.",
        provider: this.aiConfig.provider || "auto",
        model: this.aiConfig.model || "best",
        temperature: 0.1, // Low temperature for consistent similarity scoring
        maxTokens: this.aiConfig.maxTokens || 4000,
        timeout: "5m",
        enableAnalytics: this.aiConfig.enableAnalytics || false,
        enableEvaluation: false,
      });

      return this.parseSimilarityResponse(
        result.content,
        violationBatch,
        commentData,
      );
    } catch (error) {
      logger.error(
        `Failed to process similarity batch: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Create AI prompt for similarity analysis
   */
  private createSimilarityPrompt(
    violations: Array<{ index: number; id: string; content: string }>,
    comments: Array<{ index: number; id: number; content: string }>,
  ): string {
    const violationList = violations
      .map((v, i) => `${i + 1}. ${v.content}`)
      .join("\n");

    const commentList = comments
      .map(
        (c, i) =>
          `${i + 1}. ${c.content.substring(0, 300)}${c.content.length > 300 ? "..." : ""}`,
      )
      .join("\n");

    return `
Analyze the semantic similarity between these code review violations and existing PR comments.

NEW VIOLATIONS TO CHECK:
${violationList}

EXISTING PR COMMENTS:
${commentList}

For each violation, determine if it's semantically similar to any existing comment. Consider:
- Same or similar issues being reported
- Same file or code area being discussed
- Similar concerns or suggestions
- Related security, performance, or code quality topics

Return a JSON array with similarity scores (0-100) for each violation-comment pair that has meaningful similarity (score >= 70).

Format: [{"violation": 1, "comment": 2, "score": 85, "reasoning": "Both discuss the same security vulnerability in authentication"}, ...]

Only include pairs with scores >= 70. If no meaningful similarities exist, return an empty array [].
`.trim();
  }

  /**
   * Parse AI response to extract similarity results
   */
  private parseSimilarityResponse(
    response: string,
    violationBatch: Array<{ index: number; id: string; content: string }>,
    commentData: Array<{ index: number; id: number; content: string }>,
  ): SimilarityResult[] {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.debug(
          "No JSON array found in AI response, assuming no similarities",
        );
        return [];
      }

      const similarities = JSON.parse(jsonMatch[0]);
      const results: SimilarityResult[] = [];

      for (const similarity of similarities) {
        const violationIndex = similarity.violation - 1; // Convert from 1-based to 0-based
        const commentIndex = similarity.comment - 1;

        if (
          violationIndex >= 0 &&
          violationIndex < violationBatch.length &&
          commentIndex >= 0 &&
          commentIndex < commentData.length
        ) {
          const violation = violationBatch[violationIndex];
          const comment = commentData[commentIndex];

          results.push({
            violationIndex: violation.index,
            commentIndex: comment.index,
            violationId: violation.id,
            commentId: comment.id,
            similarityScore: similarity.score,
            reasoning: similarity.reasoning,
          });
        }
      }

      logger.debug(
        `📊 Parsed ${results.length} similarity results from AI response`,
      );
      return results;
    } catch (error) {
      logger.error(
        `Failed to parse similarity response: ${(error as Error).message}`,
      );
      logger.debug(`Raw response: ${response}`);
      return [];
    }
  }

  /**
   * Simple delay utility for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Factory function to create ContentSimilarityService
 */
export function createContentSimilarityService(
  aiConfig: AIProviderConfig,
): ContentSimilarityService {
  return new ContentSimilarityService(aiConfig);
}
