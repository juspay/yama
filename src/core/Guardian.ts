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
} from "../types";

import { BitbucketProvider } from "./providers/BitbucketProvider";
import { ContextGatherer, UnifiedContext } from "./ContextGatherer";
import { CodeReviewer } from "../features/CodeReviewer";
import { DescriptionEnhancer } from "../features/DescriptionEnhancer";

import { logger } from "../utils/Logger";
import { configManager } from "../utils/ConfigManager";
import { cache } from "../utils/Cache";

export class Guardian {
  private config: GuardianConfig;
  private bitbucketProvider!: BitbucketProvider;
  private contextGatherer!: ContextGatherer;
  private codeReviewer!: CodeReviewer;
  private descriptionEnhancer!: DescriptionEnhancer;
  private neurolink!: any;
  private initialized = false;

  constructor(config?: Partial<GuardianConfig>) {
    this.config = {} as GuardianConfig;
    if (config) {
      this.config = { ...this.config, ...config };
    }
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

      // Load configuration
      this.config = await configManager.loadConfig(configPath);

      // Initialize providers
      this.bitbucketProvider = new BitbucketProvider(
        this.config.providers.git.credentials,
      );
      await this.bitbucketProvider.initialize();

      // Initialize NeuroLink with eval-based dynamic import to bypass TypeScript compilation
      const dynamicImport = eval("(specifier) => import(specifier)");
      const { NeuroLink } = await dynamicImport("@juspay/neurolink");
      this.neurolink = new NeuroLink();

      // Initialize core components
      this.contextGatherer = new ContextGatherer(
        this.bitbucketProvider,
        this.config.providers.ai,
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

    // Check if we have cached context first
    const cachedContext =
      await this.contextGatherer.getCachedContext(identifier);
    if (cachedContext && options.config?.cache?.enabled !== false) {
      logger.debug("✓ Using cached context");
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

    return await this.contextGatherer.gatherContext(identifier, contextOptions);
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
      // Gather context specifically for code review
      const context = await this.contextGatherer.gatherContext(identifier, {
        excludePatterns: options.excludePatterns,
        contextLines: options.contextLines,
        includeDiff: true,
      });

      const result = await this.codeReviewer.reviewCodeWithContext(
        context,
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
      // Gather context specifically for description enhancement
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
