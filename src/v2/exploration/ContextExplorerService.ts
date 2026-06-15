import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { NeuroLink } from "@juspay/neurolink";
import { YamaConfig } from "../types/config.types.js";
import {
  ExplorationEvidence,
  ExplorationFinding,
  ExplorationResult,
} from "../types/v2.types.js";
import { SessionManager } from "../core/SessionManager.js";
import { MCPServerManager } from "../core/MCPServerManager.js";
import { MemoryManager } from "../memory/MemoryManager.js";
import { KnowledgeBaseManager } from "../learning/KnowledgeBaseManager.js";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../utils/ObservabilityConfig.js";
import {
  getProviderToolset,
  type VCSProviderName,
} from "../providers/ProviderToolset.js";
import { clampMaxTokens, MAX_EXTRACTION_TOKENS } from "../utils/tokenLimits.js";
import { isMutatingGitTool } from "../utils/toolPolicy.js";
import { ExplorerPromptBuilder } from "./ExplorerPromptBuilder.js";
import { RulesContextLoader } from "./RulesContextLoader.js";
import {
  ExploreContextInput,
  ExploreExecutionResult,
  ExploreRuntimeContext,
} from "./types.js";

export class ContextExplorerService {
  private readonly promptBuilder = new ExplorerPromptBuilder();
  private readonly rulesContextLoader: RulesContextLoader;
  private readonly mcpManager = new MCPServerManager();
  private neurolink: NeuroLink;
  private prMcpInitialized = false;
  private localMcpInitialized = false;

  constructor(
    private readonly config: YamaConfig,
    private readonly sessionManager: SessionManager,
    private readonly memoryManager: MemoryManager | null,
    private readonly projectRoot: string = process.cwd(),
  ) {
    this.rulesContextLoader = new RulesContextLoader(
      config.memoryBank,
      config.projectStandards,
      projectRoot,
    );
    this.neurolink = this.initializeNeurolink();
  }

  async initialize(
    mode: "pr" | "local",
    provider: VCSProviderName = "bitbucket",
  ): Promise<void> {
    if (mode === "pr" && !this.prMcpInitialized) {
      // The explore subagent gets its own MCP servers; they MUST match the
      // detected provider, otherwise a GitHub run would try to start Bitbucket
      // MCP (and fail on missing Bitbucket credentials).
      await this.mcpManager.setupMCPServers(
        this.neurolink,
        this.config.mcpServers,
        provider,
      );
      this.prMcpInitialized = true;
      return;
    }

    if (mode === "local" && !this.localMcpInitialized) {
      await this.mcpManager.setupLocalGitMCPServer(this.neurolink);
      this.localMcpInitialized = true;
    }
  }

  async explore(
    input: ExploreContextInput,
    runtimeContext: ExploreRuntimeContext,
  ): Promise<ExploreExecutionResult> {
    // Pass the runtime provider through when it is a known VCS provider;
    // otherwise fall back to the read-only default. VCSProviderName is the
    // single source of truth for supported providers, so adding one there is
    // all that's needed for the explore subagent to honour it.
    const explorerProvider: VCSProviderName =
      runtimeContext.provider === "github" ||
      runtimeContext.provider === "bitbucket"
        ? runtimeContext.provider
        : "bitbucket";
    await this.initialize(runtimeContext.mode, explorerProvider);

    const normalizedInput = this.normalizeInput(input);
    const cacheKey = this.buildCacheKey(normalizedInput, runtimeContext);

    if (this.config.ai.explore.cacheResults) {
      const cached = this.sessionManager.findExploration(
        runtimeContext.sessionId,
        cacheKey,
      );
      if (cached) {
        return { result: cached, cached: true };
      }
    }

    const [projectRules, projectStandards, knowledgeBase, repositoryMemory] =
      await Promise.all([
        this.rulesContextLoader.load(),
        this.loadProjectStandards(),
        this.loadKnowledgeBase(),
        this.loadRepositoryMemory(runtimeContext),
      ]);

    const prompt = this.promptBuilder.buildPrompt(
      normalizedInput,
      runtimeContext,
      {
        projectRules,
        projectStandards,
        knowledgeBase,
        repositoryMemory,
      },
    );

    (this.neurolink as any).setToolContext(runtimeContext);

    console.log(`   🔎 Explore: ${normalizedInput.task}`);

    const researchResponse = await this.neurolink.generate({
      input: { text: prompt },
      provider: this.config.ai.explore.provider || this.config.ai.provider,
      model: this.config.ai.explore.model || this.config.ai.model,
      temperature:
        this.config.ai.explore.temperature ?? this.config.ai.temperature,
      maxTokens: clampMaxTokens(
        this.config.ai.explore.maxTokens ?? this.config.ai.maxTokens,
      ),
      timeout: this.config.ai.explore.timeout || this.config.ai.timeout,
      skipToolPromptInjection: true,
      ...this.getToolFilteringOptions(runtimeContext.mode),
      context: {
        sessionId: runtimeContext.sessionId,
        userId: this.getUserId(runtimeContext),
        operation: "explore-context-research",
        metadata: runtimeContext.metadata || {},
      },
      memory: { enabled: false },
      enableAnalytics: this.config.ai.enableAnalytics,
      enableEvaluation: false,
    } as unknown as Parameters<NeuroLink["generate"]>[0]);

    const extractionPrompt = this.buildExtractionPrompt(
      normalizedInput.task,
      researchResponse,
    );
    const extractionResponse = await this.neurolink.generate({
      input: { text: extractionPrompt },
      provider: this.config.ai.explore.provider || this.config.ai.provider,
      model: this.config.ai.explore.model || this.config.ai.model,
      temperature: 0.1,
      maxTokens: clampMaxTokens(
        this.config.ai.explore.maxTokens ?? this.config.ai.maxTokens,
        MAX_EXTRACTION_TOKENS,
      ),
      timeout: "2m",
      disableTools: true,
      context: {
        sessionId: runtimeContext.sessionId,
        userId: this.getUserId(runtimeContext),
        operation: "explore-context-extraction",
        metadata: runtimeContext.metadata || {},
      },
      memory: { enabled: false },
      enableAnalytics: this.config.ai.enableAnalytics,
      enableEvaluation: false,
    } as unknown as Parameters<NeuroLink["generate"]>[0]);

    const result = this.normalizeResult(
      normalizedInput.task,
      extractionResponse?.content,
    );
    if (this.shouldCacheResult(result)) {
      this.sessionManager.recordExploration(
        runtimeContext.sessionId,
        cacheKey,
        normalizedInput.task,
        normalizedInput.focus || [],
        result,
      );
    }

    return { result, cached: false };
  }

  private normalizeInput(input: ExploreContextInput): ExploreContextInput {
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) {
      throw new Error("explore_context requires a non-empty task");
    }

    const focus = Array.isArray(input.focus)
      ? input.focus
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined;

    return {
      task,
      focus,
    };
  }

  private buildCacheKey(
    input: ExploreContextInput,
    runtimeContext: ExploreRuntimeContext,
  ): string {
    // Validate required string parameters
    const task =
      typeof input.task === "string" ? input.task.trim().toLowerCase() : "";
    const workspace =
      typeof runtimeContext.workspace === "string"
        ? runtimeContext.workspace.trim()
        : "";
    const repository =
      typeof runtimeContext.repository === "string"
        ? runtimeContext.repository.trim()
        : "";

    if (!task) {
      throw new Error("Invalid cache key: task must be a non-empty string");
    }
    if (!workspace || !repository) {
      throw new Error(
        "Invalid cache key: workspace and repository must be non-empty strings",
      );
    }

    return JSON.stringify({
      mode: runtimeContext.mode,
      provider:
        typeof runtimeContext.provider === "string"
          ? runtimeContext.provider.trim().toLowerCase()
          : "bitbucket",
      workspace,
      repository,
      pullRequestId: runtimeContext.pullRequestId || null,
      branch:
        typeof runtimeContext.branch === "string"
          ? runtimeContext.branch.trim()
          : null,
      task,
      focus: Array.isArray(input.focus)
        ? input.focus
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().toLowerCase())
        : [],
    });
  }

  private getUserId(runtimeContext: ExploreRuntimeContext): string {
    const workspace =
      typeof runtimeContext.workspace === "string"
        ? runtimeContext.workspace.trim()
        : "unknown";
    const repository =
      typeof runtimeContext.repository === "string"
        ? runtimeContext.repository.trim()
        : "unknown";
    return `${workspace}-${repository}`.toLowerCase();
  }

  private getToolFilteringOptions(mode: "pr" | "local"): {
    excludeTools?: string[];
  } {
    try {
      const externalTools = (this.neurolink as any).getExternalMCPTools?.();
      if (!Array.isArray(externalTools)) {
        return {};
      }

      const excludeTools = externalTools
        .map((tool: any) => tool?.name)
        .filter((name: unknown): name is string => typeof name === "string")
        .filter((name) => this.shouldExcludeTool(mode, name));

      return excludeTools.length > 0 ? { excludeTools } : {};
    } catch {
      return {};
    }
  }

  /**
   * Provider-agnostic mutation block list for the read-only explore subagent.
   * Derived once from each provider toolset's mutationToolNames (Bitbucket +
   * GitHub) so the source of truth stays in ProviderToolset, not re-hardcoded
   * here. Names are lower-cased for case-insensitive matching against the
   * normalized tool name.
   */
  private static readonly MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(
    (["bitbucket", "github"] as const).flatMap((provider) =>
      getProviderToolset(provider).mutationToolNames.map((name) =>
        name.toLowerCase(),
      ),
    ),
  );

  private shouldExcludeTool(mode: "pr" | "local", toolName: string): boolean {
    const normalized = this.normalizeToolName(toolName);

    // Provider (non-git) mutation tools — Bitbucket/GitHub write tools derived
    // from each provider toolset — are always excluded for the read-only
    // explore subagent.
    if (
      ContextExplorerService.MUTATION_TOOL_NAMES.has(normalized.toLowerCase())
    ) {
      return true;
    }

    // Git tools are filtered with the shared fail-closed allow-list in local
    // mode (any git_* tool not on the read-only list is treated as mutating),
    // closing the gaps the old regex missed (git_branch, git_mv, git_pull, …).
    if (mode === "local") {
      return isMutatingGitTool(toolName);
    }

    return false;
  }

  private normalizeToolName(name: string): string {
    return name.split(/[.:/]/).pop() || name;
  }

  private normalizeResult(task: string, content: unknown): ExplorationResult {
    const rawText =
      typeof content === "string" ? content : JSON.stringify(content || {});
    const parsed = this.extractJsonPayload(rawText);
    const findings = this.normalizeFindings(parsed?.findings);
    const evidence = this.normalizeEvidence(parsed?.evidence);
    const openQuestions = Array.isArray(parsed?.openQuestions)
      ? parsed.openQuestions
          .filter(
            (value: unknown): value is string => typeof value === "string",
          )
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    return {
      task,
      summary:
        (typeof parsed?.summary === "string" && parsed.summary.trim()) ||
        "Explore returned unstructured output and could not produce verified findings.",
      findings,
      evidence,
      openQuestions:
        openQuestions.length > 0
          ? openQuestions
          : parsed
            ? []
            : [
                "Explore did not return structured JSON. Retry with a narrower task or inspect the raw investigation path.",
              ],
      recommendedNextStep: parsed
        ? this.normalizeNextStep(parsed?.recommendedNextStep)
        : "explore_more",
      completedAt: new Date().toISOString(),
    };
  }

  private buildExtractionPrompt(task: string, researchResponse: any): string {
    const researchContent = this.truncateForExtraction(
      typeof researchResponse?.content === "string"
        ? researchResponse.content
        : JSON.stringify(researchResponse?.content || {}),
      16_000,
    );

    const toolCalls = Array.isArray(researchResponse?.toolCalls)
      ? researchResponse.toolCalls.map((call: any) => ({
          toolName:
            call?.toolName || call?.name || call?.tool || "unknown_tool",
          parameters: call?.parameters || call?.args || {},
        }))
      : [];

    const toolResults = Array.isArray(researchResponse?.toolResults)
      ? researchResponse.toolResults.map((result: any) => ({
          toolName: result?.toolName || "unknown_tool",
          error: result?.error,
          result: this.truncateForExtraction(
            JSON.stringify(result?.result || result?.content || result || {}),
            8_000,
          ),
        }))
      : [];

    return `
You are converting an Explore research run into strict JSON.

Original task:
${task}

Research response text:
${researchContent || "(empty)"}

Tool calls:
${JSON.stringify(toolCalls, null, 2)}

Tool results:
${JSON.stringify(toolResults, null, 2)}

Return ONLY valid JSON with this exact shape:
{
  "summary": "string",
  "findings": [
    {
      "claim": "string",
      "confidence": "high|medium|low"
    }
  ],
  "evidence": [
    {
      "sourceType": "file|commit|diff|jira|memory|rules|kb",
      "ref": "string",
      "snippet": "string",
      "reason": "string"
    }
  ],
  "openQuestions": ["string"],
  "recommendedNextStep": "continue_review|explore_more|avoid_commenting"
}

Rules:
- Use only information present in the research response and tool results.
- If evidence is insufficient, keep findings empty and set recommendedNextStep to "explore_more".
- Prefer precise file paths, commit SHAs, or ticket IDs in evidence.ref.
- Do not include markdown fences or prose outside JSON.
    `.trim();
  }

  private truncateForExtraction(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }
    return `${value.slice(0, maxChars)}\n... [truncated]`;
  }

  private shouldCacheResult(result: ExplorationResult): boolean {
    if (result.findings.length > 0 || result.evidence.length > 0) {
      return true;
    }

    return (
      result.summary !==
        "Explore returned unstructured output and could not produce verified findings." &&
      result.openQuestions.length === 0
    );
  }

  private normalizeFindings(input: unknown): ExplorationFinding[] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .map((entry) => {
        const value = (entry || {}) as Record<string, unknown>;
        const claim = typeof value.claim === "string" ? value.claim.trim() : "";
        if (!claim) {
          return null;
        }

        return {
          claim,
          confidence: this.normalizeConfidence(value.confidence),
        };
      })
      .filter((entry): entry is ExplorationFinding => entry !== null);
  }

  private normalizeEvidence(input: unknown): ExplorationEvidence[] {
    if (!Array.isArray(input)) {
      return [];
    }

    return input
      .map((entry) => {
        const value = (entry || {}) as Record<string, unknown>;
        const sourceType = this.normalizeSourceType(value.sourceType);
        const ref = typeof value.ref === "string" ? value.ref.trim() : "";
        const reason =
          typeof value.reason === "string" ? value.reason.trim() : "";

        if (!ref || !reason) {
          return null;
        }

        const result: ExplorationEvidence = {
          sourceType,
          ref,
          reason,
        };

        if (typeof value.snippet === "string" && value.snippet.trim()) {
          result.snippet = value.snippet.trim();
        }

        return result;
      })
      .filter((entry): entry is ExplorationEvidence => entry !== null);
  }

  private normalizeConfidence(
    value: unknown,
  ): ExplorationFinding["confidence"] {
    if (typeof value !== "string") {
      return "medium";
    }

    const normalized = value.toLowerCase();
    return normalized === "high" ||
      normalized === "medium" ||
      normalized === "low"
      ? normalized
      : "medium";
  }

  private normalizeSourceType(
    value: unknown,
  ): ExplorationEvidence["sourceType"] {
    if (typeof value !== "string") {
      return "file";
    }

    const normalized = value.toLowerCase();
    if (
      normalized === "file" ||
      normalized === "commit" ||
      normalized === "diff" ||
      normalized === "jira" ||
      normalized === "memory" ||
      normalized === "rules" ||
      normalized === "kb"
    ) {
      return normalized;
    }

    return "file";
  }

  private normalizeNextStep(
    value: unknown,
  ): ExplorationResult["recommendedNextStep"] {
    if (typeof value !== "string") {
      return "continue_review";
    }

    const normalized = value.toLowerCase();
    if (
      normalized === "continue_review" ||
      normalized === "explore_more" ||
      normalized === "avoid_commenting"
    ) {
      return normalized;
    }

    return "continue_review";
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

    const fenceOpen = trimmed.toLowerCase().indexOf("```json");
    if (fenceOpen !== -1) {
      let contentStart = fenceOpen + 7;
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
          return null;
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

  private async loadProjectStandards(): Promise<string | null> {
    if (!this.config.projectStandards?.customPromptsPath) {
      return null;
    }

    const promptDir = join(
      this.projectRoot,
      this.config.projectStandards.customPromptsPath,
    );
    const promptFiles = [
      "review-standards.md",
      "security-guidelines.md",
      "coding-conventions.md",
    ];
    const sections: string[] = [];

    for (const file of promptFiles) {
      const absolutePath = join(promptDir, file);
      if (!existsSync(absolutePath)) {
        continue;
      }

      try {
        const content = await readFile(absolutePath, "utf-8");
        sections.push(`## ${file}\n\n${content}`);
      } catch {
        continue;
      }
    }

    return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
  }

  private async loadKnowledgeBase(): Promise<string | null> {
    if (!this.config.knowledgeBase?.enabled) {
      return null;
    }

    try {
      return await new KnowledgeBaseManager(
        this.config.knowledgeBase,
        this.projectRoot,
      ).getForPrompt();
    } catch {
      return null;
    }
  }

  private async loadRepositoryMemory(
    runtimeContext: ExploreRuntimeContext,
  ): Promise<string | null> {
    if (!this.memoryManager) {
      return null;
    }

    return this.memoryManager.readRepositoryMemory(
      runtimeContext.workspace,
      runtimeContext.repository,
      runtimeContext.provider || "bitbucket",
    );
  }

  private initializeNeurolink(): NeuroLink {
    const observabilityConfig = buildObservabilityConfigFromEnv();
    const neurolinkConfig: Record<string, unknown> = {
      conversationMemory: {
        enabled: false,
      },
    };

    if (observabilityConfig) {
      if (!validateObservabilityConfig(observabilityConfig)) {
        throw new Error("Invalid observability configuration");
      }
      neurolinkConfig.observability = observabilityConfig;
    }

    return new NeuroLink(neurolinkConfig);
  }
}
