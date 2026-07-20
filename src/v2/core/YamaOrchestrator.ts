/**
 * Yama Orchestrator
 * Main entry point for AI-native autonomous code review
 */

import { NeuroLink } from "@juspay/neurolink";
import { MCPServerManager } from "./MCPServerManager.js";
import { McpRegistry } from "./McpRegistry.js";
import { ConfigLoader } from "../config/ConfigLoader.js";
import { PromptBuilder } from "../prompts/PromptBuilder.js";
import { SessionManager } from "./SessionManager.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { LocalDiffSource } from "./LocalDiffSource.js";

import { ContextExplorerService } from "../exploration/ContextExplorerService.js";
import { ProviderDetector } from "../utils/ProviderDetector.js";
import {
  LocalDiffContext,
  VCSProvider,
  LocalReviewRequest,
  LocalReviewResult,
  ReviewRequest,
  ReviewResult,
  ReviewMode,
  UnifiedReviewRequest,
  EnhancementResult,
} from "../types/index.js";
import {
  MCPServersConfig,
  YamaConfig,
  YamaInitOptions,
} from "../types/index.js";
import { NeuroLinkFactory } from "./NeuroLinkFactory.js";
import { ReviewResultParser } from "./ReviewResultParser.js";
import {
  isVerdictShaped,
  localReviewVerdictSchema,
  prReviewVerdictSchema,
} from "./reviewSchema.js";
import { clampMaxTokens } from "../utils/tokenLimits.js";
import { parseDurationMs } from "../utils/duration.js";
import {
  buildFindingId,
  collectSuppressedIds,
  createStateStore,
  formatOpenFindingsForPrompt,
  reconcileFindings,
  type ReviewStateStore,
} from "../state/ReviewStateStore.js";
import { Critic } from "../harness/Critic.js";
import {
  RuleLoader,
  compileRulesForPrompt,
  computeRuleCompliance,
  hasBlockingRuleViolation,
} from "../rules/RuleLoader.js";
import { RulesContextLoader } from "../exploration/RulesContextLoader.js";
import type { YamaRule } from "../types/index.js";
import { gateFindings } from "../harness/submitReviewGate.js";
import type { SubmitReviewAccepted, SubmittedFinding } from "../types/index.js";
import { isMutatingGitTool, normalizeToolName } from "../utils/toolPolicy.js";
import { VERSION } from "../utils/version.js";

export class YamaOrchestrator {
  private neurolink!: NeuroLink;
  private explorer: ContextExplorerService | null = null;
  private mcpManager: MCPServerManager;
  private configLoader: ConfigLoader;
  private promptBuilder: PromptBuilder;
  private sessionManager: SessionManager;
  private resultParser: ReviewResultParser;
  private memoryManager: MemoryManager | null = null;
  private localDiffSource: LocalDiffSource;
  private stateStore: ReviewStateStore | null = null;
  private config!: YamaConfig;
  private initialized = false;
  private mcpInitialized = false;
  // Review mode the MCP servers were last registered for; re-register if a
  // reused instance switches between "pr" and "local".
  private mcpMode: ReviewMode | null = null;
  private exploreToolRegistered = false;
  private submitToolRegistered = false;
  private critic: Critic | null = null;
  /** Open finding ids from prior runs on the current PR (state-driven dedup). */
  private previousOpenIds = new Set<string>();
  /** Finding ids accepted by submit_review during the current run. */
  private acceptedFindingIds = new Set<string>();
  /** Learned false positives (dismissed / ignored 3+ runs) — never re-posted. */
  private suppressedFindingIds = new Set<string>();
  private currentToolContext: Record<string, unknown> | null = null;
  private initOptions: YamaInitOptions;
  private bootstrapStandardsCache: Map<string, string> = new Map();
  private loadedRules: YamaRule[] = [];
  private projectDocsCache: string | null | undefined;
  private detectedProvider: VCSProvider = "bitbucket";

  constructor(options: YamaInitOptions = {}) {
    this.initOptions = options;
    this.configLoader = new ConfigLoader();
    this.mcpManager = new MCPServerManager();
    this.promptBuilder = new PromptBuilder();
    this.sessionManager = new SessionManager(VERSION);
    this.resultParser = new ReviewResultParser(this.sessionManager);
    this.localDiffSource = new LocalDiffSource();
  }

  /**
   * Initialize Yama with configuration and MCP servers
   */
  async initialize(
    configPath?: string,
    mode: ReviewMode = "pr",
    request?: ReviewRequest,
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

        this.stateStore = createStateStore(this.config.state);
        if (this.stateStore) {
          console.log(
            `   🗂️  Review state enabled (store: ${this.stateStore.kind})`,
          );
        }

        // Step 3: Initialize NeuroLink with memory config injected
        console.log("🧠 Initializing NeuroLink AI engine...");
        this.neurolink = this.initializeNeurolink();
        this.explorer = new ContextExplorerService(
          this.config,
          this.sessionManager,
          this.memoryManager,
        );
        this.loadedRules = await new RuleLoader().load();
        if (this.loadedRules.length > 0) {
          console.log(
            `   📏 Loaded ${this.loadedRules.length} team rule(s) from .yama/rules ` +
              `(${this.loadedRules.filter((r) => r.blocking).length} blocking)`,
          );
        }
        this.registerExploreTool();
        this.critic = new Critic(
          NeuroLinkFactory.create({ conversationMemory: false }),
          this.config,
          this.explorer,
        );
        this.registerSubmitReviewTool();
        console.log("✅ NeuroLink initialized\n");

        this.initialized = true;
      }

      // Step 3.5: Detect provider from the CURRENT request on EVERY call (not
      // just the first), BEFORE MCP setup — so a reused instance reviewing a
      // different provider (Bitbucket then GitHub) re-detects and the
      // provider-switch branch below actually fires. Without this, detection was
      // trapped in the one-time init block and the switch check compared against
      // a stale provider.
      // Provider detection is data-only now (used to label the PR identifier in
      // the prompt); MCP servers are chosen by config, not by provider.
      if (request) {
        this.detectedProvider = ProviderDetector.detect(
          request,
          process.env,
          this.config.defaultProvider,
        );
      }

      // Step 4: Register the MCP servers configured for this mode + the main
      // ("review") agent. Opt-in project servers from `.yama/mcp.json` are
      // merged OVER the config map (same id = override, including the VCS
      // servers), so one generic path applies roles/modes/allowlists to all.
      if (!this.mcpInitialized || this.mcpMode !== mode) {
        const projectServers = await new McpRegistry().load();
        if (Object.keys(projectServers).length > 0) {
          console.log(
            `   🧩 Merging ${Object.keys(projectServers).length} project MCP server(s) from .yama/mcp.json`,
          );
        }
        const effectiveMcpConfig: MCPServersConfig = {
          servers: { ...this.config.mcpServers.servers, ...projectServers },
        };
        await this.mcpManager.setupMCPServers(
          this.neurolink,
          effectiveMcpConfig,
          mode,
          "review",
        );
        if (this.explorer && this.config.ai.explore.enabled) {
          await this.explorer.initialize(mode, projectServers);
        }
        this.mcpInitialized = true;
        this.mcpMode = mode;
      }

      // Step 5: Mode-specific validation.
      await this.configLoader.validate(mode, this.detectedProvider);

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
    await this.ensureInitialized("pr", request.configPath, request);

    // Detect the provider based on request and environment
    this.detectedProvider = ProviderDetector.detect(
      request,
      process.env,
      this.config.defaultProvider,
    );

    const startTime = Date.now();
    const sessionId = this.sessionManager.createSession(request);

    this.logReviewStart(request, sessionId);

    try {
      const bootstrapStandards = await this.getBootstrappedStandards(
        request,
        sessionId,
      );
      const previousReview = await this.loadPreviousReview(request);

      // Build comprehensive AI instructions
      const instructions = await this.promptBuilder.buildReviewInstructions(
        request,
        this.config,
        bootstrapStandards,
        previousReview.block,
        compileRulesForPrompt(this.loadedRules),
        await this.getProjectDocs(),
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

      // Review call: RETRIEVE memory (for context), but DON'T STORE.
      // Wrapped in a bounded retry (ai.retryAttempts) for transient failures.
      const aiResponse = await this.generateWithRetry(
        () =>
          this.neurolink.generate({
            input: { text: instructions },
            provider: this.config.ai.provider,
            model: this.config.ai.model,
            temperature: this.config.ai.temperature,
            maxTokens: clampMaxTokens(this.config.ai.maxTokens),
            timeout: this.config.ai.timeout,
            // Prefer streaming transport for the long agentic loop (chunked
            // SSE keeps slow self-hosted backends responsive end-to-end).
            stream: true,
            // NeuroLink owns structured output: wire-level enforcement where
            // the provider supports tools+schema, JSON coercion into
            // structuredData everywhere else.
            schema: prReviewVerdictSchema,
            skipToolPromptInjection: true,
            ...this.getLoopGuardOptions(),
            context: {
              sessionId,
              userId: this.getUserId(request),
              operation: "code-review",
              metadata: toolContext.metadata,
            },
            memory: { read: true, write: false },
            enableAnalytics: this.config.ai.enableAnalytics,
            enableEvaluation: this.config.ai.enableEvaluation,
          } as unknown as Parameters<NeuroLink["generate"]>[0]),
        "code-review",
      );
      this.resultParser.recordToolCallsFromResponse(sessionId, aiResponse);
      const verdictResponse = await this.ensureStructuredVerdict(
        aiResponse,
        prReviewVerdictSchema,
        sessionId,
        this.getUserId(request),
        "code-review-verdict",
      );

      // Extract and parse results
      const result = this.applyRuleCompliance(
        this.resultParser.parseReviewResult(
          verdictResponse,
          startTime,
          sessionId,
          this.config.projectStandards?.severityOverrides,
        ),
      );

      await this.persistReviewState(previousReview.key, request, result);

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

      const aiResponse = await this.generateWithRetry(
        () =>
          this.neurolink.generate({
            input: { text: instructions },
            provider: this.config.ai.provider,
            model: this.config.ai.model,
            temperature: this.config.ai.temperature,
            maxTokens: clampMaxTokens(this.config.ai.maxTokens),
            timeout: this.config.ai.timeout,
            enableAnalytics: this.config.ai.enableAnalytics,
            enableEvaluation: this.config.ai.enableEvaluation,
            // Request JSON output at the provider level (prompt-level mode; safe alongside tools).
            output: { format: "json" },
            // NeuroLink enforces/coerces this shape into structuredData.
            schema: localReviewVerdictSchema,
            // Tools are passed natively; avoids huge duplicated tool-schema prompt injection.
            skipToolPromptInjection: true,
            ...this.getLoopGuardOptions(),
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
          } as unknown as Parameters<NeuroLink["generate"]>[0]),
        "local-review",
      );
      this.resultParser.recordToolCallsFromResponse(sessionId, aiResponse);
      const localResponse = await this.ensureStructuredVerdict(
        aiResponse,
        localReviewVerdictSchema,
        sessionId,
        this.getUserId(pseudoRequest),
        "local-review-verdict",
      );

      const result = this.resultParser.parseLocalReviewResult(
        localResponse,
        sessionId,
        startTime,
        request,
        diffContext,
        this.config.projectStandards?.severityOverrides,
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
   * Start review and then enhance description in the same session
   * This allows the AI to use knowledge gained during review to write better descriptions
   */
  async startReviewAndEnhance(request: ReviewRequest): Promise<ReviewResult> {
    await this.ensureInitialized("pr", request.configPath, request);

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

      const previousReview = await this.loadPreviousReview(request);

      // Build review instructions
      const reviewInstructions =
        await this.promptBuilder.buildReviewInstructions(
          request,
          this.config,
          bootstrapStandards,
          previousReview.block,
          compileRulesForPrompt(this.loadedRules),
          await this.getProjectDocs(),
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
        maxTokens: clampMaxTokens(this.config.ai.maxTokens),
        timeout: this.config.ai.timeout,
        // Prefer streaming transport for the long agentic loop (chunked SSE
        // keeps slow self-hosted backends responsive end-to-end).
        stream: true,
        // NeuroLink owns structured output: wire-level enforcement where the
        // provider supports tools+schema, JSON coercion into structuredData
        // everywhere else. The parser reads structuredData only.
        schema: prReviewVerdictSchema,
        skipToolPromptInjection: true,
        ...this.getLoopGuardOptions(),
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
      this.resultParser.recordToolCallsFromResponse(sessionId, reviewResponse);
      const verdictResponse = await this.ensureStructuredVerdict(
        reviewResponse,
        prReviewVerdictSchema,
        sessionId,
        this.getUserId(request),
        "code-review-verdict",
      );

      // Parse review results
      const reviewResult = this.applyRuleCompliance(
        this.resultParser.parseReviewResult(
          verdictResponse,
          startTime,
          sessionId,
          this.config.projectStandards?.severityOverrides,
        ),
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
          maxTokens: clampMaxTokens(this.config.ai.maxTokens),
          timeout: this.config.ai.timeout,
          skipToolPromptInjection: true,
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
        this.resultParser.recordToolCallsFromResponse(
          sessionId,
          enhanceResponse,
        );

        console.log("✅ Phase 2 complete: Description enhanced\n");

        // Add enhancement status to result
        reviewResult.descriptionEnhanced = true;
      } else {
        console.log(
          "⏭️  Skipping description enhancement (disabled in config)\n",
        );
        reviewResult.descriptionEnhanced = false;
      }

      await this.persistReviewState(previousReview.key, request, reviewResult);

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
  async enhanceDescription(request: ReviewRequest): Promise<EnhancementResult> {
    await this.ensureInitialized("pr", request.configPath, request);

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
        context: {
          sessionId,
          userId: this.getUserId(request),
          operation: "description-enhancement",
        },
        memory: { enabled: false },
        enableAnalytics: true,
      } as unknown as Parameters<NeuroLink["generate"]>[0]);
      this.resultParser.recordToolCallsFromResponse(sessionId, aiResponse);

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
    // Coalesce provider-specific identifiers: Bitbucket uses workspace/repository,
    // GitHub uses owner/repo. Bitbucket behavior is unchanged when those are set.
    const workspace = request.workspace || request.owner || "";
    const repository = request.repository || request.repo || "";
    return `${workspace}-${repository}`.toLowerCase();
  }

  private createToolContext(sessionId: string, request: ReviewRequest): any {
    return {
      sessionId,
      mode: "pr",
      // Carry the detected provider so explore_context / tool runtime context
      // knows which provider's toolset to use (GitHub reviews otherwise saw
      // provider=undefined and defaulted to Bitbucket).
      provider: this.detectedProvider,
      // Coalesce provider-specific identifiers (GitHub owner/repo, Bitbucket
      // workspace/repository) into the existing context fields. No-op for
      // Bitbucket where workspace/repository are already set.
      workspace: request.workspace || request.owner,
      repository: request.repository || request.repo,
      // GitHub passes the PR number via prNumber; coalesce so the runtime
      // context has a PR number for both providers.
      pullRequestId: request.pullRequestId ?? request.prNumber,
      branch: request.branch,
      dryRun: request.dryRun || false,
      metadata: {
        yamaVersion: VERSION,
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
      // Carry the detected provider for explore_context toolset selection.
      provider: this.detectedProvider,
      // Coalesce provider-specific identifiers (GitHub owner/repo, Bitbucket
      // workspace/repository). No-op for Bitbucket where they are already set.
      workspace: request.workspace || request.owner,
      repository: request.repository || request.repo,
      dryRun: request.dryRun || false,
      metadata: {
        yamaVersion: VERSION,
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
   * Guarantee a structured verdict without any project-level JSON parsing.
   *
   * The agentic review loop can legitimately end on a tool step, leaving the
   * final message empty — nothing for NeuroLink's schema coercion to work on.
   * In that case ask the SAME conversation session (the model remembers its
   * whole review) for just the verdict: tools disabled, schema passed, so
   * NeuroLink enforces/coerces the JSON itself. One bounded follow-up; if it
   * also produces nothing structured, the caller's parser fails safe.
   */
  private async ensureStructuredVerdict(
    response: any,
    schema: unknown,
    sessionId: string,
    userId: string,
    operation: string,
  ): Promise<any> {
    // Same shape test the parser uses — a present-but-unrelated JSON object
    // recovered from prose must still trigger the follow-up.
    const hasVerdict = (candidate: any): boolean =>
      isVerdictShaped(candidate?.structuredData);
    if (hasVerdict(response)) {
      return response;
    }

    console.log(
      "   🔁 Final message carried no structured verdict — requesting it explicitly (same session, tools off)...",
    );
    try {
      const verdict = await this.neurolink.generate({
        input: {
          text: "The review is complete. Return ONLY the final review verdict now, as the strict JSON object defined in the output contract — no prose, no markdown fences, no tool calls.",
        },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: 0,
        maxTokens: clampMaxTokens(8000),
        timeout: "3m",
        schema,
        disableTools: true,
        skipToolPromptInjection: true,
        context: { sessionId, userId, operation },
        memory: { enabled: false },
      } as unknown as Parameters<NeuroLink["generate"]>[0]);

      if (hasVerdict(verdict)) {
        // Keep the original response's usage/analytics/tool trace; only the
        // structured verdict comes from the follow-up.
        return { ...response, structuredData: verdict.structuredData };
      }
      console.warn(
        "   ⚠️  Follow-up verdict request also returned no structured output.",
      );
    } catch (error) {
      console.warn(
        `   ⚠️  Follow-up verdict request failed: ${(error as Error).message}`,
      );
    }
    return response;
  }

  /**
   * Run a NeuroLink generate() call with a small bounded retry on transient
   * errors (wires up the previously-unused `ai.retryAttempts` config). Retries
   * up to `retryAttempts` times (>=1 total attempt) with a short exponential
   * backoff. Non-transient errors (e.g. auth/validation) fail fast on the first
   * attempt so we don't paper over real misconfiguration.
   */
  private async generateWithRetry<T>(
    run: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const configured = this.config.ai.retryAttempts;
    const maxAttempts =
      typeof configured === "number" && Number.isFinite(configured)
        ? Math.max(1, Math.floor(configured))
        : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !this.isTransientError(error)) {
          throw error;
        }
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.warn(
          `   ⚠️  ${label} generate attempt ${attempt}/${maxAttempts} failed ` +
            `(${(error as Error).message}); retrying in ${backoffMs}ms...`,
        );
        await this.delay(backoffMs);
      }
    }
    // Unreachable in practice (loop either returns or throws), but keeps types happy.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Heuristic transient-error classifier for retry decisions. Conservative:
   * matches common network / rate-limit / timeout / 5xx signals and leaves
   * everything else (auth, validation, 4xx) as non-retryable.
   */
  private isTransientError(error: unknown): boolean {
    const message = (
      error instanceof Error ? error.message : String(error ?? "")
    ).toLowerCase();
    if (!message) {
      return false;
    }
    return (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("etimedout") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("eai_again") ||
      message.includes("socket hang up") ||
      message.includes("network") ||
      message.includes("rate limit") ||
      message.includes("rate_limit") ||
      message.includes("too many requests") ||
      message.includes("429") ||
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504") ||
      message.includes("overloaded") ||
      message.includes("temporarily unavailable")
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
   * Query-level read-only filtering for local-git MCP tools.
   *
   * Uses the shared, fail-closed `isMutatingGitTool` helper (any git_* tool not
   * on the read-only allow-list is treated as mutating) so the orchestrator,
   * explorer, and MCP manager all agree on what is read-only. The previous local
   * regex silently missed mutating tools like git_branch / git_mv / git_pull.
   */
  private getLocalToolFilteringOptions(): { excludeTools?: string[] } {
    try {
      const externalTools = (this.neurolink as any).getExternalMCPTools?.();
      if (!Array.isArray(externalTools)) {
        return {};
      }

      // High-volume read operations can flood context with huge payloads.
      const highVolumeGitToolPattern =
        /^git_(diff|diff_staged|diff_unstaged|log|show)\b/i;

      const excludeTools = externalTools
        .filter((tool: any) => tool?.serverId === "local-git")
        .map((tool: any) => tool?.name)
        .filter((name: unknown): name is string => typeof name === "string")
        .filter((name: string) => {
          const normalized = normalizeToolName(name);
          return (
            isMutatingGitTool(normalized) ||
            highVolumeGitToolPattern.test(normalized)
          );
        });

      if (excludeTools.length === 0) {
        return {};
      }

      return { excludeTools };
    } catch {
      return {};
    }
  }

  /** Root project docs (AGENTS.md / CLAUDE.md / …), loaded once per process. */
  private async getProjectDocs(): Promise<string | null> {
    if (this.projectDocsCache !== undefined) {
      return this.projectDocsCache;
    }
    try {
      this.projectDocsCache = await new RulesContextLoader(
        this.config.memoryBank,
        this.config.projectStandards,
      ).loadRootDocs();
    } catch {
      this.projectDocsCache = null;
    }
    return this.projectDocsCache;
  }

  /**
   * Deterministic rules enforcement: compute per-rule compliance from the
   * findings and force BLOCKED when a blocking rule is violated — same
   * authority as a CRITICAL finding, independent of the AI's own verdict.
   */
  private applyRuleCompliance(result: ReviewResult): ReviewResult {
    if (this.loadedRules.length === 0) {
      return result;
    }
    const compliance = computeRuleCompliance(this.loadedRules, result.issues);
    result.ruleCompliance = compliance;
    if (hasBlockingRuleViolation(compliance) && result.decision !== "BLOCKED") {
      console.log(
        `   🛡️  Blocking team rule violated — decision forced to BLOCKED (was ${result.decision}).`,
      );
      result.decision = "BLOCKED";
    }
    return result;
  }

  /** Stable per-PR state key: provider + repo identifiers + PR number. */
  private buildStateKey(request: ReviewRequest): string | null {
    const workspace = (request.workspace || request.owner || "").trim();
    const repository = (request.repository || request.repo || "").trim();
    const prId = request.pullRequestId ?? request.prNumber;
    if (!workspace || !repository || prId === undefined || prId === null) {
      return null;
    }
    return `${this.detectedProvider}-${workspace}-${repository}-pr-${prId}`.toLowerCase();
  }

  /** Head SHA for state bookkeeping — request first, CI env as fallback. */
  private resolveHeadSha(request: ReviewRequest): string | undefined {
    return (
      request.headSha ||
      process.env.GITHUB_SHA ||
      process.env.BITBUCKET_COMMIT ||
      process.env.GIT_COMMIT ||
      undefined
    );
  }

  /**
   * Load prior review state and format its open findings for prompt
   * injection. Returns empty context when state is disabled/absent.
   */
  private async loadPreviousReview(
    request: ReviewRequest,
  ): Promise<{ key: string | null; block: string }> {
    const key = this.buildStateKey(request);
    this.previousOpenIds = new Set();
    this.acceptedFindingIds = new Set();
    this.suppressedFindingIds = new Set();
    if (!this.stateStore || !key) {
      return { key, block: "" };
    }
    try {
      const state = await this.stateStore.load(key);
      if (!state) {
        return { key, block: "" };
      }
      for (const finding of state.findings) {
        if (finding.status === "open" || finding.status === "carried") {
          this.previousOpenIds.add(finding.id);
        }
      }
      this.suppressedFindingIds = collectSuppressedIds(state);
      if (this.suppressedFindingIds.size > 0) {
        console.log(
          `   🤫 ${this.suppressedFindingIds.size} finding(s) auto-suppressed as learned false positives.`,
        );
      }
      const openFindings = formatOpenFindingsForPrompt(state);
      const header = state.lastReviewedSha
        ? `Last reviewed commit: ${state.lastReviewedSha}\n`
        : "";
      console.log(
        `   🔁 Incremental review: ${state.runs.length} prior run(s), ` +
          `${openFindings ? openFindings.split("\n").length : 0} open finding(s) carried in.`,
      );
      return { key, block: openFindings ? header + openFindings : header };
    } catch (error) {
      console.warn(
        `   ⚠️  Could not load review state: ${(error as Error).message}`,
      );
      return { key, block: "" };
    }
  }

  /**
   * Reconcile this run's findings into state and persist. Never throws —
   * state is bookkeeping, not a review-blocking dependency.
   */
  private async persistReviewState(
    key: string | null,
    request: ReviewRequest,
    result: ReviewResult,
  ): Promise<void> {
    if (!this.stateStore || !key) {
      return;
    }
    // Dry-run must stay side-effect free — no state writes either.
    if (request.dryRun) {
      console.log("   🗂️  Dry-run: review state not persisted.");
      return;
    }
    try {
      const previous = await this.stateStore.load(key);
      const currentFindings = (result.issues || []).map((issue) => ({
        id: buildFindingId(issue),
        ruleId: issue.rule,
        filePath: issue.filePath,
        line: issue.line ?? null,
        severity: issue.severity,
        title: issue.title || issue.description || "(untitled finding)",
      }));
      const { state, newFindingIds, resolvedFindingIds } = reconcileFindings({
        previous,
        key,
        sha: this.resolveHeadSha(request),
        decision: result.decision,
        stopReason: result.completion?.stopReason,
        currentFindings,
        resolvedIds: result.resolvedIssueIds,
      });
      await this.stateStore.save(key, state);
      console.log(
        `   🗂️  Review state saved (${newFindingIds.size} new, ` +
          `${resolvedFindingIds.size} resolved, ${state.findings.length} tracked).`,
      );
    } catch (error) {
      console.warn(
        `   ⚠️  Could not persist review state: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Loop guards for agentic generate() calls, wired from `performance.*`
   * config (previously decorative). `turnTimeoutMs` falls back to
   * `performance.maxReviewDuration`; steps default bounded well below
   * NeuroLink's own 200-step ceiling.
   */
  private getLoopGuardOptions(): Record<string, unknown> {
    const loop = this.config.performance?.loop || {};
    const turnTimeoutMs =
      loop.turnTimeoutMs ??
      parseDurationMs(this.config.performance?.maxReviewDuration);
    const options: Record<string, unknown> = {
      maxSteps: loop.maxSteps ?? 100,
    };
    if (turnTimeoutMs) {
      options.turnTimeoutMs = turnTimeoutMs;
    }
    if (loop.stallTimeoutMs) {
      options.stallTimeoutMs = loop.stallTimeoutMs;
    }
    if (loop.toolTimeoutMs) {
      options.toolTimeoutMs = loop.toolTimeoutMs;
    }
    return options;
  }

  /**
   * Initialize NeuroLink with observability configuration
   */
  private initializeNeurolink(): NeuroLink {
    try {
      // Tool filtering is config-driven (per-server `blockedTools`/`allowedTools`
      // in `.yama/mcp.json` and `mcpServers.*.blockedTools`), not hardcoded here —
      // so any MCP server, built-in or added, is governed by config alone.
      return NeuroLinkFactory.create({
        conversationMemory: this.config.ai.conversationMemory,
        memoryManager: this.memoryManager,
        mcpOutputLimits: this.config.ai.mcpOutputLimits,
      });
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
          provider:
            typeof mergedContext.provider === "string"
              ? mergedContext.provider
              : undefined,
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
   * The harness gate: the agent submits candidate findings here BEFORE
   * posting anything. Deterministic dedup (state + this run) plus critic
   * verification decide what may be posted; the agent stays the author, the
   * landing is engineered.
   */
  private registerSubmitReviewTool(): void {
    if (this.submitToolRegistered) {
      return;
    }

    this.neurolink.registerTool("submit_review", {
      name: "submit_review",
      description:
        "MANDATORY gate before posting review comments. Submit ALL candidate findings (with concrete file:line evidence); the response tells you exactly which findings you may post and which were rejected and why. Never post a comment for a finding this tool did not accept.",
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            description: "Candidate findings for this file or batch.",
            items: {
              type: "object",
              properties: {
                severity: {
                  type: "string",
                  enum: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
                },
                category: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                filePath: { type: "string" },
                line: { type: "number" },
                suggestion: { type: "string" },
                ruleId: { type: "string" },
                evidence: {
                  type: "string",
                  description:
                    "file:line citations or quoted code backing the claim.",
                },
              },
              required: ["severity", "title"],
            },
          },
        },
        required: ["findings"],
      },
      execute: async (params: unknown) => {
        const raw = (params || {}) as { findings?: unknown };
        const submitted: SubmittedFinding[] = Array.isArray(raw.findings)
          ? (raw.findings as SubmittedFinding[]).filter(
              (finding) =>
                finding &&
                typeof finding === "object" &&
                typeof finding.title === "string" &&
                ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"].includes(
                  String(finding.severity),
                ),
            )
          : [];

        const stamped: SubmitReviewAccepted[] = submitted.map((finding) => ({
          ...finding,
          id: buildFindingId(finding),
        }));

        const mode = this.config.review.verification ?? "basic";
        const sessionId = String(this.currentToolContext?.sessionId || "");
        const dryRun = this.currentToolContext?.dryRun === true;

        const verdicts = this.critic
          ? await this.critic.verify(
              stamped,
              mode,
              sessionId,
              this.buildExploreRuntimeContext(),
            )
          : stamped.map((finding) => ({
              id: finding.id,
              verdict: "confirmed" as const,
              reason: "no critic available",
            }));

        const result = gateFindings({
          findings: stamped,
          verdicts,
          previouslyReportedIds: this.previousOpenIds,
          alreadyAcceptedIds: this.acceptedFindingIds,
          suppressedIds: this.suppressedFindingIds,
          mode,
          dryRun,
        });
        for (const finding of result.accepted) {
          this.acceptedFindingIds.add(finding.id);
        }
        console.log(
          `   🛡️  submit_review: ${result.accepted.length} accepted, ${result.rejected.length} rejected (mode: ${mode}).`,
        );
        return { success: true, data: result };
      },
    });

    this.submitToolRegistered = true;
  }

  /** Runtime context for the critic's strict-mode evidence pass. */
  private buildExploreRuntimeContext() {
    const context = this.currentToolContext || {};
    return {
      sessionId: String(context.sessionId || ""),
      mode: (context.mode === "local" ? "local" : "pr") as "pr" | "local",
      workspace: String(context.workspace || "local"),
      repository: String(context.repository || "repository"),
      provider:
        typeof context.provider === "string" ? context.provider : undefined,
      pullRequestId:
        typeof context.pullRequestId === "number"
          ? context.pullRequestId
          : undefined,
      dryRun: context.dryRun === true,
      metadata: {},
    };
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

    // Validate required parameters for bootstrap. Coalesce provider-specific
    // identifiers so GitHub (owner/repo) also gets bootstrap standards; no-op
    // for Bitbucket where workspace/repository are already set.
    const workspace = (request.workspace || request.owner || "").trim();
    const repository = (request.repository || request.repo || "").trim();

    if (workspace.length === 0 || repository.length === 0) {
      return "";
    }

    const cacheKey = `${workspace}/${repository}`.toLowerCase();
    const cached = this.bootstrapStandardsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const task = `Bootstrap repo review standards for ${workspace}/${repository}. Inspect the last 15 merged pull requests on this repository. For each, collect inline and summary comments left by HUMAN reviewers (ignore bot authors like "Yama", "yama-bot", "yama-review", "euler.bot"). Focus on comments that asked for code changes, flagged bugs, pushed back on an approach, or cited a convention. Distill the recurring patterns and anti-patterns the human reviewers care about — especially things that a static config rule set would miss (naming, error-handling idioms, module boundaries, test expectations, migration rules, review etiquette). Return a concise bullet list of 10-20 patterns. Each bullet: one sentence stating the pattern, optionally one sentence of rationale. Do NOT include PR numbers, author names, or raw quotes — just distilled patterns.`;

    try {
      console.log(
        `   🧭 Bootstrapping repo standards from recent PRs (one-time per process)...`,
      );
      const { result } = await this.explorer.explore(
        { task, focus: [repository] },
        {
          sessionId,
          mode: "pr",
          provider: this.detectedProvider,
          workspace,
          repository,
          pullRequestId: request.pullRequestId ?? request.prNumber,
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
    request?: ReviewRequest,
  ): Promise<void> {
    await this.initialize(configPath, mode, request);
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

    Version: ${VERSION}
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
    console.log(`   Provider: ${request.provider ?? "bitbucket"}`);
    console.log(
      `   Repository: ${request.workspace ?? request.owner}/${request.repository ?? request.repo}`,
    );
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
export function createYama(options: YamaInitOptions = {}): YamaOrchestrator {
  return new YamaOrchestrator(options);
}
