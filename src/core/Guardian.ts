/**
 * Yama - Unified orchestrator class
 * The main class that coordinates all operations using shared context
 */

import {
  GuardianConfig,
  PRIdentifier,
  OperationType,
  OperationOptions,
  OperationResult,
  ProcessResult,
  StreamUpdate,
  StreamOptions,
  ReviewOptions,
  EnhancementOptions,
  GuardianError,
  WIPDetectionConfig,
} from "../types/index.js";

import { BitbucketProvider } from "./providers/BitbucketProvider.js";
import { ContextGatherer, UnifiedContext } from "./ContextGatherer.js";
import { CodeReviewer } from "../features/CodeReviewer.js";
import { DescriptionEnhancer } from "../features/DescriptionEnhancer.js";

import { logger } from "../utils/Logger.js";
import { configManager } from "../utils/ConfigManager.js";
import { cache } from "../utils/Cache.js";

export class Guardian {
  private config: GuardianConfig;
  private partialConfig?: Partial<GuardianConfig>;
  private bitbucketProvider!: BitbucketProvider;
  private contextGatherer!: ContextGatherer;
  private codeReviewer!: CodeReviewer;
  private descriptionEnhancer!: DescriptionEnhancer;
  private neurolink!: any;
  private initialized = false;

  constructor(config?: Partial<GuardianConfig>) {
    this.config = {} as GuardianConfig;
    this.partialConfig = config; // Store partial config for later merging
  }

  /**
   * Initialize Guardian with configuration
   */
  async initialize(configPath?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.badge();
      logger.phase("🚀 Initializing Yama...");

      // Load configuration and merge with constructor config
      const loadedConfig = await configManager.loadConfig(configPath);
      
      // If we have a partial config from constructor, merge it with loaded config
      if (this.partialConfig) {
        // Deep merge the configs, with constructor config taking precedence
        this.config = this.mergeConfigs(loadedConfig, this.partialConfig);
      } else {
        this.config = loadedConfig;
      }

      // Initialize providers
      this.bitbucketProvider = new BitbucketProvider(
        this.config.providers.git.credentials,
      );
      await this.bitbucketProvider.initialize();

      // Initialize NeuroLink with native ESM dynamic import
      const { NeuroLink } = await import("@juspay/neurolink");
      this.neurolink = new NeuroLink();

      // Initialize core components
      this.contextGatherer = new ContextGatherer(
        this.bitbucketProvider,
        this.config.providers.ai,
        this.config.memoryBank || {
          enabled: true,
          path: "memory-bank",
          fallbackPaths: ["docs/memory-bank", ".memory-bank"],
        },
      );

      this.codeReviewer = new CodeReviewer(
        this.bitbucketProvider,
        this.config.providers.ai,
        this.config.features.codeReview,
      );

      this.descriptionEnhancer = new DescriptionEnhancer(
        this.bitbucketProvider,
        this.config.providers.ai,
      );

      this.initialized = true;
      logger.success("✅ Yama initialized successfully");
    } catch (error) {
      logger.error(`Failed to initialize Yama: ${(error as Error).message}`);
      throw new GuardianError(
        "INITIALIZATION_ERROR",
        `Initialization failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Main method: Process PR with multiple operations using unified context
   */
  async processPR(options: OperationOptions): Promise<ProcessResult> {
    await this.ensureInitialized();

    const startTime = Date.now();
    const operations: OperationResult[] = [];

    try {
      logger.operation("PR Processing", "started");
      logger.info(`Target: ${options.workspace}/${options.repository}`);
      logger.info(`Operations: ${options.operations.join(", ")}`);
      logger.info(`Mode: ${options.dryRun ? "DRY RUN" : "LIVE"}`);

      // Step 1: Gather unified context ONCE for all operations
      logger.phase("📋 Gathering unified context...");
      const context = await this.gatherUnifiedContext(options);

      logger.success(
        `Context ready: PR #${context.pr.id} - "${context.pr.title}"`,
      );
      logger.info(
        `Files: ${context.diffStrategy.fileCount}, Strategy: ${context.diffStrategy.strategy}`,
      );

      // Step 2: Execute requested operations using shared context
      for (const operation of options.operations) {
        if (operation === "all") {
          // Execute all available operations
          operations.push(
            await this.executeOperation("review", context, options),
          );
          operations.push(
            await this.executeOperation(
              "enhance-description",
              context,
              options,
            ),
          );
        } else {
          operations.push(
            await this.executeOperation(operation, context, options),
          );
        }
      }

      const duration = Date.now() - startTime;
      const successCount = operations.filter(
        (op) => op.status === "success",
      ).length;
      const errorCount = operations.filter(
        (op) => op.status === "error",
      ).length;
      const skippedCount = operations.filter(
        (op) => op.status === "skipped",
      ).length;

      const result: ProcessResult = {
        pullRequest: context.pr,
        operations,
        summary: {
          totalOperations: operations.length,
          successCount,
          errorCount,
          skippedCount,
          totalDuration: duration,
        },
      };

      logger.operation("PR Processing", "completed");
      logger.success(
        `✅ Processing completed in ${Math.round(duration / 1000)}s: ` +
          `${successCount} success, ${errorCount} errors, ${skippedCount} skipped`,
      );

      return result;
    } catch (error) {
      // Handle WIP detection specially
      if (error instanceof GuardianError && error.code === "WIP_DETECTED") {
        logger.operation("PR Processing", "completed");
        
        // Create skipped operations for all requested operations
        const skippedOperations: OperationResult[] = options.operations.map(op => ({
          operation: op,
          status: "skipped" as const,
          data: { 
            skipped: true, 
            reason: "WIP detected in PR title",
            wipDetails: error.context
          },
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        }));

        // Create a dummy PR info for the result since we might not have full context
        const dummyPR = error.context?.prId ? {
          id: error.context.prId,
          title: error.context.prTitle || "WIP PR",
          description: "",
          author: "",
          state: "OPEN" as const,
          sourceRef: "",
          targetRef: "",
          createdDate: "",
          updatedDate: "",
        } : {
          id: "unknown",
          title: "WIP PR",
          description: "",
          author: "",
          state: "OPEN" as const,
          sourceRef: "",
          targetRef: "",
          createdDate: "",
          updatedDate: "",
        };

        return {
          pullRequest: dummyPR,
          operations: skippedOperations,
          summary: {
            totalOperations: skippedOperations.length,
            successCount: 0,
            errorCount: 0,
            skippedCount: skippedOperations.length,
            totalDuration: Date.now() - startTime,
          },
        };
      }

      logger.operation("PR Processing", "failed");
      logger.error(`Processing failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Streaming version of processPR for real-time updates
   */
  async *processPRStream(
    options: OperationOptions,
    _streamOptions?: StreamOptions,
  ): AsyncIterableIterator<StreamUpdate> {
    await this.ensureInitialized();

    const startTime = Date.now();

    try {
      // Initial update
      yield {
        operation: "all",
        status: "started",
        message: "Yama processing initiated",
        timestamp: new Date().toISOString(),
      };

      // Context gathering phase
      yield {
        operation: "all",
        status: "progress",
        progress: 10,
        message: "Gathering unified context...",
        timestamp: new Date().toISOString(),
      };

      const context = await this.gatherUnifiedContext(options);

      yield {
        operation: "all",
        status: "progress",
        progress: 30,
        message: `Context ready: PR #${context.pr.id}`,
        data: { prId: context.pr.id, title: context.pr.title },
        timestamp: new Date().toISOString(),
      };

      // Execute operations with progress updates
      const totalOps = options.operations.length;
      let completedOps = 0;

      for (const operation of options.operations) {
        yield {
          operation,
          status: "started",
          message: `Starting ${operation}...`,
          timestamp: new Date().toISOString(),
        };

        try {
          const result = await this.executeOperation(
            operation,
            context,
            options,
          );

          if (result.status === "error") {
            yield {
              operation,
              status: "error",
              message: `${operation} failed: ${result.error}`,
              timestamp: new Date().toISOString(),
            };
          } else {
            completedOps++;
            yield {
              operation,
              status: "completed",
              progress: 30 + Math.round((completedOps / totalOps) * 60),
              message: `${operation} completed`,
              data: result,
              timestamp: new Date().toISOString(),
            };
          }
        } catch (error) {
          // This catch is for unexpected errors that bypass executeOperation's own error handling
          yield {
            operation,
            status: "error",
            message: `${operation} failed: ${(error as Error).message}`,
            timestamp: new Date().toISOString(),
          };
        }
      }

      // Final completion
      const duration = Date.now() - startTime;
      yield {
        operation: "all",
        status: "completed",
        progress: 100,
        message: `Processing completed in ${Math.round(duration / 1000)}s`,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      yield {
        operation: "all",
        status: "error",
        message: `Processing failed: ${(error as Error).message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Gather unified context (cached and reusable)
   */
  private async gatherUnifiedContext(
    options: OperationOptions,
  ): Promise<UnifiedContext> {
    const identifier: PRIdentifier = {
      workspace: options.workspace,
      repository: options.repository,
      branch: options.branch,
      pullRequestId: options.pullRequestId,
    };

    // Phase 1: Always get PR info first (fast) to check WIP before using any cache
    const lightweightContext = await this.contextGatherer.gatherContext(identifier, {
      excludePatterns: this.config.features.codeReview.excludePatterns,
      contextLines: this.config.features.codeReview.contextLines,
      forceRefresh: false,
      includeDiff: false, // Fast PR info only
      skipProjectContext: true, // Skip expensive AI processing for WIP check
      diffStrategyConfig: this.config.features.diffStrategy,
    });
    
    // Early WIP check - before any expensive operations or cache usage
    // Only check WIP if we have PR info and if ALL operations would be blocked
    if (lightweightContext?.pr) {
      await this.checkWIPForAllOperations(lightweightContext.pr, options);
    }
    
    // Now check if we have cached FULL context (only if WIP check passed)
    const cachedContext =
      await this.contextGatherer.getCachedContext(identifier);
    if (cachedContext && options.config?.cache?.enabled !== false) {
      logger.debug("✓ Using cached context (WIP check passed)");
      return cachedContext;
    }

    // Determine what operations need diff data
    const needsDiff = options.operations.some(
      (op) => op === "review" || op === "security-scan" || op === "all",
    );

    const contextOptions = {
      excludePatterns: this.config.features.codeReview.excludePatterns,
      contextLines: this.config.features.codeReview.contextLines,
      forceRefresh: false,
      includeDiff: needsDiff,
      diffStrategyConfig: this.config.features.diffStrategy,
    };

    // Phase 2: fetch diffs only if really needed (WIP check already passed)
    if (needsDiff) {
      const contextWithDiff = await this.contextGatherer.gatherContext(identifier, contextOptions);
      return contextWithDiff;
    }
    
    // Return the lightweight context if no diffs needed
    return lightweightContext;
  }

  /**
   * Execute individual operation using shared context
   */
  private async executeOperation(
    operation: OperationType,
    context: UnifiedContext,
    options: OperationOptions,
  ): Promise<OperationResult> {
    const startTime = Date.now();

    try {
      // Check WIP for this specific operation
      const isWIPBlocked = await this.checkWIPForOperation(context.pr, options, operation);
      
      if (isWIPBlocked) {
        logger.info(`🚧 Operation '${operation}' skipped - WIP detected`);
        const wipConfig = this.config.features.wipDetection;
        return {
          operation,
          status: "skipped",
          data: { 
            skipped: true, 
            reason: "WIP detected in PR title",
            wipDetails: {
              prId: context.pr.id,
              prTitle: context.pr.title,
              matchedPattern: wipConfig ? this.findMatchingWIPPattern(context.pr.title, wipConfig) : "Unknown",
              action: wipConfig?.action,
              allowedOperations: wipConfig?.allowedOperationsForWIP || [],
              currentOperation: operation,
            }
          },
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString(),
        };
      }

      let data: any;

      switch (operation) {
        case "review":
          data = await this.executeCodeReview(context, options);
          break;

        case "enhance-description":
          data = await this.executeDescriptionEnhancement(context, options);
          break;

        case "security-scan":
          // TODO: Implement in future phases
          throw new Error("Security scan not implemented in Phase 1");

        case "analytics":
          // TODO: Implement in future phases
          throw new Error("Analytics not implemented in Phase 1");

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      return {
        operation,
        status: "success",
        data,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(
        `Operation ${operation} failed: ${(error as Error).message}`,
      );

      return {
        operation,
        status: "error",
        error: (error as Error).message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute code review using shared context
   */
  private async executeCodeReview(
    context: UnifiedContext,
    options: OperationOptions,
  ): Promise<any> {
    if (!this.config.features.codeReview.enabled) {
      logger.info("Code review is disabled in configuration");
      return { skipped: true, reason: "disabled in config" };
    }

    logger.phase("🔍 Executing code review...");

    const reviewOptions: ReviewOptions = {
      workspace: context.identifier.workspace,
      repository: context.identifier.repository,
      pullRequestId: context.identifier.pullRequestId!,
      dryRun: options.dryRun,
      verbose: logger.getConfig().verbose,
      excludePatterns: this.config.features.codeReview.excludePatterns,
      contextLines: this.config.features.codeReview.contextLines,
    };

    // Use the already gathered context instead of gathering again
    return await this.codeReviewer.reviewCodeWithContext(
      context,
      reviewOptions,
    );
  }

  /**
   * Execute description enhancement using shared context
   */
  private async executeDescriptionEnhancement(
    context: UnifiedContext,
    options: OperationOptions,
  ): Promise<any> {
    if (!this.config.features.descriptionEnhancement.enabled) {
      logger.info("Description enhancement is disabled in configuration");
      return { skipped: true, reason: "disabled in config" };
    }

    logger.phase("📝 Executing description enhancement...");

    const enhancementOptions: EnhancementOptions = {
      workspace: context.identifier.workspace,
      repository: context.identifier.repository,
      pullRequestId: context.identifier.pullRequestId!,
      dryRun: options.dryRun,
      verbose: logger.getConfig().verbose,
      preserveContent:
        this.config.features.descriptionEnhancement.preserveContent,
      ensureRequiredSections: true,
      customSections:
        this.config.features.descriptionEnhancement.requiredSections,
    };

    // Use the already gathered context instead of gathering again
    return await this.descriptionEnhancer.enhanceWithContext(
      context,
      enhancementOptions,
    );
  }

  /**
   * Individual operation methods for backwards compatibility
   */

  /**
   * Code review operation (standalone)
   */
  async reviewCode(options: ReviewOptions): Promise<any> {
    await this.ensureInitialized();

    const identifier: PRIdentifier = {
      workspace: options.workspace,
      repository: options.repository,
      branch: options.branch,
      pullRequestId: options.pullRequestId,
    };

    logger.operation("Code Review", "started");

    try {
      // Phase 1: gather without diffs to get PR title fast
      const contextNoDiff = await this.contextGatherer.gatherContext(identifier, {
        excludePatterns: options.excludePatterns,
        contextLines: options.contextLines,
        includeDiff: false,
        skipProjectContext: true, // Skip expensive AI processing for WIP check
      });

      // Check for WIP in standalone review as well
      const mockOperationOptions = {
        workspace: options.workspace,
        repository: options.repository,
        branch: options.branch,
        pullRequestId: options.pullRequestId,
        operations: ["review" as const],
        dryRun: options.dryRun,
        verbose: options.verbose,
      };
      
      const isWIPBlocked = await this.checkWIPForOperation(contextNoDiff.pr, mockOperationOptions, "review");
      
      if (isWIPBlocked) {
        logger.operation("Code Review", "completed");
        const wipConfig = this.config.features.wipDetection;
        return {
          violations: [],
          summary: `Review skipped - WIP detected in PR title: "${contextNoDiff.pr.title}"`,
          positiveObservations: [],
          statistics: {
            filesReviewed: 0,
            totalIssues: 0,
            criticalCount: 0,
            majorCount: 0,
            minorCount: 0,
            suggestionCount: 0,
          },
          skipped: true,
          reason: "WIP detected in PR title",
          wipDetails: {
            prId: contextNoDiff.pr.id,
            prTitle: contextNoDiff.pr.title,
            matchedPattern: wipConfig ? this.findMatchingWIPPattern(contextNoDiff.pr.title, wipConfig) : "Unknown",
            action: wipConfig?.action,
            allowedOperations: wipConfig?.allowedOperationsForWIP || [],
            currentOperation: "review",
          },
        };
      }

      // Phase 2: fetch diffs only if WIP check passed (this line only reached if no WIP)
      const contextWithDiff = await this.contextGatherer.gatherContext(identifier, {
        excludePatterns: options.excludePatterns,
        contextLines: options.contextLines,
        includeDiff: true,
      });

      const result = await this.codeReviewer.reviewCodeWithContext(
        contextWithDiff,
        options,
      );

      logger.operation("Code Review", "completed");
      return result;
    } catch (error) {
      logger.operation("Code Review", "failed");
      throw error;
    }
  }

  /**
   * Description enhancement operation (standalone)
   */
  async enhanceDescription(options: EnhancementOptions): Promise<any> {
    await this.ensureInitialized();

    const identifier: PRIdentifier = {
      workspace: options.workspace,
      repository: options.repository,
      branch: options.branch,
      pullRequestId: options.pullRequestId,
    };

    logger.operation("Description Enhancement", "started");

    try {
      // Phase 1: gather without diffs for a quick WIP check
      const contextNoDiff = await this.contextGatherer.gatherContext(identifier, {
        includeDiff: false,
        skipProjectContext: true, // Fast WIP check
      });

      // Check for WIP in standalone description enhancement as well
      const mockOperationOptions = {
        workspace: options.workspace,
        repository: options.repository,
        branch: options.branch,
        pullRequestId: options.pullRequestId,
        operations: ["enhance-description" as const],
        dryRun: options.dryRun,
        verbose: options.verbose,
      };
      
      const isWIPBlocked = await this.checkWIPForOperation(contextNoDiff.pr, mockOperationOptions, "enhance-description");
      
      if (isWIPBlocked) {
        logger.operation("Description Enhancement", "completed");
        const wipConfig = this.config.features.wipDetection;
        return {
          originalDescription: "",
          enhancedDescription: "",
          sectionsAdded: [],
          sectionsEnhanced: [],
          preservedItems: { media: 0, files: 0, links: 0 },
          statistics: {
            originalLength: 0,
            enhancedLength: 0,
            completedSections: 0,
            totalSections: 0,
          },
          skipped: true,
          reason: "WIP detected in PR title",
          wipDetails: {
            prId: contextNoDiff.pr.id,
            prTitle: contextNoDiff.pr.title,
            matchedPattern: wipConfig ? this.findMatchingWIPPattern(contextNoDiff.pr.title, wipConfig) : "Unknown",
            action: wipConfig?.action,
            allowedOperations: wipConfig?.allowedOperationsForWIP || [],
            currentOperation: "enhance-description",
          },
        };
      }

      // Phase 2: fetch diffs only if WIP check passed
      const context = await this.contextGatherer.gatherContext(identifier, {
        includeDiff: true, // Description enhancement may need to see changes
      });

      const result = await this.descriptionEnhancer.enhanceWithContext(
        context,
        options,
      );

      logger.operation("Description Enhancement", "completed");
      return result;
    } catch (error) {
      logger.operation("Description Enhancement", "failed");
      throw error;
    }
  }

  /**
   * Health check for all components
   */
  async healthCheck(): Promise<{ healthy: boolean; components: any }> {
    const components: any = {};

    try {
      // Check Bitbucket provider
      components.bitbucket = await this.bitbucketProvider.healthCheck();

      // Check cache
      components.cache = {
        healthy: true,
        stats: cache.stats(),
      };

      // Check NeuroLink (if initialized)
      components.neurolink = {
        healthy: true,
        initialized: !!this.neurolink,
      };

      const allHealthy = Object.values(components).every(
        (comp: any) => comp.healthy,
      );

      return {
        healthy: allHealthy,
        components,
      };
    } catch (error) {
      return {
        healthy: false,
        components: {
          ...components,
          error: (error as Error).message,
        },
      };
    }
  }

  /**
   * Get comprehensive statistics
   */
  getStats(): any {
    return {
      initialized: this.initialized,
      config: {
        features: Object.keys(this.config.features || {}),
        cacheEnabled: this.config.cache?.enabled,
      },
      providers: {
        bitbucket: this.bitbucketProvider?.getStats(),
        context: this.contextGatherer?.getStats(),
      },
      cache: cache.stats(),
    };
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    cache.clear();
    this.bitbucketProvider?.clearCache();
    logger.info("All caches cleared");
  }

  /**
   * Check if ALL operations would be blocked by WIP detection
   * Only throws if no operations are allowed to proceed
   */
  private async checkWIPForAllOperations(
    pr: any,
    options: OperationOptions,
  ): Promise<void> {
    const wipConfig = this.config.features.wipDetection;
    
    if (!wipConfig?.enabled) {
      return; // WIP detection is disabled
    }

    const isWIP = this.contextGatherer.detectWIP(pr, wipConfig);
    
    if (isWIP) {
      const wipPattern = this.findMatchingWIPPattern(pr.title, wipConfig);
      
      logger.warn(`🚧 WIP detected in PR title: "${pr.title}"`);
      logger.info(`Matched pattern: "${wipPattern}"`);
      
      if (wipConfig.action === "warn") {
        logger.warn("🚧 WIP detected but continuing with operations (warn mode)");
        return; // Continue processing but log the warning
      }
      
      if (wipConfig.action === "skip") {
        // Check if ANY of the requested operations are allowed for WIP PRs
        const allowedOperations = wipConfig.allowedOperationsForWIP || [];
        const requestedOperations = options.operations.includes("all") 
          ? ["review", "enhance-description"] 
          : options.operations;
        
        const hasAllowedOperation = requestedOperations.some(op => 
          allowedOperations.includes(op as any)
        );
        
        if (hasAllowedOperation) {
          logger.info("🚧 WIP detected but some operations are allowed for WIP PRs");
          return; // Allow processing to continue, individual operations will be checked
        }
        
        // No operations are allowed, throw error to skip all
        logger.info("🚧 All operations skipped - WIP detected in title");
        
        const wipError = new GuardianError(
          "WIP_DETECTED",
          `All operations skipped - WIP detected in title: "${pr.title}"`,
          {
            prId: pr.id,
            prTitle: pr.title,
            matchedPattern: wipPattern,
            action: wipConfig.action,
            allowedOperations,
            requestedOperations,
          }
        );
        
        throw wipError;
      }
    }
  }

  /**
   * Check if a specific operation should be blocked by WIP detection
   * Returns true if the operation should be skipped, false if it should proceed
   */
  private async checkWIPForOperation(
    pr: any,
    options: OperationOptions,
    currentOperation: OperationType,
  ): Promise<boolean> {
    const wipConfig = this.config.features.wipDetection;
    
    if (!wipConfig?.enabled) {
      return false; // WIP detection is disabled
    }

    const isWIP = this.contextGatherer.detectWIP(pr, wipConfig);
    
    if (!isWIP) {
      return false; // Not a WIP PR
    }
    
    if (wipConfig.action === "warn") {
      return false; // Warn mode allows all operations
    }
    
    if (wipConfig.action === "skip") {
      // Check if current operation is allowed for WIP PRs
      const allowedOperations = wipConfig.allowedOperationsForWIP || [];
      const isOperationAllowed = allowedOperations.includes(currentOperation);
      
      if (isOperationAllowed) {
        logger.info(`🚧 WIP detected but operation '${currentOperation}' is allowed for WIP PRs`);
        return false; // Allow this operation to proceed
      }
      
      return true; // Block this operation
    }
    
    return false; // Default to allowing operation
  }

  /**
   * Find which WIP pattern matched the PR title
   */
  private findMatchingWIPPattern(title: string, config: WIPDetectionConfig | undefined): string {
    if (!config) {
      return "Unknown";
    }

    const patterns = config.patterns || [
      "WIP",
      "[WIP]", 
      "Work in Progress",
      "DRAFT",
      "[DRAFT]",
      "🚧"
    ];

    const searchTitle = config.caseSensitive ? title : title.toLowerCase();

    for (const pattern of patterns) {
      const searchPattern = config.caseSensitive ? pattern : pattern.toLowerCase();
      if (searchTitle.includes(searchPattern)) {
        return pattern;
      }
    }

    return "Unknown"; // Fallback, shouldn't happen if detectWIP returned true
  }

  /**
   * Deep merge two configurations, with override taking precedence
   */
  private mergeConfigs(base: GuardianConfig, override: Partial<GuardianConfig>): GuardianConfig {
    const merged = { ...base };
    
    // Deep merge features
    if (override.features) {
      merged.features = { ...base.features };
      
      // Merge each feature section
      Object.keys(override.features).forEach(key => {
        const featureKey = key as keyof typeof override.features;
        if (override.features![featureKey]) {
          merged.features[featureKey] = {
            ...base.features[featureKey],
            ...override.features![featureKey]
          } as any;
        }
      });
    }
    
    // Deep merge providers
    if (override.providers) {
      merged.providers = { ...base.providers };
      
      if (override.providers.ai) {
        merged.providers.ai = { ...base.providers.ai, ...override.providers.ai };
      }
      
      if (override.providers.git) {
        merged.providers.git = { ...base.providers.git, ...override.providers.git };
        
        if (override.providers.git.credentials) {
          merged.providers.git.credentials = {
            ...base.providers.git.credentials,
            ...override.providers.git.credentials
          };
        }
      }
    }
    
    // Merge other top-level properties
    Object.keys(override).forEach(key => {
      if (key !== 'features' && key !== 'providers') {
        const configKey = key as keyof GuardianConfig;
        if (override[configKey] !== undefined) {
          (merged as any)[configKey] = override[configKey];
        }
      }
    });
    
    return merged;
  }

  /**
   * Ensure Guardian is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Shutdown Guardian gracefully
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down Yama...");

    // Clear caches
    this.clearCache();

    // Reset state
    this.initialized = false;

    logger.success("Yama shutdown complete");
  }
}

// Export factory function
export function createGuardian(config?: Partial<GuardianConfig>): Guardian {
  return new Guardian(config);
}

// Export default instance
export const guardian = new Guardian();
