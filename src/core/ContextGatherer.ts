/**
 * Unified Context Gatherer - The foundation for all Yama operations
 * Gathers all necessary context once and reuses it across all operations
 */

// NeuroLink will be dynamically imported
import {
  PRIdentifier,
  PRInfo,
  PRDiff,
  AIProviderConfig,
  ProviderError,
  DiffStrategyConfig,
  MemoryBankConfig,
} from "../types/index.js";
import { GitProvider } from "./providers/GitProvider.js";
import { logger } from "../utils/Logger.js";
import { cache, Cache } from "../utils/Cache.js";
import { MemoryBankManager, createMemoryBankManager } from "../utils/MemoryBankManager.js";
import { getProviderTokenLimit } from "../utils/ProviderLimits.js";

export interface ProjectContext {
  memoryBank: {
    summary: string;
    projectContext: string;
    patterns: string;
    standards: string;
  };
  clinerules: string;
  filesProcessed: number;
}

export interface DiffStrategy {
  strategy: "whole" | "file-by-file";
  reason: string;
  fileCount: number;
  estimatedSize: string;
}

export interface UnifiedContext {
  pr: PRInfo;
  identifier: PRIdentifier;
  projectContext: ProjectContext;
  diffStrategy: DiffStrategy;
  prDiff?: PRDiff;
  fileDiffs?: Map<string, string>;
  contextId: string;
  gatheredAt: string;
  cacheHits: string[];
  gatheringDuration: number;
}

export class ContextGatherer {
  private neurolink: any;
  private gitProvider: GitProvider;
  private aiConfig: AIProviderConfig;
  private memoryBankManager: MemoryBankManager;
  private startTime = 0;

  constructor(
    gitProvider: GitProvider,
    aiConfig: AIProviderConfig,
    memoryBankConfig: MemoryBankConfig,
  ) {
    this.gitProvider = gitProvider;
    this.aiConfig = aiConfig;
    this.memoryBankManager = createMemoryBankManager(memoryBankConfig, gitProvider);
  }

  /**
   * Main context gathering method - used by all operations
   */
  async gatherContext(
    identifier: PRIdentifier,
    options: {
      excludePatterns?: string[];
      contextLines?: number;
      forceRefresh?: boolean;
      includeDiff?: boolean;
      diffStrategyConfig?: DiffStrategyConfig;
    } = {},
  ): Promise<UnifiedContext> {
    this.startTime = Date.now();
    const contextId = this.generateContextId(identifier);
    const cacheHits: string[] = [];

    logger.phase("🔍 Gathering unified context...");
    logger.info(`Target: ${identifier.workspace}/${identifier.repository}`);
    logger.info(`Initial identifier: ${JSON.stringify(identifier, null, 2)}`);

    try {
      // Step 1: Find and get PR information
      const pr = await this.findAndGetPR(
        identifier,
        cacheHits,
        options.forceRefresh,
      );

      const completeIdentifier: PRIdentifier = {
        ...identifier,
        pullRequestId: pr.id,
      };
      logger.debug(`PR details: id=${pr.id}, type=${typeof pr.id}`);
      logger.debug(`Complete identifier: ${JSON.stringify(completeIdentifier, null, 2)}`);

      // Step 2: Gather project context (memory bank + clinerules)
      const projectContext = await this.gatherProjectContext(
        completeIdentifier,
        cacheHits,
        options.forceRefresh,
      );

      // Step 3: Determine diff strategy based on file count and config
      const diffStrategy = this.determineDiffStrategy(
        pr.fileChanges || [],
        options.diffStrategyConfig,
      );
      logger.info(
        `Diff strategy: ${diffStrategy.strategy} (${diffStrategy.reason})`,
      );

      // Step 4: Get diff data based on strategy (if requested)
      let prDiff: PRDiff | undefined;
      let fileDiffs: Map<string, string> | undefined;

      if (options.includeDiff !== false) {
        if (diffStrategy.strategy === "whole") {
          prDiff = await this.getPRDiff(
            completeIdentifier,
            options.contextLines || 3,
            options.excludePatterns || ["*.lock", "*.svg"],
            cacheHits,
            options.forceRefresh,
          );
        } else {
          fileDiffs = await this.getFileByFileDiffs(
            completeIdentifier,
            pr.fileChanges || [],
            options.contextLines || 3,
            options.excludePatterns || ["*.lock", "*.svg"],
            cacheHits,
            options.forceRefresh,
          );
        }
      }

      const gatheringDuration = Date.now() - this.startTime;

      const context: UnifiedContext = {
        pr,
        identifier: completeIdentifier,
        projectContext,
        diffStrategy,
        prDiff,
        fileDiffs,
        contextId,
        gatheredAt: new Date().toISOString(),
        cacheHits,
        gatheringDuration,
      };

      logger.success(
        `Context gathered in ${Math.round(gatheringDuration / 1000)}s ` +
          `(${cacheHits.length} cache hits, ${diffStrategy.fileCount} files, ${diffStrategy.estimatedSize})`,
      );

      // Cache the complete context for reuse
      this.cacheContext(context);

      return context;
    } catch (error) {
      logger.error(`Context gathering failed: ${(error as Error).message}`);
      throw new ProviderError(
        `Failed to gather context: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Step 1: Find PR and get detailed information
   */
  private async findAndGetPR(
    identifier: PRIdentifier,
    cacheHits: string[],
    forceRefresh = false,
  ): Promise<PRInfo> {
    logger.debug("Step 1: Finding and getting PR information...");

    // If PR ID is provided, get details directly
    if (identifier.pullRequestId) {
      const cacheKey = Cache.keys.prInfo(
        identifier.workspace,
        identifier.repository,
        identifier.pullRequestId,
      );

      if (!forceRefresh && cache.has(cacheKey)) {
        cacheHits.push("pr-details");
      }

      return cache.getOrSet(
        cacheKey,
        async () => {
          logger.debug(
            `Getting PR details: ${identifier.workspace}/${identifier.repository}#${identifier.pullRequestId}`,
          );
          return await this.gitProvider.getPRDetails(identifier);
        },
        1800, // 30 minutes
      );
    }

    // If branch is provided, find PR first
    if (identifier.branch) {
      const branchCacheKey = Cache.keys.branchInfo(
        identifier.workspace,
        identifier.repository,
        identifier.branch,
      );

      if (!forceRefresh && cache.has(branchCacheKey)) {
        cacheHits.push("branch-pr-lookup");
      }

      const prInfo = await cache.getOrSet(
        branchCacheKey,
        async () => {
          logger.debug(
            `Finding PR for branch: ${identifier.workspace}/${identifier.repository}@${identifier.branch}`,
          );
          return await this.gitProvider.findPRForBranch(identifier);
        },
        3600, // 1 hour
      );

      // Now get full PR details
      const detailsCacheKey = Cache.keys.prInfo(
        identifier.workspace,
        identifier.repository,
        prInfo.id,
      );

      if (!forceRefresh && cache.has(detailsCacheKey)) {
        cacheHits.push("pr-details-from-branch");
      }

      return cache.getOrSet(
        detailsCacheKey,
        async () => {
          return await this.gitProvider.getPRDetails({
            ...identifier,
            pullRequestId: prInfo.id,
          });
        },
        1800, // 30 minutes
      );
    }

    throw new ProviderError("Either pullRequestId or branch must be provided");
  }

  /**
   * Step 2: Gather project context (memory bank + clinerules)
   */
  private async gatherProjectContext(
    identifier: PRIdentifier,
    cacheHits: string[],
    forceRefresh = false,
  ): Promise<ProjectContext> {
    logger.debug("Step 2: Gathering project context...");

    const cacheKey = Cache.keys.projectContext(
      identifier.workspace,
      identifier.repository,
      identifier.branch || "main",
    );

    if (!forceRefresh && cache.has(cacheKey)) {
      cacheHits.push("project-context");
    }

    return cache.getOrSet(
      cacheKey,
      async () => {
        try {
          // Use MemoryBankManager to get memory bank files
          const memoryBankResult = await this.memoryBankManager.getMemoryBankFiles(
            identifier,
            forceRefresh,
          );

          if (memoryBankResult.files.length === 0) {
            logger.debug("No memory bank files found");
            return {
              memoryBank: {
                summary: "No project context available",
                projectContext: "None",
                patterns: "None",
                standards: "None",
              },
              clinerules: "",
              filesProcessed: 0,
            };
          }

          // Convert MemoryBankFile[] to Record<string, string> for AI processing
          const fileContents: Record<string, string> = {};
          memoryBankResult.files.forEach((file) => {
            fileContents[file.name] = file.content;
          });

          logger.debug(
            `✓ Loaded ${memoryBankResult.files.length} memory bank files from ${memoryBankResult.resolvedPath}${
              memoryBankResult.fallbackUsed ? " (fallback)" : ""
            }`,
          );

          // Get .clinerules file
          let clinerules = "";
          try {
            clinerules = await this.gitProvider.getFileContent(
              identifier.workspace,
              identifier.repository,
              ".clinerules",
              identifier.branch || "main",
            );
            logger.debug("✓ Got .clinerules content");
          } catch (error) {
            logger.debug(
              `Could not read .clinerules: ${(error as Error).message}`,
            );
          }

          // Parse and summarize with AI
          const contextData = await this.parseProjectContextWithAI(
            fileContents,
            clinerules,
          );

          return {
            memoryBank: {
              summary: `Project Context: ${contextData.projectContext}
Patterns: ${contextData.patterns}
Standards: ${contextData.standards}`,
              projectContext: contextData.projectContext,
              patterns: contextData.patterns,
              standards: contextData.standards,
            },
            clinerules,
            filesProcessed: memoryBankResult.filesProcessed,
          };
        } catch (error) {
          logger.debug(
            `Failed to gather project context: ${(error as Error).message}`,
          );
          return {
            memoryBank: {
              summary: "Context gathering failed",
              projectContext: "Failed to load",
              patterns: "Failed to load",
              standards: "Failed to load",
            },
            clinerules: "",
            filesProcessed: 0,
          };
        }
      },
      7200, // 2 hours - project context changes less frequently
    );
  }

  /**
   * Get safe token limit based on AI provider using shared utility
   */
  private getSafeTokenLimit(): number {
    const provider = this.aiConfig.provider || "auto";
    const configuredTokens = this.aiConfig.maxTokens;
    
    // Use conservative limits for ContextGatherer (safer for large context processing)
    const providerLimit = getProviderTokenLimit(provider, true);
    
    // Use the smaller of configured tokens or provider limit
    if (configuredTokens && configuredTokens > 0) {
      const safeLimit = Math.min(configuredTokens, providerLimit);
      logger.debug(`Token limit: configured=${configuredTokens}, provider=${providerLimit}, using=${safeLimit}`);
      return safeLimit;
    }

    logger.debug(`Token limit: using provider default=${providerLimit} for ${provider}`);
    return providerLimit;
  }

  /**
   * Parse project context with AI
   */
  private async parseProjectContextWithAI(
    fileContents: Record<string, string>,
    clinerules: string,
  ): Promise<{ projectContext: string; patterns: string; standards: string }> {
    const prompt = `Parse and summarize these memory bank files and .clinerules:

Memory Bank Files: ${JSON.stringify(fileContents, null, 2)}

.clinerules Content: ${clinerules}

Extract and summarize the content and return ONLY this JSON format:
{
  "success": true,
  "projectContext": "Summary of project purpose, architecture, key components...",
  "patterns": "Summary of coding patterns, best practices, conventions...",
  "standards": "Summary of quality standards, review criteria..."
}`;

    try {
      // Initialize NeuroLink with eval-based dynamic import
      if (!this.neurolink) {
        const { NeuroLink  } = await import("@juspay/neurolink");
        this.neurolink = new NeuroLink();
      }

      // Context for project analysis
      const aiContext = {
        operation: "project-context-analysis",
        fileCount: Object.keys(fileContents).length,
        hasClinerules: !!clinerules,
        analysisType: "memory-bank-synthesis",
      };

      // Get safe token limit based on provider
      const safeMaxTokens = this.getSafeTokenLimit();
      
      logger.debug(`Using AI provider: ${this.aiConfig.provider || "auto"}`);
      logger.debug(`Configured maxTokens: ${this.aiConfig.maxTokens}`);
      logger.debug(`Safe maxTokens limit: ${safeMaxTokens}`);

      const result = await this.neurolink.generate({
        input: { text: prompt },
        systemPrompt:
          "You are an Expert Project Analyst. Synthesize project context from documentation and configuration files to help AI understand the codebase architecture, patterns, and business domain.",
        provider: this.aiConfig.provider,
        model: this.aiConfig.model,
        temperature: 0.3,
        maxTokens: safeMaxTokens, // Use provider-aware safe token limit
        timeout: "10m", // Allow longer processing for quality
        context: aiContext,
        enableAnalytics: this.aiConfig.enableAnalytics || true,
        enableEvaluation: false, // Not needed for context synthesis
      });

      // Log context analysis
      if (result.analytics) {
        logger.debug(
          `Context Analysis - Files: ${Object.keys(fileContents).length}, Provider: ${result.provider}`,
        );
      }

      // Modern NeuroLink returns { content: string }
      const response = this.parseAIResponse(result);

      if (response.success) {
        return {
          projectContext: response.projectContext || "None",
          patterns: response.patterns || "None",
          standards: response.standards || "None",
        };
      }

      throw new Error("AI parsing failed");
    } catch (error) {
      logger.warn(
        `AI context parsing failed, using fallback: ${(error as Error).message}`,
      );
      return {
        projectContext: "AI parsing unavailable",
        patterns: "Standard patterns assumed",
        standards: "Standard quality requirements",
      };
    }
  }

  /**
   * Step 3: Determine optimal diff strategy
   */
  private determineDiffStrategy(
    fileChanges: string[],
    config?: DiffStrategyConfig,
  ): DiffStrategy {
    const fileCount = fileChanges.length;

    // Get threshold values from config or use defaults
    const wholeDiffMaxFiles = config?.thresholds?.wholeDiffMaxFiles ?? 2;
    // Note: fileByFileMinFiles is currently same as wholeDiffMaxFiles + 1
    // but kept separate for future flexibility

    // Check if force strategy is configured
    if (config?.forceStrategy && config.forceStrategy !== "auto") {
      return {
        strategy: config.forceStrategy,
        reason: `Forced by configuration`,
        fileCount,
        estimatedSize: this.estimateDiffSize(fileCount),
      };
    }

    // Determine strategy based on thresholds
    let strategy: "whole" | "file-by-file" = "whole";
    let reason = "";

    if (fileCount === 0) {
      strategy = "whole";
      reason = "No files to analyze";
    } else if (fileCount <= wholeDiffMaxFiles) {
      strategy = "whole";
      reason = `${fileCount} file(s) ≤ ${wholeDiffMaxFiles} (threshold), using whole diff`;
    } else {
      strategy = "file-by-file";
      reason = `${fileCount} file(s) > ${wholeDiffMaxFiles} (threshold), using file-by-file`;
    }

    return {
      strategy,
      reason,
      fileCount,
      estimatedSize: this.estimateDiffSize(fileCount),
    };
  }

  /**
   * Estimate diff size based on file count
   */
  private estimateDiffSize(fileCount: number): string {
    if (fileCount === 0) {return "0 KB";}
    if (fileCount <= 2) {return "Small (~5-20 KB)";}
    if (fileCount <= 5) {return "Small (~10-50 KB)";}
    if (fileCount <= 20) {return "Medium (~50-200 KB)";}
    if (fileCount <= 50) {return "Large (~200-500 KB)";}
    return "Very Large (>500 KB)";
  }

  /**
   * Get whole PR diff
   */
  private async getPRDiff(
    identifier: PRIdentifier,
    contextLines: number,
    excludePatterns: string[],
    cacheHits: string[],
    forceRefresh = false,
  ): Promise<PRDiff> {
    logger.debug("Getting whole PR diff...");

    const cacheKey = Cache.keys.prDiff(
      identifier.workspace,
      identifier.repository,
      identifier.pullRequestId!,
    );

    if (!forceRefresh && cache.has(cacheKey)) {
      cacheHits.push("pr-diff");
    }

    return cache.getOrSet(
      cacheKey,
      async () => {
        return await this.gitProvider.getPRDiff(
          identifier,
          contextLines,
          excludePatterns,
        );
      },
      1800, // 30 minutes
    );
  }

  /**
   * Get file-by-file diffs for large changesets
   */
  private async getFileByFileDiffs(
    identifier: PRIdentifier,
    fileChanges: string[],
    contextLines: number,
    excludePatterns: string[],
    cacheHits: string[],
    forceRefresh = false,
  ): Promise<Map<string, string>> {
    logger.debug(
      `Getting file-by-file diffs for ${fileChanges.length} files...`,
    );

    const fileDiffs = new Map<string, string>();

    // Filter out excluded files
    const filteredFiles = fileChanges.filter(
      (file) =>
        !excludePatterns.some((pattern) =>
          new RegExp(pattern.replace(/\*/g, ".*")).test(file),
        ),
    );

    logger.debug(`Processing ${filteredFiles.length} files after exclusions`);

    // Process files in batches for better performance
    const batchSize = 5;
    for (let i = 0; i < filteredFiles.length; i += batchSize) {
      const batch = filteredFiles.slice(i, i + batchSize);

      const batchPromises = batch.map(async (file) => {
        const fileCacheKey = `file-diff:${identifier.workspace}:${identifier.repository}:${identifier.pullRequestId}:${file}`;

        if (!forceRefresh && cache.has(fileCacheKey)) {
          cacheHits.push(`file-diff-${file}`);
        }

        return cache.getOrSet(
          fileCacheKey,
          async () => {
            // Use include_patterns to get diff for just this file
            const fileDiff = await this.gitProvider.getPRDiff(
              identifier,
              contextLines,
              excludePatterns,
              [file], // Include patterns with single file
            );
            return fileDiff.diff;
          },
          1800, // 30 minutes
        );
      });

      const batchResults = await Promise.all(batchPromises);

      batch.forEach((file, index) => {
        fileDiffs.set(file, batchResults[index]);
      });

      // Small delay between batches to avoid overwhelming the API
      if (i + batchSize < filteredFiles.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    logger.debug(`✓ Got diffs for ${fileDiffs.size} files`);
    return fileDiffs;
  }

  /**
   * Cache the complete context for reuse
   */
  private cacheContext(context: UnifiedContext): void {
    const contextCacheKey = `context:${context.contextId}`;
    cache.set(contextCacheKey, context, 1800); // 30 minutes

    // Tag it for easy invalidation
    cache.setWithTags(
      contextCacheKey,
      context,
      [
        `workspace:${context.identifier.workspace}`,
        `repository:${context.identifier.repository}`,
        `pr:${context.identifier.pullRequestId}`,
      ],
      1800,
    );
  }

  /**
   * Get cached context if available
   */
  async getCachedContext(
    identifier: PRIdentifier,
  ): Promise<UnifiedContext | null> {
    const contextId = this.generateContextId(identifier);
    const contextCacheKey = `context:${contextId}`;

    const cached = cache.get<UnifiedContext>(contextCacheKey);
    if (cached) {
      logger.debug(`✓ Using cached context: ${contextId}`);
      return cached;
    }

    return null;
  }

  /**
   * Invalidate context cache for a specific PR
   */
  invalidateContext(identifier: PRIdentifier): void {
    cache.invalidateTag(`pr:${identifier.pullRequestId}`);
    cache.invalidateTag(`workspace:${identifier.workspace}`);
    logger.debug(
      `Context cache invalidated for PR ${identifier.pullRequestId}`,
    );
  }

  /**
   * Generate unique context ID
   */
  private generateContextId(identifier: PRIdentifier): string {
    const parts = [
      identifier.workspace,
      identifier.repository,
      identifier.pullRequestId || identifier.branch || "unknown",
    ];
    return Buffer.from(parts.join(":"))
      .toString("base64")
      .replace(/[+/=]/g, "")
      .substring(0, 16);
  }

  /**
   * Parse AI response utility
   */
  private parseAIResponse(result: any): any {
    try {
      const responseText =
        result.content || result.text || result.response || "";

      if (!responseText) {
        return { success: false, error: "Empty response" };
      }

      // Find JSON in response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return { success: false, error: "No JSON found" };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Get gathering statistics
   */
  getStats(): any {
    return {
      lastGatheringDuration: this.startTime ? Date.now() - this.startTime : 0,
      cacheStats: cache.stats(),
      cacheHitRatio: cache.getHitRatio(),
    };
  }
}

// Export factory function
export function createContextGatherer(
  gitProvider: GitProvider,
  aiConfig: AIProviderConfig,
  memoryBankConfig: MemoryBankConfig,
): ContextGatherer {
  return new ContextGatherer(gitProvider, aiConfig, memoryBankConfig);
}
