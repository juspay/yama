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
  IncrementalState,
  CommitRangeDiff,
  PRComment,
} from "../types/index.js";
import { BitbucketProvider } from "./providers/BitbucketProvider.js";
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
  private bitbucketProvider: BitbucketProvider;
  private aiConfig: AIProviderConfig;
  private memoryBankManager: MemoryBankManager;
  private startTime = 0;

  constructor(
    bitbucketProvider: BitbucketProvider,
    aiConfig: AIProviderConfig,
    memoryBankConfig: MemoryBankConfig,
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.aiConfig = aiConfig;
    this.memoryBankManager = createMemoryBankManager(memoryBankConfig, bitbucketProvider);
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
          return await this.bitbucketProvider.getPRDetails(identifier);
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
          return await this.bitbucketProvider.findPRForBranch(identifier);
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
          return await this.bitbucketProvider.getPRDetails({
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
            clinerules = await this.bitbucketProvider.getFileContent(
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
        return await this.bitbucketProvider.getPRDiff(
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
            const fileDiff = await this.bitbucketProvider.getPRDiff(
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
   * Get incremental analysis information for a PR
   */
  async getIncrementalAnalysisInfo(identifier: PRIdentifier): Promise<IncrementalState> {
    const currentCommit = await this.bitbucketProvider.getCurrentCommitSHA(identifier);
    const lastAnalyzedCommit = this.bitbucketProvider.getLastAnalyzedCommit(identifier);
    
    if (!lastAnalyzedCommit || lastAnalyzedCommit === currentCommit) {
      // First run or no new changes - do full analysis
      const prInfo = await this.bitbucketProvider.getPRDetails(identifier);
      
      return {
        lastAnalyzedCommit: currentCommit,
        lastAnalyzedAt: new Date().toISOString(),
        analyzedFiles: prInfo.fileChanges || [],
        useIncremental: false,
        newFiles: prInfo.fileChanges || [],
        modifiedFiles: [],
        unchangedFiles: []
      };
    }
    
    // Get incremental changes
    try {
      const incrementalDiff = await this.bitbucketProvider.getCommitRangeDiff(
        identifier,
        lastAnalyzedCommit,
        currentCommit
      );
      
      return {
        lastAnalyzedCommit,
        lastAnalyzedAt: new Date().toISOString(),
        analyzedFiles: [
          ...incrementalDiff.newFiles,
          ...incrementalDiff.modifiedFiles,
          ...incrementalDiff.unchangedFiles
        ],
        useIncremental: true,
        newFiles: incrementalDiff.newFiles,
        modifiedFiles: incrementalDiff.modifiedFiles,
        unchangedFiles: incrementalDiff.unchangedFiles
      };
    } catch (error) {
      logger.debug(`Incremental diff failed, falling back to full analysis: ${(error as Error).message}`);
      
      // Fallback to full analysis
      const prInfo = await this.bitbucketProvider.getPRDetails(identifier);
      
      return {
        lastAnalyzedCommit: currentCommit,
        lastAnalyzedAt: new Date().toISOString(),
        analyzedFiles: prInfo.fileChanges || [],
        useIncremental: false,
        newFiles: prInfo.fileChanges || [],
        modifiedFiles: [],
        unchangedFiles: []
      };
    }
  }

  /**
   * Update incremental analysis state after successful review
   */
  async updateIncrementalState(identifier: PRIdentifier): Promise<void> {
    const currentCommit = await this.bitbucketProvider.getCurrentCommitSHA(identifier);
    this.bitbucketProvider.updateLastAnalyzedCommit(identifier, currentCommit);
    
    logger.debug(`Updated incremental state for PR ${identifier.pullRequestId}: commit ${currentCommit}`);
  }

  /**
   * Get all PR comments with enhanced filtering for duplicate detection
   */
  async getPRComments(
    identifier: PRIdentifier,
    options: {
      includeYamaComments?: boolean;
      includeResolved?: boolean;
      sinceDate?: string;
    } = {}
  ): Promise<PRComment[]> {
    return await this.bitbucketProvider.getPRComments(identifier, options);
  }

  /**
   * Create incremental context for analyzing only changed files
   */
  async createIncrementalContext(
    baseContext: UnifiedContext,
    incrementalState: IncrementalState
  ): Promise<UnifiedContext> {
    const filesToAnalyze = [
      ...incrementalState.newFiles,
      ...incrementalState.modifiedFiles
    ];

    if (filesToAnalyze.length === 0) {
      // No files to analyze, return minimal context
      return {
        ...baseContext,
        diffStrategy: {
          strategy: "file-by-file",
          reason: "No new or modified files to analyze",
          fileCount: 0,
          estimatedSize: "0 KB"
        },
        fileDiffs: new Map(),
        pr: {
          ...baseContext.pr,
          fileChanges: []
        }
      };
    }

    // Get diffs only for changed files
    const incrementalFileDiffs = new Map<string, string>();
    
    logger.debug(`Creating incremental context for ${filesToAnalyze.length} files`);
    
    // Process files in batches
    const batchSize = 5;
    for (let i = 0; i < filesToAnalyze.length; i += batchSize) {
      const batch = filesToAnalyze.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (file) => {
        try {
          const fileDiff = await this.bitbucketProvider.getPRDiff(
            baseContext.identifier,
            3, // context lines
            ["*.lock", "*.svg"], // exclude patterns
            [file] // include only this file
          );
          return { file, diff: fileDiff.diff };
        } catch (error) {
          logger.debug(`Failed to get diff for ${file}: ${(error as Error).message}`);
          return { file, diff: '' };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      batchResults.forEach(({ file, diff }) => {
        if (diff) {
          incrementalFileDiffs.set(file, diff);
        }
      });
      
      // Small delay between batches
      if (i + batchSize < filesToAnalyze.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return {
      ...baseContext,
      diffStrategy: {
        strategy: "file-by-file",
        reason: `Incremental analysis: ${incrementalState.newFiles.length} new, ${incrementalState.modifiedFiles.length} modified files`,
        fileCount: filesToAnalyze.length,
        estimatedSize: this.estimateDiffSize(filesToAnalyze.length)
      },
      fileDiffs: incrementalFileDiffs,
      pr: {
        ...baseContext.pr,
        fileChanges: filesToAnalyze
      }
    };
  }

  /**
   * Enhanced context gathering with incremental analysis support
   */
  async gatherContextWithIncremental(
    identifier: PRIdentifier,
    options: {
      excludePatterns?: string[];
      contextLines?: number;
      forceRefresh?: boolean;
      includeDiff?: boolean;
      diffStrategyConfig?: DiffStrategyConfig;
      enableIncrementalAnalysis?: boolean;
    } = {}
  ): Promise<{
    context: UnifiedContext;
    incrementalState?: IncrementalState;
    isIncremental: boolean;
  }> {
    // First gather base context
    const baseContext = await this.gatherContext(identifier, options);
    
    console.log("value of options.enableIncrementalAnalysis: ", options.enableIncrementalAnalysis);
    
    if (!options.enableIncrementalAnalysis) {
      logger.info("🔍 FULL REVIEW MODE - Incremental analysis disabled");
      return {
        context: baseContext,
        isIncremental: false
      };
    }

    // Start incremental analysis evaluation
    logger.phase("🔄 Starting incremental analysis evaluation...");

    // Get incremental analysis info
    const incrementalState = await this.getIncrementalAnalysisInfo(identifier);
    
    if (!incrementalState.useIncremental) {
      logger.phase("🔍 FULL REVIEW STARTED");
      logger.info(`📊 Full Analysis Details:`);
      logger.info(`   • Reason: ${incrementalState.lastAnalyzedCommit ? 'No new changes detected' : 'First run or no previous state'}`);
      logger.info(`   • Total files in PR: ${baseContext.pr.fileChanges?.length || 0}`);
      
      return {
        context: baseContext,
        incrementalState,
        isIncremental: false
      };
    }

    // Get current commit for logging
    const currentCommit = await this.bitbucketProvider.getCurrentCommitSHA(identifier);
    
    // Log incremental review start with detailed information
    logger.phase("⚡ INCREMENTAL REVIEW STARTED");
    logger.info(`📊 Incremental Analysis Details:`);
    logger.info(`   • Last analyzed commit: ${incrementalState.lastAnalyzedCommit?.substring(0, 8)}...`);
    logger.info(`   • Current commit: ${currentCommit.substring(0, 8)}...`);
    logger.info(`   • New files: ${incrementalState.newFiles.length}`);
    logger.info(`   • Modified files: ${incrementalState.modifiedFiles.length}`);
    logger.info(`   • Unchanged files: ${incrementalState.unchangedFiles.length}`);
    
    const totalFilesToAnalyze = incrementalState.newFiles.length + incrementalState.modifiedFiles.length;
    logger.info(`   • Total files to analyze: ${totalFilesToAnalyze}`);

    // Check for no-change scenario
    if (totalFilesToAnalyze === 0) {
      logger.success("✨ No file changes detected since last review");
      logger.info("🎯 Skipping analysis - no new violations expected");
      
      // Return minimal context for no-change scenario
      const noChangeContext = {
        ...baseContext,
        diffStrategy: {
          strategy: "file-by-file" as const,
          reason: "No new or modified files to analyze",
          fileCount: 0,
          estimatedSize: "0 KB"
        },
        fileDiffs: new Map(),
        pr: {
          ...baseContext.pr,
          fileChanges: []
        }
      };

      return {
        context: noChangeContext,
        incrementalState,
        isIncremental: true
      };
    }

    // Create incremental context
    logger.info(`🔄 Creating incremental context for ${totalFilesToAnalyze} changed files...`);
    const incrementalContext = await this.createIncrementalContext(
      baseContext,
      incrementalState
    );

    // Log file details if in debug mode
    if (incrementalState.newFiles.length > 0) {
      logger.debug(`📁 New files: ${incrementalState.newFiles.join(', ')}`);
    }
    if (incrementalState.modifiedFiles.length > 0) {
      logger.debug(`📝 Modified files: ${incrementalState.modifiedFiles.join(', ')}`);
    }

    logger.success(`🎯 Incremental context ready - analyzing ${totalFilesToAnalyze} changed files`);

    return {
      context: incrementalContext,
      incrementalState,
      isIncremental: true
    };
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
  bitbucketProvider: BitbucketProvider,
  aiConfig: AIProviderConfig,
  memoryBankConfig: MemoryBankConfig,
): ContextGatherer {
  return new ContextGatherer(bitbucketProvider, aiConfig, memoryBankConfig);
}
