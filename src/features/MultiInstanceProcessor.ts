/**
 * Multi-Instance Processor for Parallel Code Review
 * Orchestrates multiple Neurolink SDK instances for diverse code analysis
 */

import {
  MultiInstanceConfig,
  InstanceConfig,
  InstanceResult,
  MultiInstanceResult,
  AIProviderConfig,
  CodeReviewConfig,
  ReviewOptions,
  Violation,
  ReviewResult,
} from "../types/index.js";
import { UnifiedContext } from "../core/ContextGatherer.js";
import { BitbucketProvider } from "../core/providers/BitbucketProvider.js";
import { CodeReviewer, createCodeReviewer } from "./CodeReviewer.js";
import {
  ExactDuplicateRemover,
  createExactDuplicateRemover,
} from "../utils/ExactDuplicateRemover.js";
import {
  Semaphore,
  TokenBudgetManager,
  calculateOptimalConcurrency,
} from "../utils/ParallelProcessing.js";
import { getProviderTokenLimit } from "../utils/ProviderLimits.js";
import { logger } from "../utils/Logger.js";

/**
 * Multi-Instance Processor
 * Manages parallel execution of multiple CodeReviewer instances
 */
export class MultiInstanceProcessor {
  private bitbucketProvider: BitbucketProvider;
  private baseReviewConfig: CodeReviewConfig;
  private duplicateRemover: ExactDuplicateRemover;

  constructor(
    bitbucketProvider: BitbucketProvider,
    baseReviewConfig: CodeReviewConfig,
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.baseReviewConfig = baseReviewConfig;
    this.duplicateRemover = createExactDuplicateRemover();
  }

  /**
   * Process code review using multiple instances
   */
  async processWithMultipleInstances(
    context: UnifiedContext,
    options: ReviewOptions,
    multiInstanceConfig: MultiInstanceConfig,
  ): Promise<MultiInstanceResult> {
    const startTime = Date.now();

    try {
      logger.phase("🚀 Starting multi-instance code review processing");
      logger.info(
        `🔄 Launching ${multiInstanceConfig.instanceCount} instances: ${multiInstanceConfig.instances.map((i) => i.name).join(", ")}`,
      );

      // Step 1: Validate configuration
      this.validateMultiInstanceConfig(multiInstanceConfig);

      // Step 2: Execute instances in parallel
      const instanceResults = await this.executeInstancesInParallel(
        context,
        options,
        multiInstanceConfig,
      );

      // Step 3: Deduplicate results
      const deduplicationResult = multiInstanceConfig.deduplication.enabled
        ? this.duplicateRemover.removeDuplicates(instanceResults)
        : this.createNonDeduplicatedResult(instanceResults);

      // Step 4: Apply final filtering if configured
      const finalViolations = this.applyFinalFiltering(
        deduplicationResult.uniqueViolations,
        multiInstanceConfig.deduplication,
      );

      // Step 5: Create summary
      const totalProcessingTime = Date.now() - startTime;
      const summary = this.createSummary(
        instanceResults,
        deduplicationResult,
        finalViolations,
        totalProcessingTime,
      );

      logger.success(
        `✅ Multi-instance processing completed: ${summary.totalViolationsFound} → ${summary.uniqueViolationsAfterDedup} violations ` +
          `(${summary.deduplicationRate.toFixed(1)}% reduction) in ${Math.round(totalProcessingTime / 1000)}s`,
      );

      // Step 6: Log detailed statistics
      if (logger.getConfig().verbose) {
        logger.info(
          this.duplicateRemover.getDeduplicationStats(deduplicationResult),
        );
      }

      return {
        instances: instanceResults,
        deduplication: deduplicationResult,
        finalViolations,
        summary,
      };
    } catch (error) {
      logger.error(
        `Multi-instance processing failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Execute all instances in parallel with concurrency control
   */
  private async executeInstancesInParallel(
    context: UnifiedContext,
    options: ReviewOptions,
    multiInstanceConfig: MultiInstanceConfig,
  ): Promise<InstanceResult[]> {
    const instances = multiInstanceConfig.instances;

    // Calculate optimal concurrency
    const avgTokensPerInstance = this.estimateTokensPerInstance(context);
    const totalTokenBudget = this.calculateTotalTokenBudget(instances);
    const optimalConcurrency = calculateOptimalConcurrency(
      instances.length,
      Math.min(instances.length, 3), // Max 3 concurrent instances by default
      avgTokensPerInstance,
      totalTokenBudget,
    );

    // Initialize concurrency control
    const semaphore = new Semaphore(optimalConcurrency);
    const tokenBudget = new TokenBudgetManager(totalTokenBudget);

    logger.info(
      `🎯 Parallel execution: ${optimalConcurrency} concurrent instances, ${totalTokenBudget} total token budget`,
    );

    // Execute instances with controlled concurrency
    const instancePromises = instances.map((instanceConfig, index) =>
      this.executeInstanceWithConcurrency(
        instanceConfig,
        context,
        options,
        semaphore,
        tokenBudget,
        index,
        instances.length,
      ),
    );

    // Wait for all instances to complete
    const results = await Promise.allSettled(instancePromises);

    // Process results and handle failures
    const instanceResults: InstanceResult[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const instanceConfig = instances[i];

      if (result.status === "fulfilled") {
        instanceResults.push(result.value);
      } else {
        logger.error(
          `❌ Instance ${instanceConfig.name} failed: ${result.reason.message}`,
        );
        instanceResults.push({
          instanceName: instanceConfig.name,
          violations: [],
          processingTime: 0,
          error: result.reason.message,
          success: false,
        });
      }
    }

    return instanceResults;
  }

  /**
   * Execute a single instance with concurrency control
   */
  private async executeInstanceWithConcurrency(
    instanceConfig: InstanceConfig,
    context: UnifiedContext,
    options: ReviewOptions,
    semaphore: Semaphore,
    tokenBudget: TokenBudgetManager,
    instanceIndex: number,
    totalInstances: number,
  ): Promise<InstanceResult> {
    // Acquire semaphore permit
    await semaphore.acquire();

    try {
      const estimatedTokens = this.estimateTokensPerInstance(context);

      // Check token budget
      if (!tokenBudget.allocateForBatch(instanceIndex, estimatedTokens)) {
        throw new Error(
          `Insufficient token budget for instance ${instanceConfig.name}`,
        );
      }

      logger.info(
        `🔄 Processing instance ${instanceIndex + 1}/${totalInstances}: ${instanceConfig.name} ` +
          `(${instanceConfig.provider}, temp: ${instanceConfig.temperature || "default"})`,
      );

      // Execute the instance
      const result = await this.executeInstance(
        instanceConfig,
        context,
        options,
      );

      logger.info(
        `✅ Instance ${instanceConfig.name} completed: ${result.violations.length} violations ` +
          `in ${Math.round(result.processingTime / 1000)}s`,
      );

      return result;
    } finally {
      // Always release resources
      tokenBudget.releaseBatch(instanceIndex);
      semaphore.release();
    }
  }

  /**
   * Validate provider string against allowed provider types
   */
  private validateProvider(provider: string): AIProviderConfig["provider"] {
    const validProviders = [
      "auto",
      "google-ai",
      "openai",
      "anthropic",
      "azure",
      "bedrock",
      "vertex",
    ];
    if (!validProviders.includes(provider)) {
      logger.warn(`Unknown provider '${provider}', falling back to 'auto'`);
      return "auto";
    }
    return provider as AIProviderConfig["provider"];
  }

  /**
   * Execute a single instance
   */
  private async executeInstance(
    instanceConfig: InstanceConfig,
    context: UnifiedContext,
    options: ReviewOptions,
  ): Promise<InstanceResult> {
    const startTime = Date.now();

    try {
      // Create instance-specific AI config
      const aiConfig: AIProviderConfig = {
        provider: this.validateProvider(instanceConfig.provider),
        model: instanceConfig.model,
        temperature: instanceConfig.temperature,
        maxTokens: instanceConfig.maxTokens,
        timeout: instanceConfig.timeout,
        enableAnalytics: true,
        enableEvaluation: false,
      };

      // Create CodeReviewer for this instance
      const codeReviewer = createCodeReviewer(
        this.bitbucketProvider,
        aiConfig,
        this.baseReviewConfig,
      );

      // Execute review with dry run to get violations without posting
      const instanceOptions = { ...options, dryRun: true };
      const reviewResult: ReviewResult =
        await codeReviewer.reviewCodeWithContext(context, instanceOptions);

      const processingTime = Date.now() - startTime;

      return {
        instanceName: instanceConfig.name,
        violations: reviewResult.violations,
        processingTime,
        tokenUsage: this.extractTokenUsage(reviewResult),
        success: true,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;

      return {
        instanceName: instanceConfig.name,
        violations: [],
        processingTime,
        error: (error as Error).message,
        success: false,
      };
    }
  }

  /**
   * Validate multi-instance configuration
   */
  private validateMultiInstanceConfig(config: MultiInstanceConfig): void {
    if (!config.enabled) {
      throw new Error("Multi-instance processing is not enabled");
    }

    if (config.instances.length === 0) {
      throw new Error("No instances configured for multi-instance processing");
    }

    if (config.instances.length !== config.instanceCount) {
      logger.warn(
        `Instance count mismatch: configured ${config.instanceCount}, found ${config.instances.length} instances`,
      );
    }

    // Validate each instance
    for (const instance of config.instances) {
      if (!instance.name || !instance.provider) {
        throw new Error(
          `Invalid instance configuration: name and provider are required`,
        );
      }
    }

    // Validate deduplication config
    if (config.deduplication.enabled) {
      if (
        config.deduplication.similarityThreshold < 0 ||
        config.deduplication.similarityThreshold > 100
      ) {
        throw new Error("Similarity threshold must be between 0 and 100");
      }

      if (config.deduplication.maxCommentsToPost <= 0) {
        throw new Error("Max comments to post must be greater than 0");
      }
    }
  }

  /**
   * Estimate tokens per instance based on context
   */
  private estimateTokensPerInstance(context: UnifiedContext): number {
    // Base estimation: context size + overhead
    const contextSize = JSON.stringify(context).length;
    const estimatedTokens = Math.ceil(contextSize / 4); // ~4 chars per token

    // Add overhead for prompts and response
    const overhead = 5000;

    return estimatedTokens + overhead;
  }

  /**
   * Calculate total token budget for all instances
   */
  private calculateTotalTokenBudget(instances: InstanceConfig[]): number {
    // Use the most restrictive provider limit among all instances
    let minLimit = Infinity;

    for (const instance of instances) {
      const providerLimit = getProviderTokenLimit(instance.provider, true);
      const instanceLimit = instance.maxTokens || providerLimit;
      minLimit = Math.min(minLimit, instanceLimit);
    }

    // Total budget is the sum of all instance limits, but with safety margin
    // Use Math.floor to ensure integer result and avoid floating-point precision issues
    const totalBudget = Math.floor(instances.length * minLimit * 0.8); // 80% safety margin

    logger.debug(
      `Calculated total token budget: ${totalBudget} (${instances.length} instances × ${minLimit} × 0.8, floored)`,
    );

    return totalBudget;
  }

  /**
   * Extract token usage from review result (if available)
   */
  private extractTokenUsage(
    reviewResult: ReviewResult,
  ): { input: number; output: number; total: number } | undefined {
    // This would need to be implemented based on how NeuroLink returns usage data
    // For now, return undefined as we don't have access to this data
    return undefined;
  }

  /**
   * Create non-deduplicated result (when deduplication is disabled)
   */
  private createNonDeduplicatedResult(instanceResults: InstanceResult[]) {
    const allViolations: Violation[] = [];
    const instanceContributions = new Map<string, number>();

    for (const result of instanceResults) {
      if (result.success && result.violations) {
        allViolations.push(...result.violations);
        instanceContributions.set(
          result.instanceName,
          result.violations.length,
        );
      }
    }

    return {
      uniqueViolations: allViolations,
      duplicatesRemoved: {
        exactDuplicates: 0,
        normalizedDuplicates: 0,
        sameLineDuplicates: 0,
      },
      instanceContributions,
      processingMetrics: {
        totalViolationsInput: allViolations.length,
        exactDuplicatesRemoved: 0,
        normalizedDuplicatesRemoved: 0,
        sameLineDuplicatesRemoved: 0,
        finalUniqueViolations: allViolations.length,
        deduplicationRate: 0,
        instanceContributions: Object.fromEntries(instanceContributions),
        processingTimeMs: 0,
      },
    };
  }

  /**
   * Apply final filtering based on configuration
   */
  private applyFinalFiltering(
    violations: Violation[],
    deduplicationConfig: any,
  ): Violation[] {
    if (
      !deduplicationConfig.maxCommentsToPost ||
      violations.length <= deduplicationConfig.maxCommentsToPost
    ) {
      return violations;
    }

    logger.info(
      `📊 Applying final filtering: ${violations.length} → ${deduplicationConfig.maxCommentsToPost} violations`,
    );

    // Sort by priority based on configuration
    const prioritized = this.prioritizeViolations(
      violations,
      deduplicationConfig.prioritizeBy,
    );

    // Take only the top N violations
    const filtered = prioritized.slice(
      0,
      deduplicationConfig.maxCommentsToPost,
    );

    logger.info(
      `🎯 Final filtering applied: kept top ${filtered.length} violations prioritized by ${deduplicationConfig.prioritizeBy}`,
    );

    return filtered;
  }

  /**
   * Prioritize violations based on strategy
   */
  private prioritizeViolations(
    violations: Violation[],
    strategy: string,
  ): Violation[] {
    const severityOrder: Record<string, number> = {
      CRITICAL: 4,
      MAJOR: 3,
      MINOR: 2,
      SUGGESTION: 1,
    };

    switch (strategy) {
      case "severity":
        return violations.sort((a, b) => {
          const aScore = severityOrder[a.severity] || 0;
          const bScore = severityOrder[b.severity] || 0;
          return bScore - aScore; // Higher severity first
        });

      case "similarity":
      case "confidence":
        // For now, fall back to severity-based sorting
        // These could be implemented with more sophisticated algorithms
        logger.debug(
          `Prioritization strategy '${strategy}' not fully implemented, using severity`,
        );
        return this.prioritizeViolations(violations, "severity");

      default:
        logger.warn(
          `Unknown prioritization strategy: ${strategy}, using severity`,
        );
        return this.prioritizeViolations(violations, "severity");
    }
  }

  /**
   * Create summary of multi-instance processing
   */
  private createSummary(
    instanceResults: InstanceResult[],
    deduplicationResult: any,
    finalViolations: Violation[],
    totalProcessingTime: number,
  ) {
    const successfulInstances = instanceResults.filter((r) => r.success).length;
    const failedInstances = instanceResults.length - successfulInstances;
    const totalViolationsFound = instanceResults
      .filter((r) => r.success)
      .reduce((sum, r) => sum + r.violations.length, 0);

    const deduplicationRate =
      totalViolationsFound > 0
        ? ((totalViolationsFound - finalViolations.length) /
            totalViolationsFound) *
          100
        : 0;

    return {
      totalInstances: instanceResults.length,
      successfulInstances,
      failedInstances,
      totalViolationsFound,
      uniqueViolationsAfterDedup: finalViolations.length,
      deduplicationRate,
      totalProcessingTime,
    };
  }
}

/**
 * Factory function to create MultiInstanceProcessor
 */
export function createMultiInstanceProcessor(
  bitbucketProvider: BitbucketProvider,
  baseReviewConfig: CodeReviewConfig,
): MultiInstanceProcessor {
  return new MultiInstanceProcessor(bitbucketProvider, baseReviewConfig);
}
