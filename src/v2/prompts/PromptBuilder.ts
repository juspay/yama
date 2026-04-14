/**
 * Prompt Builder for Yama V2
 * Builds comprehensive AI instructions from multiple layers:
 * - Base System Prompt (tool usage, format standards)
 * - Config Instructions (workflow, focus areas, blocking criteria)
 * - Project Standards (repository-specific rules)
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { YamaConfig } from "../types/config.types.js";
import { LocalReviewRequest, ReviewRequest } from "../types/v2.types.js";
import type { LocalDiffContext } from "../core/LocalDiffSource.js";
import { LangfusePromptManager } from "./LangfusePromptManager.js";
import { KnowledgeBaseManager } from "../learning/KnowledgeBaseManager.js";

export class PromptBuilder {
  private langfuseManager: LangfusePromptManager;

  constructor() {
    this.langfuseManager = new LangfusePromptManager();
  }

  /**
   * Build complete review instructions for AI
   * Combines generic base prompt + project-specific config
   */
  async buildReviewInstructions(
    request: ReviewRequest,
    config: YamaConfig,
    bootstrapStandards?: string | null,
  ): Promise<string> {
    // Base system prompt - fetched from Langfuse or local fallback
    const basePromptRaw = await this.langfuseManager.getReviewPrompt();

    // Project-specific configuration in XML format
    const projectConfig = this.buildProjectConfigXML(config, request);

    // Project-specific standards (if available)
    const projectStandards = await this.loadProjectStandards(config);

    // Knowledge base learnings (reinforcement learning)
    const knowledgeBase = await this.loadKnowledgeBase(config);
    const exploreEnabled = config.ai.explore.enabled;

    // Strip explore_context references when the subagent is disabled.
    const basePrompt = PromptBuilder.stripDisabledSections(
      basePromptRaw,
      exploreEnabled,
    );

    const workflowBlock = PromptBuilder.stripDisabledSections(
      this.buildReviewWorkflow(request),
      exploreEnabled,
    );

    const bootstrapBlock =
      bootstrapStandards && bootstrapStandards.trim().length > 0
        ? `<bootstrapped-standards>
<!--
Recurring reviewer patterns observed in recent merged PRs on this repo.
These are runtime observations, not config rules. Treat them as guidance
that ranks BELOW <blocking-criteria> but ABOVE generic suggestions.
If they conflict with <project-standards> or <blocking-criteria>, the
config wins.
-->
${bootstrapStandards.trim()}
</bootstrapped-standards>`
        : "";

    // Combine all parts
    return `
${basePrompt}

<project-configuration>
${projectConfig}
</project-configuration>

${projectStandards ? `<project-standards>\n${projectStandards}\n</project-standards>` : ""}

${bootstrapBlock}

${knowledgeBase ? `<learned-knowledge>\n${knowledgeBase}\n</learned-knowledge>` : ""}

<review-task>
  <workspace>${this.escapeXML(request.workspace)}</workspace>
  <repository>${this.escapeXML(request.repository)}</repository>
  <pull_request_id>${request.pullRequestId || "find-by-branch"}</pull_request_id>
  <branch>${this.escapeXML(request.branch || "N/A")}</branch>
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>

${workflowBlock}
</review-task>
    `.trim();
  }

  /**
   * Per-PR workflow block. Standards-first, file-by-file, explore-on-uncertainty.
   * The agent stays autonomous; this just choreographs the order it should follow.
   */
  private buildReviewWorkflow(request: ReviewRequest): string {
    const modeLine = request.dryRun
      ? "DRY RUN MODE: simulate actions only, do not post real comments or change PR state."
      : "LIVE MODE: post real comments and make real decisions.";
    const additional = request.prompt
      ? `\n  ADDITIONAL INSTRUCTIONS: ${this.escapeXML(request.prompt)}`
      : "";

    return `  <instructions>
    Begin your autonomous review. Follow this order.

    STEP 1 — Read project standards
    Read the <project-standards> block above carefully. Treat any reviewer-expectation
    entry with severity=BLOCKING as a blocking criterion for this PR. If the block is
    missing or empty, fall back to <focus-areas> and <blocking-criteria>.

    STEP 2 — Read the PR shell
    Call get_pull_request once to get changed files, branch info, and existing comments.
    Build a mental map of which files exist and which already have comments.
    Do NOT request the full PR diff.

    STEP 3 — Walk files one at a time
    For each changed file, in order:
      a. Call get_pull_request_diff(file_path=&lt;this file&gt;).
      b. Cross-check the diff against project-standards and existing comments on this file.
      c. If anything is non-trivial — multi-file impact, unfamiliar pattern, unclear intent,
         history-dependent behavior — <!-- EXPLORE_BEGIN -->call explore_context with a precise
         task and wait for its evidence before commenting<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->use search_code or get_file_content to verify before commenting<!-- EXPLORE_DISABLED_END -->.
      d. For every confirmed issue, call add_comment immediately with line_number and
         line_type from the diff JSON. Include a real-code suggestion for CRITICAL/MAJOR.
      e. Move to the next file. Never request another file's diff before finishing the
         current one. Never request a multi-file diff.

    STEP 4 — Decision
    After the last file, count issues by severity, apply <blocking-criteria>, and call
    set_pr_approval(approved=true) OR set_review_status(request_changes=true).

    STEP 5 — Summary comment
    Post one summary comment with file count, issue counts by severity, and next steps.

    Budget guidance: roughly 10 tool calls per file in the main loop. If you exceed
    that on a single file, <!-- EXPLORE_BEGIN -->delegate the rest to explore_context<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->stop investigating<!-- EXPLORE_DISABLED_END --> and move on.

    ${modeLine}${additional}
  </instructions>`;
  }

  /**
   * Strip sections that depend on explore_context being enabled.
   * Keeps the prompt single-source and avoids forking files for the disabled case.
   *
   * - <!-- EXPLORE_BEGIN -->...<!-- EXPLORE_END --> is removed when explore is OFF.
   * - <!-- EXPLORE_DISABLED_BEGIN -->...<!-- EXPLORE_DISABLED_END --> is removed when explore is ON.
   * - The marker comments themselves are always stripped.
   *
   * Implementation uses linear indexOf/slice instead of regex to avoid any
   * polynomial-backtracking risk on adversarial input.
   */
  static stripDisabledSections(
    prompt: string,
    exploreEnabled: boolean,
  ): string {
    const EXPLORE_BEGIN = "<!-- EXPLORE_BEGIN -->";
    const EXPLORE_END = "<!-- EXPLORE_END -->";
    const EXPLORE_DISABLED_BEGIN = "<!-- EXPLORE_DISABLED_BEGIN -->";
    const EXPLORE_DISABLED_END = "<!-- EXPLORE_DISABLED_END -->";

    const stripBlock = (text: string, start: string, end: string): string => {
      let out = "";
      let cursor = 0;
      while (cursor <= text.length) {
        const s = text.indexOf(start, cursor);
        if (s === -1) {
          out += text.slice(cursor);
          break;
        }
        out += text.slice(cursor, s);
        const e = text.indexOf(end, s + start.length);
        if (e === -1) {
          out += text.slice(s);
          break;
        }
        cursor = e + end.length;
      }
      return out;
    };

    const removeAll = (text: string, marker: string): string =>
      text.split(marker).join("");

    if (exploreEnabled) {
      let result = stripBlock(
        prompt,
        EXPLORE_DISABLED_BEGIN,
        EXPLORE_DISABLED_END,
      );
      result = removeAll(result, EXPLORE_BEGIN);
      result = removeAll(result, EXPLORE_END);
      return result;
    }
    let result = stripBlock(prompt, EXPLORE_BEGIN, EXPLORE_END);
    result = removeAll(result, EXPLORE_DISABLED_BEGIN);
    result = removeAll(result, EXPLORE_DISABLED_END);
    return result;
  }

  /**
   * Build project configuration in XML format
   * Injects project-specific rules into base system prompt
   */
  private buildProjectConfigXML(
    config: YamaConfig,
    request: ReviewRequest,
  ): string {
    const focusAreas =
      request.focus && request.focus.length > 0
        ? request.focus.map((focus) => ({
            name: focus,
            priority: "MAJOR" as const,
            description: "User-specified focus area",
          }))
        : config.review.focusAreas;

    const focusAreasXML = focusAreas
      .map(
        (area) => `
    <focus-area priority="${area.priority}">
      <name>${this.escapeXML(area.name)}</name>
      <description>${this.escapeXML(area.description)}</description>
    </focus-area>`,
      )
      .join("\n");

    const blockingCriteriaXML = (config.review.blockingCriteria || [])
      .map(
        (criteria) => `
    <criterion>
      <condition>${this.escapeXML(criteria.condition)}</condition>
      <action>${criteria.action}</action>
      <reason>${this.escapeXML(criteria.reason)}</reason>
    </criterion>`,
      )
      .join("\n");

    const excludePatternsXML = config.review.excludePatterns
      .map((pattern) => `    <pattern>${this.escapeXML(pattern)}</pattern>`)
      .join("\n");

    return `
  <workflow-instructions>
${this.escapeXML(config.review.workflowInstructions)}
  </workflow-instructions>

  <focus-areas>
${focusAreasXML}
  </focus-areas>

  <blocking-criteria>
${blockingCriteriaXML}
  </blocking-criteria>

  <file-exclusions>
${excludePatternsXML}
  </file-exclusions>

  <tool-preferences>
    <lazy-loading>${config.review.toolPreferences.lazyLoading}</lazy-loading>
    <cache-results>${config.review.toolPreferences.cacheToolResults}</cache-results>
    <enable-code-search>${config.review.toolPreferences.enableCodeSearch}</enable-code-search>
    <enable-directory-listing>${config.review.toolPreferences.enableDirectoryListing}</enable-directory-listing>
    <max-tool-calls-per-file>${config.review.toolPreferences.maxToolCallsPerFile}</max-tool-calls-per-file>
  </tool-preferences>

  <context-settings>
    <context-lines>${config.review.contextLines}</context-lines>
    <max-files-per-review>${config.review.maxFilesPerReview}</max-files-per-review>
  </context-settings>
    `.trim();
  }

  /**
   * Escape XML special characters
   */
  private escapeXML(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /**
   * Load project-specific standards from repository
   */
  private async loadProjectStandards(
    config: YamaConfig,
  ): Promise<string | null> {
    if (!config.projectStandards?.customPromptsPath) {
      return null;
    }

    const promptsPath = config.projectStandards.customPromptsPath;
    const standardFiles = [
      "review-standards.md",
      "security-guidelines.md",
      "coding-conventions.md",
    ];

    const loadedStandards: string[] = [];

    for (const file of standardFiles) {
      const filePath = join(process.cwd(), promptsPath, file);
      if (existsSync(filePath)) {
        try {
          const content = await readFile(filePath, "utf-8");
          loadedStandards.push(`## From ${file}\n\n${content}`);
        } catch (error) {
          // Silently skip files that can't be read
          continue;
        }
      }
    }

    if (loadedStandards.length === 0) {
      return null;
    }

    return `
These are project-specific standards from the repository configuration.
Follow these in addition to the general focus areas:

${loadedStandards.join("\n\n---\n\n")}
    `.trim();
  }

  /**
   * Load knowledge base for AI prompt injection
   * Contains learned patterns from previous PR feedback
   */
  private async loadKnowledgeBase(config: YamaConfig): Promise<string | null> {
    if (!config.knowledgeBase?.enabled) {
      return null;
    }

    try {
      const kbManager = new KnowledgeBaseManager(config.knowledgeBase);
      const content = await kbManager.getForPrompt();

      if (content) {
        console.log("   📚 Knowledge base loaded for AI context");
      }

      return content;
    } catch (error) {
      // Silently fail - knowledge base is optional enhancement
      return null;
    }
  }

  /**
   * Build description enhancement prompt separately (for description-only operations)
   */
  async buildDescriptionEnhancementInstructions(
    request: ReviewRequest,
    config: YamaConfig,
  ): Promise<string> {
    // Base enhancement prompt - fetched from Langfuse or local fallback
    const basePrompt = await this.langfuseManager.getEnhancementPrompt();

    // Project-specific enhancement configuration
    const enhancementConfigXML = this.buildEnhancementConfigXML(config);

    return `
${basePrompt}

<project-configuration>
${enhancementConfigXML}
</project-configuration>

<enhancement-task>
  <workspace>${this.escapeXML(request.workspace)}</workspace>
  <repository>${this.escapeXML(request.repository)}</repository>
  <pull_request_id>${request.pullRequestId || "find-by-branch"}</pull_request_id>
  <branch>${this.escapeXML(request.branch || "N/A")}</branch>
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>

  <instructions>
    Enhance the PR description now.

    1. Call get_pull_request() to read current PR and description
    2. Call get_pull_request_diff() to analyze code changes
    3. Use search_code() to find configuration patterns, API changes
    4. Extract information for each required section
    5. Build enhanced description following section structure
    6. Call update_pull_request() with enhanced description

    CRITICAL: Return ONLY the enhanced description markdown.
    Do NOT include meta-commentary or explanations.
    Start directly with section content.

    ${request.dryRun ? "DRY RUN MODE: Simulate only, do not actually update PR." : "LIVE MODE: Update the actual PR description."}
    ${request.prompt ? `ADDITIONAL INSTRUCTIONS: ${this.escapeXML(request.prompt)}` : ""}
  </instructions>
</enhancement-task>
    `.trim();
  }

  /**
   * Build local SDK review instructions.
   * Produces strict JSON output for local diff quality analysis.
   */
  async buildLocalReviewInstructions(
    request: LocalReviewRequest,
    config: YamaConfig,
    diffContext: LocalDiffContext,
  ): Promise<string> {
    const focusAreas =
      request.focus && request.focus.length > 0
        ? request.focus
        : config.review.focusAreas.map((area) => area.name);
    const customPrompt = request.prompt ? request.prompt.trim() : "";
    const schemaVersion = request.outputSchemaVersion || "1.0";
    const diffPreviewMaxChars = 8_000;
    const diffPreview =
      diffContext.diff.length > diffPreviewMaxChars
        ? `${diffContext.diff.slice(0, diffPreviewMaxChars)}\n... [truncated preview]`
        : diffContext.diff;
    const exploreEnabled = config.ai.explore.enabled;

    const projectStandards = await this.loadProjectStandards(config);

    const rawPrompt = `
You are Yama operating in LOCAL SDK MODE.
Review the provided git changes and return a strict JSON object only.

${projectStandards ? `<project-standards>\n${projectStandards}\n</project-standards>\n` : ""}

Workflow (follow in order):
1. STANDARDS FIRST. Read <project-standards> above (if present). Treat any rule with severity=BLOCKING as a blocking criterion.
2. WALK FILES ONE AT A TIME. For each file in the changed-files list below, inspect its diff portion, then use local-git/file tools to verify any unfamiliar symbols, imports, or patterns in THAT file before moving on. Never analyse multiple files in parallel.
3. VERIFY BEFORE REPORTING.<!-- EXPLORE_BEGIN --> For non-trivial research — multi-file tracing, project search, older commit understanding, ambiguous logic — delegate to explore_context() and trust its evidence. Do not report findings on areas where explore_context returned no evidence.<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN --> Use bounded local-git/file tools (search_code, get_file_content) to verify before reporting. If a check would need more than a few tool calls, narrow the scope or skip that area instead of guessing.<!-- EXPLORE_DISABLED_END -->
4. NEVER use PR/Jira MCP tools in local mode.
5. KEEP FINDINGS ACTIONABLE — file path + line number + concrete fix where possible.
6. BUDGET — roughly 10 tool calls per file in the main loop. If you exceed it,<!-- EXPLORE_BEGIN --> delegate the rest to explore_context<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN --> stop investigating that file<!-- EXPLORE_DISABLED_END --> and move to the next file.
7. OUTPUT — return strict JSON only. No markdown code fences. Output must start with "{" and end with "}".

Focus Areas:
${focusAreas.map((area) => `- ${area}`).join("\n")}

${customPrompt ? `Additional Prompt:\n${customPrompt}\n` : ""}

Repository: ${diffContext.repoPath}
Diff Source: ${diffContext.diffSource}
${diffContext.baseRef ? `Base Ref: ${diffContext.baseRef}` : ""}
${diffContext.headRef ? `Head Ref: ${diffContext.headRef}` : ""}
Files Changed: ${diffContext.changedFiles.length}
Additions: ${diffContext.additions}
Deletions: ${diffContext.deletions}
Diff Truncated: ${diffContext.truncated}

Changed Files:
${diffContext.changedFiles.map((file) => `- ${file}`).join("\n")}

Initial Diff Preview (may be incomplete, use local-git tools for full context):
${diffPreview}

Output Schema (version ${schemaVersion}):
{
  "summary": "string",
  "decision": "APPROVED|CHANGES_REQUESTED|BLOCKED",
  "issues": [
    {
      "id": "string",
      "severity": "CRITICAL|MAJOR|MINOR|SUGGESTION",
      "category": "string",
      "title": "string",
      "description": "string",
      "filePath": "string",
      "line": 1,
      "suggestion": "string"
    }
  ],
  "enhancements": [
    {
      "id": "string",
      "severity": "CRITICAL|MAJOR|MINOR|SUGGESTION",
      "category": "string",
      "title": "string",
      "description": "string",
      "filePath": "string",
      "line": 1,
      "suggestion": "string"
    }
  ]
}
`;
    return PromptBuilder.stripDisabledSections(
      rawPrompt,
      exploreEnabled,
    ).trim();
  }

  /**
   * Build enhancement configuration in XML format
   */
  private buildEnhancementConfigXML(config: YamaConfig): string {
    const requiredSectionsXML = config.descriptionEnhancement.requiredSections
      .map(
        (section) => `
    <section key="${section.key}" required="${section.required}">
      <name>${this.escapeXML(section.name)}</name>
      <description>${this.escapeXML(section.description)}</description>
    </section>`,
      )
      .join("\n");

    return `
  <enhancement-instructions>
${this.escapeXML(config.descriptionEnhancement.instructions)}
  </enhancement-instructions>

  <required-sections>
${requiredSectionsXML}
  </required-sections>

  <settings>
    <preserve-content>${config.descriptionEnhancement.preserveContent}</preserve-content>
    <auto-format>${config.descriptionEnhancement.autoFormat}</auto-format>
  </settings>
    `.trim();
  }
}
