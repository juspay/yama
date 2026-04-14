/**
 * Yama Orchestrator
 * Main entry point for AI-native autonomous code review
 */

import { NeuroLink } from "@juspay/neurolink";
import { MCPServerManager } from "./MCPServerManager.js";
import { ConfigLoader } from "../config/ConfigLoader.js";
import { PromptBuilder } from "../prompts/PromptBuilder.js";
import { SessionManager } from "./SessionManager.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { LocalDiffSource } from "./LocalDiffSource.js";
import type { LocalDiffContext } from "./LocalDiffSource.js";
import { ContextExplorerService } from "../exploration/ContextExplorerService.js";
import {
  LocalReviewFinding,
  LocalReviewRequest,
  LocalReviewResult,
  ReviewRequest,
  ReviewResult,
  ReviewMode,
  ReviewUpdate,
  ReviewStatistics,
  TokenUsage,
  UnifiedReviewRequest,
  IssuesBySeverity,
} from "../types/v2.types.js";
import { YamaConfig, YamaInitOptions } from "../types/config.types.js";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../utils/ObservabilityConfig.js";

export class YamaOrchestrator {
  private neurolink!: NeuroLink;
  private explorer: ContextExplorerService | null = null;
  private mcpManager: MCPServerManager;
  private configLoader: ConfigLoader;
  private promptBuilder: PromptBuilder;
  private sessionManager: SessionManager;
  private memoryManager: MemoryManager | null = null;
  private localDiffSource: LocalDiffSource;
  private config!: YamaConfig;
  private initialized = false;
  private mcpInitialized = false;
  private localGitMcpInitialized = false;
  private exploreToolRegistered = false;
  private currentToolContext: Record<string, unknown> | null = null;
  private initOptions: YamaInitOptions;
  private bootstrapStandardsCache: Map<string, string> = new Map();

  constructor(options: YamaInitOptions = {}) {
    this.initOptions = options;
    this.configLoader = new ConfigLoader();
    this.mcpManager = new MCPServerManager();
    this.promptBuilder = new PromptBuilder();
    this.sessionManager = new SessionManager();
    this.localDiffSource = new LocalDiffSource();
  }

  /**
   * Initialize Yama with configuration and MCP servers
   */
  async initialize(
    configPath?: string,
    mode: ReviewMode = "pr",
  ): Promise<void> {
    try {
      if (!this.initialized) {
        console.log("🚀 Initializing Yama...\n");

        // Step 1: Load configuration with SDK-style instance overrides
        const resolvedConfigPath = configPath || this.initOptions.configPath;
        this.config = await this.configLoader.loadConfig(
          resolvedConfigPath,
          this.initOptions.configOverrides,
        );

        this.showBanner();

        // Step 2: Initialize
        if (this.config.memory?.enabled) {
          this.memoryManager = new MemoryManager(
            this.config.memory,
            this.config.ai.provider,
            this.config.ai.model,
          );
          console.log("   🧠 Per-repo memory enabled\n");
        }

        // Step 3: Initialize NeuroLink with memory config injected
        console.log("🧠 Initializing NeuroLink AI engine...");
        this.neurolink = this.initializeNeurolink();
        this.explorer = new ContextExplorerService(
          this.config,
          this.sessionManager,
          this.memoryManager,
        );
        this.registerExploreTool();
        console.log("✅ NeuroLink initialized\n");

        this.initialized = true;
      }

      // Step 4: Mode-specific setup
      if (mode === "pr" && !this.mcpInitialized) {
        await this.mcpManager.setupMCPServers(
          this.neurolink,
          this.config.mcpServers,
        );
        if (this.explorer && this.config.ai.explore.enabled) {
          await this.explorer.initialize("pr");
        }
        this.mcpInitialized = true;
      } else if (mode === "local" && !this.localGitMcpInitialized) {
        await this.mcpManager.setupLocalGitMCPServer(this.neurolink);
        if (this.explorer && this.config.ai.explore.enabled) {
          await this.explorer.initialize("local");
        }
        this.localGitMcpInitialized = true;
      }

      // Step 5: Mode-specific validation
      await this.configLoader.validate(mode);

      console.log("✅ Yama initialized successfully\n");
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
    await this.ensureInitialized("pr", request.configPath);

    const startTime = Date.now();
    const sessionId = this.sessionManager.createSession(request);

    this.logReviewStart(request, sessionId);

    try {
      const bootstrapStandards = await this.getBootstrappedStandards(
        request,
        sessionId,
      );

      // Build comprehensive AI instructions
      const instructions = await this.promptBuilder.buildReviewInstructions(
        request,
        this.config,
        bootstrapStandards,
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
      this.setToolContext(toolContext);

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

      // Review call: RETRIEVE memory (for context), but DON'T STORE
      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: this.config.ai.temperature,
        maxTokens: this.config.ai.maxTokens,
        timeout: this.config.ai.timeout,
        skipToolPromptInjection: true,
        ...this.getPRToolFilteringOptions(instructions),
        context: {
          sessionId,
          userId: this.getUserId(request),
          operation: "code-review",
          metadata: toolContext.metadata,
        },
        memory: { read: true, write: false },
        enableAnalytics: this.config.ai.enableAnalytics,
        enableEvaluation: this.config.ai.enableEvaluation,
      } as unknown as Parameters<NeuroLink["generate"]>[0]);
      this.recordToolCallsFromResponse(sessionId, aiResponse);

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
   * Unified review entry for SDK consumers.
   */
  async review(
    request: UnifiedReviewRequest,
  ): Promise<ReviewResult | LocalReviewResult> {
    if (this.isLocalReviewRequest(request)) {
      return this.reviewLocalDiff(request);
    }
    return this.startReview(request);
  }

  /**
   * Local SDK mode review from git diff (no PR/MCP dependency).
   */
  async reviewLocalDiff(
    request: LocalReviewRequest,
  ): Promise<LocalReviewResult> {
    await this.ensureInitialized("local", request.configPath);

    const sessionSeed = request.repoPath || process.cwd();
    const pseudoRequest: ReviewRequest = {
      mode: "pr",
      workspace: "local",
      repository: sessionSeed.split("/").pop() || "local-repo",
      dryRun: request.dryRun,
      verbose: request.verbose,
      configPath: request.configPath,
    };
    const sessionId = this.sessionManager.createSession(pseudoRequest);
    const startTime = Date.now();

    try {
      const diffContext = this.localDiffSource.getDiffContext(request);
      const instructions =
        await this.promptBuilder.buildLocalReviewInstructions(
          request,
          this.config,
          diffContext,
        );

      const toolContext = this.createLocalToolContext(
        sessionId,
        pseudoRequest,
        diffContext,
      );
      this.setToolContext(toolContext);

      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: this.config.ai.temperature,
        maxTokens: Math.min(this.config.ai.maxTokens, 16_000),
        timeout: this.config.ai.timeout,
        enableAnalytics: this.config.ai.enableAnalytics,
        enableEvaluation: this.config.ai.enableEvaluation,
        // Request JSON output at the provider level (prompt-level mode; safe alongside tools).
        output: { format: "json" },
        // Tools are passed natively; avoids huge duplicated tool-schema prompt injection.
        skipToolPromptInjection: true,
        ...this.getLocalToolFilteringOptions(),
        context: {
          sessionId,
          userId: this.getUserId(pseudoRequest),
          operation: "local-review",
          metadata: {
            repoPath: diffContext.repoPath,
            diffSource: diffContext.diffSource,
            baseRef: diffContext.baseRef,
            headRef: diffContext.headRef,
          },
        },
      } as unknown as Parameters<NeuroLink["generate"]>[0]);
      this.recordToolCallsFromResponse(sessionId, aiResponse);

      const result = this.parseLocalReviewResult(
        aiResponse,
        sessionId,
        startTime,
        request,
        diffContext,
      );

      // Stored as generic session payload for debugging/export parity.
      this.sessionManager.completeSession(
        sessionId,
        result as unknown as ReviewResult,
      );
      return result;
    } catch (error) {
      this.sessionManager.failSession(sessionId, error as Error);
      throw error;
    }
  }

  /**
   * Stream review with real-time updates (for verbose mode)
   */
  async *streamReview(
    request: ReviewRequest,
  ): AsyncIterableIterator<ReviewUpdate> {
    await this.ensureInitialized("pr", request.configPath);

    const sessionId = this.sessionManager.createSession(request);

    try {
      const bootstrapStandards = await this.getBootstrappedStandards(
        request,
        sessionId,
      );

      // Build instructions
      const instructions = await this.promptBuilder.buildReviewInstructions(
        request,
        this.config,
        bootstrapStandards,
      );

      // Create tool context
      const toolContext = this.createToolContext(sessionId, request);
      this.setToolContext(toolContext);

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
        skipToolPromptInjection: true,
        ...this.getPRToolFilteringOptions(instructions),
        context: {
          sessionId,
          userId: this.getUserId(request),
        },
        memory: { enabled: false },
        enableAnalytics: true,
      } as unknown as Parameters<NeuroLink["generate"]>[0]);

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
    await this.ensureInitialized("pr", request.configPath);

    const startTime = Date.now();
    const sessionId = this.sessionManager.createSession(request);

    this.logReviewStart(request, sessionId);

    try {
      // ========================================================================
      // PHASE 1: Code Review
      // ========================================================================

      const bootstrapStandards = await this.getBootstrappedStandards(
        request,
        sessionId,
      );

      // Build review instructions
      const reviewInstructions =
        await this.promptBuilder.buildReviewInstructions(
          request,
          this.config,
          bootstrapStandards,
        );

      if (this.config.display.verboseToolCalls) {
        console.log("\n📝 Review instructions built:");
        console.log(
          `   Instruction length: ${reviewInstructions.length} characters\n`,
        );
      }

      // Create tool context
      const toolContext = this.createToolContext(sessionId, request);
      this.setToolContext(toolContext);

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
        skipToolPromptInjection: true,
        ...this.getPRToolFilteringOptions(reviewInstructions),
        context: {
          sessionId,
          userId: this.getUserId(request),
          operation: "code-review",
          metadata: toolContext.metadata,
        },
        memory: { read: true, write: false },
        enableAnalytics: this.config.ai.enableAnalytics,
        enableEvaluation: this.config.ai.enableEvaluation,
      } as unknown as Parameters<NeuroLink["generate"]>[0]);
      this.recordToolCallsFromResponse(sessionId, reviewResponse);

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
          skipToolPromptInjection: true,
          ...this.getPRToolFilteringOptions(enhanceInstructions),
          context: {
            sessionId, // SAME sessionId = AI remembers review context
            userId: this.getUserId(request),
            operation: "description-enhancement",
            metadata: toolContext.metadata,
          },
          memory: { enabled: false },
          enableAnalytics: this.config.ai.enableAnalytics,
          enableEvaluation: this.config.ai.enableEvaluation,
        } as unknown as Parameters<NeuroLink["generate"]>[0]);
        this.recordToolCallsFromResponse(sessionId, enhanceResponse);

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
    await this.ensureInitialized("pr", request.configPath);

    const sessionId = this.sessionManager.createSession(request);

    try {
      console.log("\n📝 Enhancing PR description...\n");

      const instructions =
        await this.promptBuilder.buildDescriptionEnhancementInstructions(
          request,
          this.config,
        );

      const toolContext = this.createToolContext(sessionId, request);
      this.setToolContext(toolContext);

      const aiResponse = await this.neurolink.generate({
        input: { text: instructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        skipToolPromptInjection: true,
        ...this.getPRToolFilteringOptions(instructions),
        context: {
          sessionId,
          userId: this.getUserId(request),
          operation: "description-enhancement",
        },
        memory: { enabled: false },
        enableAnalytics: true,
      } as unknown as Parameters<NeuroLink["generate"]>[0]);
      this.recordToolCallsFromResponse(sessionId, aiResponse);

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

  private getUserId(request: ReviewRequest): string {
    return `${request.workspace}-${request.repository}`.toLowerCase();
  }

  private createToolContext(sessionId: string, request: ReviewRequest): any {
    return {
      sessionId,
      mode: "pr",
      workspace: request.workspace,
      repository: request.repository,
      pullRequestId: request.pullRequestId,
      branch: request.branch,
      dryRun: request.dryRun || false,
      metadata: {
        yamaVersion: "2.2.1",
        startTime: new Date().toISOString(),
      },
    };
  }

  private createLocalToolContext(
    sessionId: string,
    request: ReviewRequest,
    diffContext: LocalDiffContext,
  ): any {
    return {
      sessionId,
      mode: "local",
      workspace: request.workspace,
      repository: request.repository,
      dryRun: request.dryRun || false,
      metadata: {
        yamaVersion: "2.2.1",
        startTime: new Date().toISOString(),
        repoPath: diffContext.repoPath,
        diffSource: diffContext.diffSource,
        baseRef: diffContext.baseRef,
        headRef: diffContext.headRef,
      },
    };
  }

  private setToolContext(context: Record<string, unknown>): void {
    this.currentToolContext = context;
    (this.neurolink as any).setToolContext(context);
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
      mode: "pr",
      prId: session.request.pullRequestId || 0,
      decision,
      statistics,
      summary: this.extractSummary(aiResponse),
      duration,
      tokenUsage: {
        input: this.toSafeNumber(aiResponse?.usage?.inputTokens),
        output: this.toSafeNumber(aiResponse?.usage?.outputTokens),
        total: this.toSafeNumber(aiResponse?.usage?.totalTokens),
      },
      costEstimate: this.calculateCost(aiResponse.usage),
      sessionId,
    };
  }

  private recordToolCallsFromResponse(
    sessionId: string,
    aiResponse: any,
  ): void {
    const toolCalls = Array.isArray(aiResponse?.toolCalls)
      ? aiResponse.toolCalls
      : [];
    const toolResults = Array.isArray(aiResponse?.toolResults)
      ? aiResponse.toolResults
      : [];

    for (const call of toolCalls) {
      const toolName =
        call?.toolName || call?.name || call?.tool || "unknown_tool";
      const args = call?.parameters || call?.args || {};
      const matchingResult =
        toolResults.find(
          (result: any) =>
            result?.toolCallId === call?.id || result?.toolName === toolName,
        ) || null;

      this.sessionManager.recordToolCall(
        sessionId,
        toolName,
        args,
        matchingResult,
        0,
        matchingResult?.error,
      );
    }
  }

  /**
   * Parse local SDK mode response into strict LocalReviewResult.
   */
  private parseLocalReviewResult(
    aiResponse: any,
    sessionId: string,
    startTime: number,
    request: LocalReviewRequest,
    diffContext: LocalDiffContext,
  ): LocalReviewResult {
    const rawContent = aiResponse?.content || aiResponse?.outputs?.text || "";
    const parsed = this.extractJsonPayload(rawContent);
    const usage = aiResponse?.usage || {};
    const tokenUsage: TokenUsage = {
      input: this.toSafeNumber(usage.inputTokens),
      output: this.toSafeNumber(usage.outputTokens),
      total: this.toSafeNumber(usage.totalTokens),
    };

    if (!parsed) {
      const fallbackIssue: LocalReviewFinding = {
        id: "OUTPUT_FORMAT_VIOLATION",
        severity: "MAJOR",
        category: "review-engine",
        title: "Model did not return structured JSON",
        description:
          "Local review response was unstructured (likely tool-call trace or partial output), so findings cannot be trusted.",
        suggestion:
          "Retry with a tool-calling capable model or reduce review scope (smaller diff / includePaths) to keep responses structured.",
      };
      const issuesBySeverity = this.countFindingsBySeverity([fallbackIssue]);

      return {
        mode: "local",
        decision: "CHANGES_REQUESTED",
        summary:
          this.sanitizeLocalSummary(rawContent) ||
          "Local review could not produce structured JSON output.",
        issues: [fallbackIssue],
        enhancements: [],
        statistics: {
          filesChanged: diffContext.changedFiles.length,
          additions: diffContext.additions,
          deletions: diffContext.deletions,
          issuesFound: 1,
          enhancementsFound: 0,
          issuesBySeverity,
        },
        duration: Math.round((Date.now() - startTime) / 1000),
        tokenUsage,
        costEstimate: this.calculateCost(aiResponse?.usage),
        sessionId,
        schemaVersion: request.outputSchemaVersion || "1.0",
        metadata: {
          repoPath: diffContext.repoPath,
          diffSource: diffContext.diffSource,
          baseRef: diffContext.baseRef,
          headRef: diffContext.headRef,
          truncated: diffContext.truncated,
        },
      };
    }

    const issues = this.normalizeFindings(parsed?.issues, "issue");
    const enhancements = this.normalizeFindings(
      parsed?.enhancements,
      "enhancement",
    );
    const issuesBySeverity = this.countFindingsBySeverity(issues);
    const fallbackForTruncatedNoFindings =
      diffContext.truncated && issues.length === 0 && enhancements.length === 0;
    const decision = fallbackForTruncatedNoFindings
      ? "CHANGES_REQUESTED"
      : this.normalizeDecision(parsed?.decision, issuesBySeverity);

    return {
      mode: "local",
      decision,
      summary:
        this.sanitizeLocalSummary(parsed?.summary) ||
        this.sanitizeLocalSummary(this.extractSummary(aiResponse)) ||
        "Local review completed",
      issues,
      enhancements,
      statistics: {
        filesChanged: diffContext.changedFiles.length,
        additions: diffContext.additions,
        deletions: diffContext.deletions,
        issuesFound: issues.length,
        enhancementsFound: enhancements.length,
        issuesBySeverity,
      },
      duration: Math.round((Date.now() - startTime) / 1000),
      tokenUsage,
      costEstimate: this.calculateCost(aiResponse?.usage),
      sessionId,
      schemaVersion: request.outputSchemaVersion || "1.0",
      metadata: {
        repoPath: diffContext.repoPath,
        diffSource: diffContext.diffSource,
        baseRef: diffContext.baseRef,
        headRef: diffContext.headRef,
        truncated: diffContext.truncated,
      },
    };
  }

  private sanitizeLocalSummary(summary: unknown): string {
    if (typeof summary !== "string") {
      return "";
    }
    // Use string splitting instead of backtracking [\s\S]*? regex to avoid ReDoS.
    let result = this.removeDelimitedSections(
      summary,
      "<|tool_calls_section_begin|>",
      "<|tool_calls_section_end|>",
    );
    result = this.removeDelimitedSections(
      result,
      "<|tool_call_begin|>",
      "<|tool_call_end|>",
    );
    return result.replace(/\s+/g, " ").trim();
  }

  private removeDelimitedSections(
    text: string,
    open: string,
    close: string,
  ): string {
    let result = "";
    let pos = 0;
    while (pos < text.length) {
      const start = text.indexOf(open, pos);
      if (start === -1) {
        result += text.slice(pos);
        break;
      }
      result += text.slice(pos, start);
      const end = text.indexOf(close, start + open.length);
      pos = end === -1 ? text.length : end + close.length;
    }
    return result;
  }

  private extractJsonPayload(content: string): Record<string, any> | null {
    if (!content || typeof content !== "string") {
      return null;
    }

    const trimmed = content.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to extraction strategies
    }

    // Use indexOf instead of backtracking [\s\S]*? regex to avoid ReDoS.
    const fenceOpen = trimmed.toLowerCase().indexOf("```json");
    if (fenceOpen !== -1) {
      let contentStart = fenceOpen + 7; // length of "```json"
      while (
        contentStart < trimmed.length &&
        (trimmed[contentStart] === " " ||
          trimmed[contentStart] === "\n" ||
          trimmed[contentStart] === "\r")
      ) {
        contentStart++;
      }
      const fenceClose = trimmed.indexOf("```", contentStart);
      if (fenceClose !== -1) {
        try {
          return JSON.parse(trimmed.slice(contentStart, fenceClose).trim());
        } catch {
          // Continue
        }
      }
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }

    return null;
  }

  private normalizeFindings(
    findings: unknown,
    prefix: "issue" | "enhancement",
  ): LocalReviewFinding[] {
    if (!Array.isArray(findings)) {
      return [];
    }

    return findings
      .map((raw, index) => {
        const value = (raw || {}) as Record<string, unknown>;
        const severity = this.normalizeSeverity(value.severity);
        if (!severity) {
          return null;
        }
        const lineValue =
          typeof value.line === "number" ? value.line : undefined;

        const finding: LocalReviewFinding = {
          id:
            (typeof value.id === "string" && value.id.trim()) ||
            `${prefix}-${index + 1}`,
          severity,
          category:
            (typeof value.category === "string" && value.category.trim()) ||
            "general",
          title:
            (typeof value.title === "string" && value.title.trim()) ||
            "Untitled finding",
          description:
            (typeof value.description === "string" &&
              value.description.trim()) ||
            "",
        };

        if (typeof value.filePath === "string" && value.filePath.trim()) {
          finding.filePath = value.filePath;
        }
        if (lineValue && lineValue > 0) {
          finding.line = lineValue;
        }
        if (typeof value.suggestion === "string" && value.suggestion.trim()) {
          finding.suggestion = value.suggestion;
        }

        return finding;
      })
      .filter((item): item is LocalReviewFinding => item !== null);
  }

  private normalizeSeverity(
    severity: unknown,
  ): LocalReviewFinding["severity"] | null {
    if (typeof severity !== "string") {
      return "MINOR";
    }
    const value = severity.toUpperCase();
    if (
      value === "CRITICAL" ||
      value === "MAJOR" ||
      value === "MINOR" ||
      value === "SUGGESTION"
    ) {
      return value;
    }
    return "MINOR";
  }

  private countFindingsBySeverity(
    findings: LocalReviewFinding[],
  ): IssuesBySeverity {
    const counts: IssuesBySeverity = {
      critical: 0,
      major: 0,
      minor: 0,
      suggestions: 0,
    };

    for (const finding of findings) {
      if (finding.severity === "CRITICAL") {
        counts.critical += 1;
      } else if (finding.severity === "MAJOR") {
        counts.major += 1;
      } else if (finding.severity === "MINOR") {
        counts.minor += 1;
      } else {
        counts.suggestions += 1;
      }
    }

    return counts;
  }

  private normalizeDecision(
    decision: unknown,
    issuesBySeverity: IssuesBySeverity,
  ): "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED" {
    if (typeof decision === "string") {
      const upper = decision.toUpperCase();
      if (
        upper === "APPROVED" ||
        upper === "CHANGES_REQUESTED" ||
        upper === "BLOCKED"
      ) {
        return upper;
      }
    }

    if (issuesBySeverity.critical > 0) {
      return "BLOCKED";
    }
    if (issuesBySeverity.major + issuesBySeverity.minor > 0) {
      return "CHANGES_REQUESTED";
    }
    return "APPROVED";
  }

  /**
   * Extract decision from AI response
   */
  private extractDecision(
    aiResponse: any,
    session: any,
  ): "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED" {
    // Derive final review state from tool calls.
    // Supports both current Bitbucket MCP tools and legacy names.
    const toolCalls = session.toolCalls || [];

    let requestedChanges: boolean | undefined;
    let approved: boolean | undefined;

    for (const tc of toolCalls) {
      const name = tc?.toolName;
      const args = tc?.args || {};

      if (name === "set_review_status") {
        if (typeof args.request_changes === "boolean") {
          requestedChanges = args.request_changes;
        }
      } else if (name === "request_changes") {
        requestedChanges = true;
      } else if (name === "remove_requested_changes") {
        requestedChanges = false;
      } else if (name === "set_pr_approval") {
        if (typeof args.approved === "boolean") {
          approved = args.approved;
        }
      } else if (name === "approve_pull_request") {
        approved = true;
      } else if (name === "unapprove_pull_request") {
        approved = false;
      }
    }

    if (requestedChanges === true) {
      return "BLOCKED";
    }
    if (approved === true) {
      return "APPROVED";
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

    const inputTokens = this.toSafeNumber(usage.inputTokens);
    const outputTokens = this.toSafeNumber(usage.outputTokens);

    const inputCost = (inputTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * outputCostPer1M;

    const totalCost = inputCost + outputCost;
    return Number.isFinite(totalCost) ? Number(totalCost.toFixed(4)) : 0;
  }

  private toSafeNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private isLocalReviewRequest(
    request: UnifiedReviewRequest,
  ): request is LocalReviewRequest {
    return (
      (request as LocalReviewRequest).mode === "local" ||
      (!("workspace" in request) && !("repository" in request))
    );
  }

  /**
   * Query-level tool filtering for PR mode.
   * Conservative strategy: only exclude Jira tools when there is no Jira signal.
   */
  private getPRToolFilteringOptions(inputText: string): {
    excludeTools?: string[];
  } {
    if (!this.config.ai.enableToolFiltering) {
      return {};
    }

    const mode = this.config.ai.toolFilteringMode || "active";
    if (mode === "off") {
      return {};
    }

    const hasJiraSignal =
      /\b[A-Z]{2,}-\d+\b/.test(inputText) || /\bjira\b/i.test(inputText);

    if (hasJiraSignal) {
      return {};
    }

    try {
      const externalTools = (this.neurolink as any).getExternalMCPTools?.();
      const jiraToolNames = Array.isArray(externalTools)
        ? externalTools
            .filter((tool: any) => tool?.serverId === "jira")
            .map((tool: any) => tool?.name)
            .filter((name: unknown): name is string => typeof name === "string")
        : [];

      if (jiraToolNames.length === 0) {
        return {};
      }

      if (mode === "log-only") {
        console.log(
          `   [tool-filter] log-only: would exclude ${jiraToolNames.length} Jira tools`,
        );
        return {};
      }

      return { excludeTools: jiraToolNames };
    } catch {
      // Non-fatal: fallback to all tools.
      return {};
    }
  }

  /**
   * Query-level read-only filtering for local-git MCP tools.
   * Uses regex-based mutation detection instead of hardcoded tool-name lists.
   */
  private getLocalToolFilteringOptions(): { excludeTools?: string[] } {
    try {
      const externalTools = (this.neurolink as any).getExternalMCPTools?.();
      if (!Array.isArray(externalTools)) {
        return {};
      }

      const mutatingGitToolPattern =
        /^git_(commit|push|add|checkout|create_branch|merge|rebase|cherry_pick|reset|revert|tag|rm|clean|stash|apply)\b/i;
      // High-volume read operations can flood context with huge payloads.
      const highVolumeGitToolPattern =
        /^git_(diff|diff_staged|diff_unstaged|log|show)\b/i;

      const excludeTools = externalTools
        .filter((tool: any) => tool?.serverId === "local-git")
        .map((tool: any) => tool?.name)
        .filter((name: unknown): name is string => typeof name === "string")
        .filter(
          (name: string) =>
            mutatingGitToolPattern.test(this.normalizeToolName(name)) ||
            highVolumeGitToolPattern.test(this.normalizeToolName(name)),
        );

      if (excludeTools.length === 0) {
        return {};
      }

      return { excludeTools };
    } catch {
      return {};
    }
  }

  private normalizeToolName(name: string): string {
    return name.split(/[.:/]/).pop() || name;
  }

  /**
   * Initialize NeuroLink with observability configuration
   */
  private initializeNeurolink(): NeuroLink {
    try {
      const observabilityConfig = buildObservabilityConfigFromEnv();

      const conversationMemory: Record<string, unknown> = {
        ...this.config.ai.conversationMemory,
      };
      if (this.memoryManager) {
        conversationMemory.memory =
          this.memoryManager.buildNeuroLinkMemoryConfig();
      }

      const neurolinkConfig: Record<string, unknown> = {
        conversationMemory,
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

  private registerExploreTool(): void {
    if (this.exploreToolRegistered || !this.config.ai.explore.enabled) {
      return;
    }

    this.neurolink.registerTool("explore_context", {
      name: "explore_context",
      description:
        "Delegate non-trivial research to an isolated Explore worker. Use it for function definitions, project-wide search, logic tracing, commit history, rules/context lookup, or any analysis that would otherwise require broad manual scanning.",
      inputSchema: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The exact research task for Explore to investigate and answer.",
          },
          focus: {
            type: "array",
            description:
              "Optional list of files, symbols, commits, tickets, or context areas Explore should prioritize.",
            items: {
              type: "string",
            },
          },
        },
        required: ["task"],
      },
      execute: async (params: unknown, context?: unknown) => {
        if (!this.explorer) {
          throw new Error("Explore service is not initialized");
        }

        const rawParams = (params || {}) as Record<string, unknown>;
        const mergedContext = {
          ...(this.currentToolContext || {}),
          ...((context && typeof context === "object"
            ? (context as Record<string, unknown>)
            : {}) as Record<string, unknown>),
        };

        const runtimeMode: "pr" | "local" =
          mergedContext.mode === "local" ? "local" : "pr";

        const runtimeContext = {
          sessionId: String(
            mergedContext.sessionId || this.currentToolContext?.sessionId || "",
          ),
          mode: runtimeMode,
          workspace: String(mergedContext.workspace || "local"),
          repository: String(mergedContext.repository || "repository"),
          pullRequestId:
            typeof mergedContext.pullRequestId === "number"
              ? mergedContext.pullRequestId
              : undefined,
          branch:
            typeof mergedContext.branch === "string"
              ? mergedContext.branch
              : undefined,
          dryRun:
            typeof mergedContext.dryRun === "boolean"
              ? mergedContext.dryRun
              : false,
          metadata:
            mergedContext.metadata &&
            typeof mergedContext.metadata === "object" &&
            !Array.isArray(mergedContext.metadata)
              ? (mergedContext.metadata as Record<string, unknown>)
              : {},
        };

        const focus = Array.isArray(rawParams.focus)
          ? rawParams.focus.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined;

        const { result, cached } = await this.explorer.explore(
          {
            task: String(rawParams.task || "").trim(),
            focus,
          },
          runtimeContext,
        );

        return {
          success: true,
          data: {
            ...result,
            cached,
          },
        };
      },
    });

    this.exploreToolRegistered = true;
  }

  /**
   * Bootstrap repo-level standards by delegating to explore_context.
   * Runs once per (workspace/repository) per process lifetime.
   * Output is injected into the review prompt as <bootstrapped-standards>.
   * Graceful: any failure returns empty and the review proceeds without it.
   */
  private async getBootstrappedStandards(
    request: ReviewRequest,
    sessionId: string,
  ): Promise<string> {
    if (!this.config.ai.explore.enabled || !this.explorer) {
      return "";
    }

    const cacheKey = `${request.workspace}/${request.repository}`.toLowerCase();
    const cached = this.bootstrapStandardsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const task = `Bootstrap repo review standards for ${request.workspace}/${request.repository}. Inspect the last 15 merged pull requests on this repository. For each, collect inline and summary comments left by HUMAN reviewers (ignore bot authors like "Yama", "yama-bot", "yama-review", "euler.bot"). Focus on comments that asked for code changes, flagged bugs, pushed back on an approach, or cited a convention. Distill the recurring patterns and anti-patterns the human reviewers care about — especially things that a static config rule set would miss (naming, error-handling idioms, module boundaries, test expectations, migration rules, review etiquette). Return a concise bullet list of 10-20 patterns. Each bullet: one sentence stating the pattern, optionally one sentence of rationale. Do NOT include PR numbers, author names, or raw quotes — just distilled patterns.`;

    try {
      console.log(
        `   🧭 Bootstrapping repo standards from recent PRs (one-time per process)...`,
      );
      const { result } = await this.explorer.explore(
        { task, focus: [request.repository] },
        {
          sessionId,
          mode: "pr",
          workspace: request.workspace,
          repository: request.repository,
          pullRequestId: request.pullRequestId,
          branch: request.branch,
          dryRun: request.dryRun || false,
          metadata: { bootstrap: true },
        },
      );

      const parts: string[] = [];
      if (result.summary && result.summary.trim().length > 0) {
        parts.push(result.summary.trim());
      }
      if (result.findings && result.findings.length > 0) {
        const bullets = result.findings.map((f) => `- ${f.claim}`).join("\n");
        parts.push(bullets);
      }
      const combined = parts.join("\n\n").trim();

      if (combined.length > 0) {
        console.log(
          `   ✅ Bootstrap standards ready (${combined.length} chars)`,
        );
        if (this.config.display.verboseToolCalls) {
          console.log("   ───────── bootstrapped-standards ─────────");
          for (const line of combined.split("\n")) {
            console.log(`   ${line}`);
          }
          console.log("   ──────────────────────────────────────────");
        }
      } else {
        console.log(
          `   ⚠️  Bootstrap returned no standards — proceeding without them`,
        );
      }

      this.bootstrapStandardsCache.set(cacheKey, combined);
      return combined;
    } catch (error) {
      console.warn(
        `   ⚠️  Bootstrap standards failed, proceeding without: ${(error as Error).message}`,
      );
      this.bootstrapStandardsCache.set(cacheKey, "");
      return "";
    }
  }

  /**
   * Ensure orchestrator is initialized
   */
  private async ensureInitialized(
    mode: ReviewMode = "pr",
    configPath?: string,
  ): Promise<void> {
    await this.initialize(configPath, mode);
  }

  /**
   * Show Yama banner
   */
  private showBanner(): void {
    if (!this.config?.display?.showBanner) {
      return;
    }

    console.log("\n" + "═".repeat(60));
    console.log(`
    ⚔️  YAMA - AI-Native Code Review Guardian

    Version: 2.2.1
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
export function createYamaV2(options: YamaInitOptions = {}): YamaOrchestrator {
  return createYama(options);
}

export function createYama(options: YamaInitOptions = {}): YamaOrchestrator {
  return new YamaOrchestrator(options);
}

export { YamaOrchestrator as YamaV2Orchestrator };
