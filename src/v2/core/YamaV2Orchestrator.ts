/**
 * Yama V2 Orchestrator
 * Main entry point for AI-native autonomous code review
 */

import { NeuroLink } from "@juspay/neurolink";
import { MCPServerManager } from "./MCPServerManager.js";
import { ConfigLoader } from "../config/ConfigLoader.js";
import { PromptBuilder } from "../prompts/PromptBuilder.js";
import { SessionManager } from "./SessionManager.js";
import {
  ReviewRequest,
  ReviewResult,
  ReviewUpdate,
  YamaV2Error,
  ReviewStatistics,
  IssuesBySeverity,
} from "../types/v2.types.js";
import { YamaV2Config } from "../types/config.types.js";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../utils/ObservabilityConfig.js";

export class YamaV2Orchestrator {
  private neurolink!: NeuroLink;
  private mcpManager: MCPServerManager;
  private configLoader: ConfigLoader;
  private promptBuilder: PromptBuilder;
  private sessionManager: SessionManager;
  private config!: YamaV2Config;
  private initialized = false;

  constructor() {
    this.configLoader = new ConfigLoader();
    this.mcpManager = new MCPServerManager();
    this.promptBuilder = new PromptBuilder();
    this.sessionManager = new SessionManager();
  }

  /**
   * Initialize Yama V2 with configuration and MCP servers
   */
  async initialize(configPath?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.showBanner();
    console.log("🚀 Initializing Yama V2...\n");

    try {
      // Step 1: Load configuration
      this.config = await this.configLoader.loadConfig(configPath);

      // Step 2: Initialize NeuroLink with observability
      console.log("🧠 Initializing NeuroLink AI engine...");
      this.neurolink = this.initializeNeurolink();
      console.log("✅ NeuroLink initialized\n");

      // Step 3: Setup MCP servers
      await this.mcpManager.setupMCPServers(
        this.neurolink,
        this.config.mcpServers,
      );
      console.log("✅ MCP servers ready (tools managed by NeuroLink)\n");

      // Step 4: Validate configuration
      await this.configLoader.validate();

      this.initialized = true;
      console.log("✅ Yama V2 initialized successfully\n");
      console.log("═".repeat(60) + "\n");
    } catch (error) {
      console.error("\n❌ Initialization failed:", (error as Error).message);
      throw error;
    }
  }

  /**
   * Start autonomous AI review
   */
  async startReview(request: ReviewRequest): Promise<ReviewResult> {
    await this.ensureInitialized();

    const startTime = Date.now();
    const sessionId = this.sessionManager.createSession(request);

    this.logReviewStart(request, sessionId);

    try {
      // Build comprehensive AI instructions
      const instructions = await this.promptBuilder.buildReviewInstructions(
        request,
        this.config,
      );

      if (this.config.display.verboseToolCalls) {
        console.log("\n📝 AI Instructions built:");
        console.log(
          `   Instruction length: ${instructions.length} characters\n`,
        );
      }

      // Create tool context for AI
      const toolContext = this.createToolContext(sessionId, request);

      // Set tool context in NeuroLink (using type assertion as setToolContext is documented but may not be in type definitions)
      (this.neurolink as any).setToolContext(toolContext);

      // Update session metadata
      this.sessionManager.updateMetadata(sessionId, {
        aiProvider: this.config.ai.provider,
        aiModel: this.config.ai.model,
      });

      // Execute autonomous AI review
      console.log("🤖 Starting autonomous AI review...");
      console.log(
        "   AI will now make decisions and execute actions autonomously\n",
      );

      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: this.config.ai.temperature,
        maxTokens: this.config.ai.maxTokens,
        timeout: this.config.ai.timeout,
        context: {
          sessionId,
          userId: this.generateUserId(request),
          operation: "code-review",
          metadata: toolContext.metadata,
        },
        enableAnalytics: this.config.ai.enableAnalytics,
        enableEvaluation: this.config.ai.enableEvaluation,
      });

      // Extract and parse results
      const result = this.parseReviewResult(aiResponse, startTime, sessionId);

      // Update session with results
      this.sessionManager.completeSession(sessionId, result);

      this.logReviewComplete(result);

      return result;
    } catch (error) {
      this.sessionManager.failSession(sessionId, error as Error);
      console.error("\n❌ Review failed:", (error as Error).message);
      throw error;
    }
  }

  /**
   * Stream review with real-time updates (for verbose mode)
   */
  async *streamReview(
    request: ReviewRequest,
  ): AsyncIterableIterator<ReviewUpdate> {
    await this.ensureInitialized();

    const sessionId = this.sessionManager.createSession(request);

    try {
      // Build instructions
      const instructions = await this.promptBuilder.buildReviewInstructions(
        request,
        this.config,
      );

      // Create tool context
      const toolContext = this.createToolContext(sessionId, request);
      (this.neurolink as any).setToolContext(toolContext);

      // Stream AI execution
      yield {
        type: "progress",
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: "context_gathering",
          progress: 0,
          message: "Starting review...",
        },
      };

      // Note: NeuroLink streaming implementation depends on version
      // This is a placeholder for streaming functionality
      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        context: {
          sessionId,
          userId: this.generateUserId(request),
        },
        enableAnalytics: true,
      });

      yield {
        type: "progress",
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: "decision_making",
          progress: 100,
          message: "Review complete",
        },
      };
    } catch (error) {
      this.sessionManager.failSession(sessionId, error as Error);
      throw error;
    }
  }

  /**
   * Start review and then enhance description in the same session
   * This allows the AI to use knowledge gained during review to write better descriptions
   */
  async startReviewAndEnhance(request: ReviewRequest): Promise<ReviewResult> {
    await this.ensureInitialized();

    const startTime = Date.now();
    const sessionId = this.sessionManager.createSession(request);

    this.logReviewStart(request, sessionId);

    try {
      // ========================================================================
      // PHASE 1: Code Review
      // ========================================================================

      // Build review instructions
      const reviewInstructions =
        await this.promptBuilder.buildReviewInstructions(request, this.config);

      if (this.config.display.verboseToolCalls) {
        console.log("\n📝 Review instructions built:");
        console.log(
          `   Instruction length: ${reviewInstructions.length} characters\n`,
        );
      }

      // Create tool context
      const toolContext = this.createToolContext(sessionId, request);
      (this.neurolink as any).setToolContext(toolContext);

      // Update session metadata
      this.sessionManager.updateMetadata(sessionId, {
        aiProvider: this.config.ai.provider,
        aiModel: this.config.ai.model,
      });

      // Execute review
      console.log("🤖 Phase 1: Starting autonomous AI code review...");
      console.log("   AI will analyze files and post comments\n");

      const reviewResponse = await this.neurolink.generate({
        input: { text: reviewInstructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: this.config.ai.temperature,
        maxTokens: this.config.ai.maxTokens,
        timeout: this.config.ai.timeout,
        context: {
          sessionId,
          userId: this.generateUserId(request),
          operation: "code-review",
          metadata: toolContext.metadata,
        },
        enableAnalytics: this.config.ai.enableAnalytics,
        enableEvaluation: this.config.ai.enableEvaluation,
      });

      // Parse review results
      const reviewResult = this.parseReviewResult(
        reviewResponse,
        startTime,
        sessionId,
      );

      console.log("\n✅ Phase 1 complete: Code review finished");
      console.log(`   Decision: ${reviewResult.decision}`);
      console.log(`   Comments: ${reviewResult.statistics.totalComments}\n`);

      // ========================================================================
      // PHASE 2: Description Enhancement (using same session)
      // ========================================================================

      if (this.config.descriptionEnhancement.enabled) {
        console.log("📝 Phase 2: Enhancing PR description...");
        console.log("   AI will use review insights to write description\n");

        const enhanceInstructions =
          await this.promptBuilder.buildDescriptionEnhancementInstructions(
            request,
            this.config,
          );

        // Continue the SAME session - AI remembers everything from review
        const enhanceResponse = await this.neurolink.generate({
          input: { text: enhanceInstructions },
          provider: this.config.ai.provider,
          model: this.config.ai.model,
          temperature: this.config.ai.temperature,
          maxTokens: this.config.ai.maxTokens,
          timeout: this.config.ai.timeout,
          context: {
            sessionId, // SAME sessionId = AI remembers review context
            userId: this.generateUserId(request),
            operation: "description-enhancement",
            metadata: toolContext.metadata,
          },
          enableAnalytics: this.config.ai.enableAnalytics,
          enableEvaluation: this.config.ai.enableEvaluation,
        });

        console.log("✅ Phase 2 complete: Description enhanced\n");

        // Add enhancement status to result
        reviewResult.descriptionEnhanced = true;
      } else {
        console.log(
          "⏭️  Skipping description enhancement (disabled in config)\n",
        );
        reviewResult.descriptionEnhanced = false;
      }

      // Update session with final results
      this.sessionManager.completeSession(sessionId, reviewResult);

      this.logReviewComplete(reviewResult);

      return reviewResult;
    } catch (error) {
      this.sessionManager.failSession(sessionId, error as Error);
      console.error("\n❌ Review failed:", (error as Error).message);
      throw error;
    }
  }

  /**
   * Enhance PR description only (without full review)
   */
  async enhanceDescription(request: ReviewRequest): Promise<any> {
    await this.ensureInitialized();

    const sessionId = this.sessionManager.createSession(request);

    try {
      console.log("\n📝 Enhancing PR description...\n");

      const instructions =
        await this.promptBuilder.buildDescriptionEnhancementInstructions(
          request,
          this.config,
        );

      const toolContext = this.createToolContext(sessionId, request);
      (this.neurolink as any).setToolContext(toolContext);

      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        context: {
          sessionId,
          userId: this.generateUserId(request),
          operation: "description-enhancement",
        },
        enableAnalytics: true,
      });

      console.log("✅ Description enhanced successfully\n");

      return {
        success: true,
        enhanced: true,
        sessionId,
      };
    } catch (error) {
      this.sessionManager.failSession(sessionId, error as Error);
      throw error;
    }
  }

  /**
   * Get session information
   */
  getSession(sessionId: string) {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string) {
    return this.sessionManager.getSessionStats(sessionId);
  }

  /**
   * Export session data
   */
  exportSession(sessionId: string) {
    return this.sessionManager.exportSession(sessionId);
  }

  /**
   * Create tool context for AI
   */
  private createToolContext(sessionId: string, request: ReviewRequest): any {
    return {
      sessionId,
      workspace: request.workspace,
      repository: request.repository,
      pullRequestId: request.pullRequestId,
      branch: request.branch,
      dryRun: request.dryRun || false,
      metadata: {
        yamaVersion: "2.0.0",
        startTime: new Date().toISOString(),
      },
    };
  }

  /**
   * Parse AI response into structured review result
   */
  private parseReviewResult(
    aiResponse: any,
    startTime: number,
    sessionId: string,
  ): ReviewResult {
    const session = this.sessionManager.getSession(sessionId);
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Extract decision from AI response or tool calls
    const decision = this.extractDecision(aiResponse, session);

    // Calculate statistics from session tool calls
    const statistics = this.calculateStatistics(session);

    return {
      prId: session.request.pullRequestId || 0,
      decision,
      statistics,
      summary: this.extractSummary(aiResponse),
      duration,
      tokenUsage: {
        input: aiResponse.usage?.inputTokens || 0,
        output: aiResponse.usage?.outputTokens || 0,
        total: aiResponse.usage?.totalTokens || 0,
      },
      costEstimate: this.calculateCost(aiResponse.usage),
      sessionId,
    };
  }

  /**
   * Extract decision from AI response
   */
  private extractDecision(
    aiResponse: any,
    session: any,
  ): "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED" {
    // Check if AI called approve_pull_request or request_changes
    const toolCalls = session.toolCalls || [];

    const approveCall = toolCalls.find(
      (tc: any) => tc.toolName === "approve_pull_request",
    );
    const requestChangesCall = toolCalls.find(
      (tc: any) => tc.toolName === "request_changes",
    );

    if (approveCall) {
      return "APPROVED";
    }
    if (requestChangesCall) {
      return "BLOCKED";
    }

    // Default to changes requested if unclear
    return "CHANGES_REQUESTED";
  }

  /**
   * Calculate statistics from session
   */
  private calculateStatistics(session: any): ReviewStatistics {
    const toolCalls = session.toolCalls || [];

    // Count file diffs read
    const filesReviewed = toolCalls.filter(
      (tc: any) => tc.toolName === "get_pull_request_diff",
    ).length;

    // Try to extract issue counts from comments
    const commentCalls = toolCalls.filter(
      (tc: any) => tc.toolName === "add_comment",
    );
    const issuesFound = this.extractIssueCountsFromComments(commentCalls);

    return {
      filesReviewed,
      issuesFound,
      requirementCoverage: 0, // Would need to parse from Jira comparison
      codeQualityScore: 0, // Would need AI to provide this
      toolCallsMade: toolCalls.length,
      cacheHits: 0,
      totalComments: commentCalls.length,
    };
  }

  /**
   * Extract issue counts from comment tool calls
   */
  private extractIssueCountsFromComments(
    commentCalls: any[],
  ): IssuesBySeverity {
    const counts: IssuesBySeverity = {
      critical: 0,
      major: 0,
      minor: 0,
      suggestions: 0,
    };

    commentCalls.forEach((call) => {
      const text = call.args?.comment_text || "";

      if (text.includes("🔒 CRITICAL") || text.includes("CRITICAL:")) {
        counts.critical++;
      } else if (text.includes("⚠️ MAJOR") || text.includes("MAJOR:")) {
        counts.major++;
      } else if (text.includes("💡 MINOR") || text.includes("MINOR:")) {
        counts.minor++;
      } else if (
        text.includes("💬 SUGGESTION") ||
        text.includes("SUGGESTION:")
      ) {
        counts.suggestions++;
      }
    });

    return counts;
  }

  /**
   * Extract summary from AI response
   */
  private extractSummary(aiResponse: any): string {
    return aiResponse.content || aiResponse.text || "Review completed";
  }

  /**
   * Calculate cost estimate from token usage
   */
  private calculateCost(usage: any): number {
    if (!usage) {
      return 0;
    }

    // Rough estimates (update with actual pricing)
    const inputCostPer1M = 0.25; // $0.25 per 1M input tokens (Gemini 2.0 Flash)
    const outputCostPer1M = 1.0; // $1.00 per 1M output tokens

    const inputCost = (usage.inputTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (usage.outputTokens / 1_000_000) * outputCostPer1M;

    return Number((inputCost + outputCost).toFixed(4));
  }

  /**
   * Generate userId for NeuroLink context from repository and branch/PR
   */
  private generateUserId(request: ReviewRequest): string {
    const repo = request.repository;
    const identifier = request.branch || `pr-${request.pullRequestId}`;
    return `${repo}-${identifier}`;
  }

  /**
   * Initialize NeuroLink with observability configuration
   */
  private initializeNeurolink(): NeuroLink {
    try {
      const observabilityConfig = buildObservabilityConfigFromEnv();

      const neurolinkConfig: any = {
        conversationMemory: this.config.ai.conversationMemory,
      };

      if (observabilityConfig) {
        // Validate observability config
        if (!validateObservabilityConfig(observabilityConfig)) {
          throw new Error("Invalid observability configuration");
        }

        neurolinkConfig.observability = observabilityConfig;
        console.log("   📊 Observability enabled (Langfuse tracing active)");
      } else {
        console.log(
          "   📊 Observability not configured (set LANGFUSE_* env vars to enable)",
        );
      }

      const neurolink = new NeuroLink(neurolinkConfig);
      return neurolink;
    } catch (error) {
      console.error(
        "❌ Failed to initialize NeuroLink:",
        (error as Error).message,
      );
      throw new Error(`NeuroLink initialization failed: ${error}`);
    }
  }

  /**
   * Ensure orchestrator is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Show Yama V2 banner
   */
  private showBanner(): void {
    if (!this.config?.display?.showBanner) {
      return;
    }

    console.log("\n" + "═".repeat(60));
    console.log(`
    ⚔️  YAMA V2 - AI-Native Code Review Guardian

    Version: 2.0.0
    Mode: Autonomous AI-Powered Review
    Powered by: NeuroLink + MCP Tools
    `);
    console.log("═".repeat(60) + "\n");
  }

  /**
   * Log review start
   */
  private logReviewStart(request: ReviewRequest, sessionId: string): void {
    console.log("\n" + "─".repeat(60));
    console.log(`📋 Review Session Started`);
    console.log("─".repeat(60));
    console.log(`   Session ID: ${sessionId}`);
    console.log(`   Workspace: ${request.workspace}`);
    console.log(`   Repository: ${request.repository}`);
    console.log(`   PR: ${request.pullRequestId || request.branch}`);
    console.log(`   Mode: ${request.dryRun ? "🔵 DRY RUN" : "🔴 LIVE"}`);
    console.log("─".repeat(60) + "\n");
  }

  /**
   * Log review completion
   */
  private logReviewComplete(result: ReviewResult): void {
    console.log("\n" + "═".repeat(60));
    console.log(`✅ Review Completed Successfully`);
    console.log("═".repeat(60));
    console.log(`   Decision: ${this.formatDecision(result.decision)}`);
    console.log(`   Duration: ${result.duration}s`);
    console.log(`   Files Reviewed: ${result.statistics.filesReviewed}`);
    console.log(`   Issues Found:`);
    console.log(`     🔒 CRITICAL: ${result.statistics.issuesFound.critical}`);
    console.log(`     ⚠️  MAJOR: ${result.statistics.issuesFound.major}`);
    console.log(`     💡 MINOR: ${result.statistics.issuesFound.minor}`);
    console.log(
      `     💬 SUGGESTIONS: ${result.statistics.issuesFound.suggestions}`,
    );
    console.log(`   Token Usage: ${result.tokenUsage.total.toLocaleString()}`);
    console.log(`   Cost Estimate: $${result.costEstimate.toFixed(4)}`);
    console.log("═".repeat(60) + "\n");
  }

  /**
   * Format decision for display
   */
  private formatDecision(decision: string): string {
    switch (decision) {
      case "APPROVED":
        return "✅ APPROVED";
      case "BLOCKED":
        return "🚫 BLOCKED";
      case "CHANGES_REQUESTED":
        return "⚠️  CHANGES REQUESTED";
      default:
        return decision;
    }
  }
}

// Export factory function
export function createYamaV2(): YamaV2Orchestrator {
  return new YamaV2Orchestrator();
}
