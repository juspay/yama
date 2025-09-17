/**
 * Exact Duplicate Removal Utility for Multi-Instance Processing
 * Handles deduplication of violations from multiple Neurolink SDK instances
 */

import { createHash } from "crypto";
import {
  Violation,
  DeduplicationResult,
  DeduplicationMetrics,
  InstanceResult,
  PRComment,
  CommentDeduplicationResult,
  ViolationSeverity,
  ViolationCategory,
  AIProviderConfig,
} from "../types/index.js";
import { logger } from "./Logger.js";

/**
 * Violation with source tracking for deduplication
 */
interface ViolationWithSource extends Violation {
  source: string;
  originalIndex: number;
}

/**
 * Exact Duplicate Remover for Multi-Instance Results
 * Implements multi-level deduplication strategy
 */
export class ExactDuplicateRemover {
  /**
   * Remove exact duplicates from multiple instance results
   */
  removeDuplicates(instanceResults: InstanceResult[]): DeduplicationResult {
    const startTime = Date.now();

    logger.debug("🔍 Starting exact duplicate removal process");

    // Step 1: Flatten all violations with source tracking
    const allViolations = this.flattenViolationsWithSource(instanceResults);
    logger.debug(
      `📊 Total violations from all instances: ${allViolations.length}`,
    );

    // Step 2: Remove exact hash duplicates
    const exactDuplicates = this.removeExactHashDuplicates(allViolations);
    logger.debug(`🎯 Exact duplicates removed: ${exactDuplicates.removed}`);

    // Step 3: Remove normalized duplicates
    const normalizedDuplicates = this.removeNormalizedDuplicates(
      exactDuplicates.unique,
    );
    logger.debug(
      `📝 Normalized duplicates removed: ${normalizedDuplicates.removed}`,
    );

    // Step 4: Remove same file+line duplicates
    const finalResult = this.removeSameLineDuplicates(
      normalizedDuplicates.unique,
    );
    logger.debug(`📍 Same-line duplicates removed: ${finalResult.removed}`);

    // Step 5: Track contributions and create metrics
    const instanceContributions = this.trackContributions(finalResult.unique);
    const processingTime = Date.now() - startTime;

    const metrics: DeduplicationMetrics = {
      totalViolationsInput: allViolations.length,
      exactDuplicatesRemoved: exactDuplicates.removed,
      normalizedDuplicatesRemoved: normalizedDuplicates.removed,
      sameLineDuplicatesRemoved: finalResult.removed,
      finalUniqueViolations: finalResult.unique.length,
      deduplicationRate:
        ((allViolations.length - finalResult.unique.length) /
          allViolations.length) *
        100,
      instanceContributions: Object.fromEntries(instanceContributions),
      processingTimeMs: processingTime,
    };

    logger.success(
      `✅ Deduplication completed: ${allViolations.length} → ${finalResult.unique.length} violations ` +
        `(${metrics.deduplicationRate.toFixed(1)}% reduction) in ${processingTime}ms`,
    );

    return {
      uniqueViolations: finalResult.unique.map((v) => this.stripSourceInfo(v)),
      duplicatesRemoved: {
        exactDuplicates: exactDuplicates.removed,
        normalizedDuplicates: normalizedDuplicates.removed,
        sameLineDuplicates: finalResult.removed,
      },
      instanceContributions,
      processingMetrics: metrics,
    };
  }

  /**
   * Flatten violations from all instances with source tracking
   */
  private flattenViolationsWithSource(
    instanceResults: InstanceResult[],
  ): ViolationWithSource[] {
    const allViolations: ViolationWithSource[] = [];

    for (const result of instanceResults) {
      if (!result.success || !result.violations) {
        logger.debug(`⚠️ Skipping failed instance: ${result.instanceName}`);
        continue;
      }

      result.violations.forEach((violation, index) => {
        allViolations.push({
          ...violation,
          source: result.instanceName,
          originalIndex: index,
        });
      });
    }

    return allViolations;
  }

  /**
   * Remove exact hash duplicates (Level 1)
   */
  private removeExactHashDuplicates(violations: ViolationWithSource[]): {
    unique: ViolationWithSource[];
    removed: number;
  } {
    const seenHashes = new Set<string>();
    const unique: ViolationWithSource[] = [];
    let removed = 0;

    for (const violation of violations) {
      const hash = this.createViolationHash(violation);

      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        unique.push(violation);
      } else {
        removed++;
        logger.debug(
          `🔄 Exact duplicate removed: ${violation.issue} (${violation.source})`,
        );
      }
    }

    return { unique, removed };
  }

  /**
   * Remove normalized duplicates (Level 2)
   */
  private removeNormalizedDuplicates(violations: ViolationWithSource[]): {
    unique: ViolationWithSource[];
    removed: number;
  } {
    const seenNormalizedHashes = new Set<string>();
    const unique: ViolationWithSource[] = [];
    let removed = 0;

    for (const violation of violations) {
      const normalizedHash = this.createNormalizedViolationHash(violation);

      if (!seenNormalizedHashes.has(normalizedHash)) {
        seenNormalizedHashes.add(normalizedHash);
        unique.push(violation);
      } else {
        removed++;
        logger.debug(
          `📝 Normalized duplicate removed: ${violation.issue} (${violation.source})`,
        );
      }
    }

    return { unique, removed };
  }

  /**
   * Remove same file+line duplicates (Level 3)
   */
  private removeSameLineDuplicates(violations: ViolationWithSource[]): {
    unique: ViolationWithSource[];
    removed: number;
  } {
    const fileLineMap = new Map<string, Map<string, ViolationWithSource>>();
    const uniqueMap = new Map<string, ViolationWithSource>();
    let removed = 0;

    for (const violation of violations) {
      if (!violation.file || !violation.code_snippet) {
        uniqueMap.set(
          `${violation.file}_${violation.originalIndex}`,
          violation,
        );
        continue;
      }

      const fileKey = violation.file;
      const lineKey = this.normalizeCodeSnippet(violation.code_snippet);
      const uniqueKey = `${violation.file}_${violation.originalIndex}`;

      if (!fileLineMap.has(fileKey)) {
        fileLineMap.set(fileKey, new Map());
      }

      const linesInFile = fileLineMap.get(fileKey)!;

      if (linesInFile.has(lineKey)) {
        // Duplicate found - resolve by severity and instance quality
        const existing = linesInFile.get(lineKey)!;
        const better = this.resolveDuplicateBySeverity([existing, violation]);

        if (better === violation) {
          // Replace existing with current
          linesInFile.set(lineKey, violation);
          // Remove existing from unique map and add current
          const existingKey = `${existing.file}_${existing.originalIndex}`;
          uniqueMap.delete(existingKey);
          uniqueMap.set(uniqueKey, violation);
        }

        removed++;
        logger.debug(
          `📍 Same-line duplicate resolved: ${violation.issue} (${violation.source})`,
        );
      } else {
        linesInFile.set(lineKey, violation);
        uniqueMap.set(uniqueKey, violation);
      }
    }

    return { unique: Array.from(uniqueMap.values()), removed };
  }

  /**
   * Create hash for exact violation matching
   */
  private createViolationHash(violation: Violation): string {
    const key = {
      file: violation.file?.trim(),
      code_snippet: violation.code_snippet?.trim(),
      severity: violation.severity,
      category: violation.category,
      issue: violation.issue.trim(),
      message: violation.message.trim(),
    };

    return createHash("sha256").update(JSON.stringify(key)).digest("hex");
  }

  /**
   * Create hash for normalized violation matching
   */
  private createNormalizedViolationHash(violation: Violation): string {
    const normalized = {
      file: violation.file?.toLowerCase().trim(),
      code_snippet: this.normalizeCodeSnippet(violation.code_snippet || ""),
      severity: violation.severity,
      category: violation.category,
      issue: this.normalizeText(violation.issue),
      message: this.normalizeText(violation.message),
    };

    return createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex");
  }

  /**
   * Normalize code snippet for comparison
   */
  private normalizeCodeSnippet(snippet: string): string {
    return snippet
      .replace(/\s+/g, " ") // Normalize whitespace
      .replace(/['"]/g, '"') // Normalize quotes
      .replace(/;+$/, "") // Remove trailing semicolons
      .replace(/[{}]/g, "") // Remove braces for comparison
      .trim()
      .toLowerCase();
  }

  /**
   * Normalize text for comparison
   */
  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "") // Remove punctuation
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();
  }

  /**
   * Resolve duplicate by severity (and potentially other factors)
   */
  private resolveDuplicateBySeverity(
    duplicates: ViolationWithSource[],
  ): ViolationWithSource {
    const severityOrder: Record<string, number> = {
      CRITICAL: 4,
      MAJOR: 3,
      MINOR: 2,
      SUGGESTION: 1,
    };

    return duplicates.reduce((best, current) => {
      const bestScore = severityOrder[best.severity] || 0;
      const currentScore = severityOrder[current.severity] || 0;

      if (currentScore > bestScore) {
        return current;
      } else if (currentScore === bestScore) {
        // Same severity - could add more sophisticated logic here
        // For now, prefer the first one (could be based on instance quality)
        return best;
      }

      return best;
    });
  }

  /**
   * Track which instance contributed how many violations
   */
  private trackContributions(
    violations: ViolationWithSource[],
  ): Map<string, number> {
    const contributions = new Map<string, number>();

    for (const violation of violations) {
      const current = contributions.get(violation.source) || 0;
      contributions.set(violation.source, current + 1);
    }

    return contributions;
  }

  /**
   * Remove source tracking information from violation
   */
  private stripSourceInfo(violation: ViolationWithSource): Violation {
    const { source, originalIndex, ...cleanViolation } = violation;
    return cleanViolation;
  }

  /**
   * Remove violations that duplicate existing PR comments using semantic similarity
   * Uses AI-powered ContentSimilarityService for intelligent deduplication
   */
  async removeAgainstExistingComments(
    newViolations: Violation[],
    existingComments: PRComment[],
    aiConfig: AIProviderConfig,
    similarityThreshold: number = 85,
  ): Promise<CommentDeduplicationResult> {
    const startTime = Date.now();

    logger.debug("🔍 Starting semantic comment deduplication process");
    logger.debug(
      `📊 New violations: ${newViolations.length}, Existing comments: ${existingComments.length}`,
    );
    logger.debug(`🎯 Similarity threshold: ${similarityThreshold}%`);

    if (newViolations.length === 0 || existingComments.length === 0) {
      logger.debug(
        "⏭️ No violations or comments to compare, skipping deduplication",
      );
      return {
        uniqueViolations: newViolations,
        duplicatesRemoved: 0,
        semanticMatches: [],
      };
    }

    try {
      // Use ContentSimilarityService for semantic analysis
      const { ContentSimilarityService } = await import(
        "./ContentSimilarityService.js"
      );
      const similarityService = new ContentSimilarityService(aiConfig);

      // Get similarity results
      const similarityResults =
        await similarityService.batchCalculateSimilarity(
          newViolations,
          existingComments,
          15, // batch size
        );

      // Filter violations based on similarity threshold
      const duplicateViolationIndices = new Set<number>();
      const semanticMatches: Array<{
        violation: string;
        comment: string;
        similarityScore: number;
        reasoning?: string;
      }> = [];

      for (const result of similarityResults) {
        if (result.similarityScore >= similarityThreshold) {
          duplicateViolationIndices.add(result.violationIndex);

          const violation = newViolations[result.violationIndex];
          const comment = existingComments[result.commentIndex];

          semanticMatches.push({
            violation: violation.issue,
            comment: `Comment ${comment.id}`,
            similarityScore: result.similarityScore,
            reasoning: result.reasoning,
          });

          logger.debug(
            `🎯 Semantic duplicate found: "${violation.issue}" matches comment ${comment.id} ` +
              `(${result.similarityScore}% similarity)`,
          );
        }
      }

      // Create final list of unique violations
      const uniqueViolations = newViolations.filter(
        (_, index) => !duplicateViolationIndices.has(index),
      );

      const processingTime = Date.now() - startTime;
      const duplicatesRemoved = duplicateViolationIndices.size;

      logger.success(
        `✅ Semantic deduplication completed: ${newViolations.length} → ${uniqueViolations.length} violations ` +
          `(${duplicatesRemoved} duplicates removed) in ${processingTime}ms`,
      );

      return {
        uniqueViolations,
        duplicatesRemoved,
        semanticMatches,
      };
    } catch (error) {
      logger.error(
        `❌ Semantic deduplication failed: ${(error as Error).message}`,
      );
      logger.warn(
        "⚠️ Falling back to no deduplication - returning all violations",
      );

      // Graceful fallback: return all violations if AI analysis fails
      return {
        uniqueViolations: newViolations,
        duplicatesRemoved: 0,
        semanticMatches: [],
      };
    }
  }

  /**
   * Get detailed deduplication statistics
   */
  getDeduplicationStats(result: DeduplicationResult): string {
    const metrics = result.processingMetrics;
    const contributions = Array.from(result.instanceContributions.entries())
      .map(([instance, count]) => `${instance}: ${count}`)
      .join(", ");

    return `
📊 Deduplication Statistics:
• Input violations: ${metrics.totalViolationsInput}
• Exact duplicates removed: ${metrics.exactDuplicatesRemoved}
• Normalized duplicates removed: ${metrics.normalizedDuplicatesRemoved}
• Same-line duplicates removed: ${metrics.sameLineDuplicatesRemoved}
• Final unique violations: ${metrics.finalUniqueViolations}
• Deduplication rate: ${metrics.deduplicationRate.toFixed(1)}%
• Processing time: ${metrics.processingTimeMs}ms
• Instance contributions: ${contributions}
    `.trim();
  }

  /**
   * Get detailed comment deduplication statistics
   */
  getCommentDeduplicationStats(result: CommentDeduplicationResult): string {
    const averageSimilarity =
      result.semanticMatches.length > 0
        ? result.semanticMatches.reduce(
            (sum, match) => sum + match.similarityScore,
            0,
          ) / result.semanticMatches.length
        : 0;

    return `
📊 Comment Deduplication Statistics:
• Input violations: ${result.uniqueViolations.length + result.duplicatesRemoved}
• Unique violations: ${result.uniqueViolations.length}
• Duplicates removed: ${result.duplicatesRemoved}
• Deduplication rate: ${((result.duplicatesRemoved / (result.uniqueViolations.length + result.duplicatesRemoved)) * 100).toFixed(1)}%
• Semantic matches: ${result.semanticMatches.length}
• Average similarity score: ${averageSimilarity.toFixed(1)}%
    `.trim();
  }
}

/**
 * Factory function to create ExactDuplicateRemover
 */
export function createExactDuplicateRemover(): ExactDuplicateRemover {
  return new ExactDuplicateRemover();
}
