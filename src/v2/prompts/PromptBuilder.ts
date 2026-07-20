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
import { YamaConfig } from "../types/index.js";
import {
  LocalDiffContext,
  LocalReviewRequest,
  ReviewRequest,
} from "../types/index.js";

import { LangfusePromptManager } from "./LangfusePromptManager.js";
import { buildReviewSystemPrompt } from "./ReviewSystemPrompt.js";
import { KnowledgeBaseManager } from "../learning/KnowledgeBaseManager.js";

export class PromptBuilder {
  private langfuseManager: LangfusePromptManager;

  constructor() {
    this.langfuseManager = new LangfusePromptManager();
  }

  /**
   * A generic pull-request identifier block, built from whatever fields the
   * request carries (owner/repo or workspace/repository, plus the PR id or a
   * branch). No provider is special-cased — it's just the data the agent needs
   * to know WHICH pull request to review; the agent uses the available tools.
   */
  private buildPullRequestXML(request: ReviewRequest): string {
    const org = (request.owner || request.workspace || "").trim();
    const repo = (request.repo || request.repository || "").trim();
    const prId = request.pullRequestId ?? request.prNumber;
    const branch = (request.branch || "").trim();
    const idLine =
      prId !== undefined && prId !== null
        ? `  <id>${prId}</id>`
        : branch
          ? `  <find-by-branch>${this.escapeXML(branch)}</find-by-branch>`
          : "";
    return `<pull-request>
  <repository>${this.escapeXML([org, repo].filter(Boolean).join("/"))}</repository>
${idLine}
</pull-request>`;
  }

  /**
   * Build complete review instructions. Generic and tool-agnostic: the base
   * prompt carries the method + severity + structured-output contract; this
   * layer adds the project config/standards and the target PR.
   */
  async buildReviewInstructions(
    request: ReviewRequest,
    config: YamaConfig,
    bootstrapStandards: string | null | undefined,
    previousReview?: string | null,
    teamRulesBlock?: string | null,
    projectDocs?: string | null,
  ): Promise<string> {
    const basePromptRaw = this.langfuseManager.isEnabled()
      ? await this.langfuseManager.getReviewPrompt()
      : buildReviewSystemPrompt();

    const projectConfig = this.buildProjectConfigXML(config, request);
    const projectStandards = await this.loadProjectStandards(config);
    const knowledgeBase = await this.loadKnowledgeBase(config);
    const exploreEnabled = config.ai.explore.enabled;

    const basePrompt = PromptBuilder.stripDisabledSections(
      basePromptRaw,
      exploreEnabled,
    );

    const modeLine = request.dryRun
      ? "DRY-RUN: analyze and return findings only. Do NOT post comments or change PR state."
      : "LIVE: post an inline comment for each issue and record your review decision using the available tools, then return the findings JSON.";
    const additional = request.prompt
      ? `\n  ADDITIONAL INSTRUCTIONS: ${this.escapeXML(request.prompt)}`
      : "";

    const bootstrapBlock =
      bootstrapStandards && bootstrapStandards.trim().length > 0
        ? `<bootstrapped-standards>
<!--
Recurring reviewer patterns observed in recent merged PRs on this repo.
Guidance that ranks BELOW <blocking-criteria> but ABOVE generic suggestions.
-->
${bootstrapStandards.trim()}
</bootstrapped-standards>`
        : "";

    return `
${basePrompt}

<project-configuration>
${projectConfig}
</project-configuration>

${projectStandards ? `<project-standards>\n${projectStandards}\n</project-standards>` : ""}

${teamRulesBlock && teamRulesBlock.trim() ? teamRulesBlock.trim() : ""}

${
  projectDocs && projectDocs.trim()
    ? `<project-docs>
<!-- The team's own project documentation (AGENTS.md / CLAUDE.md / …).
     Conventions stated here are enforceable review guidance. -->
${projectDocs.trim()}
</project-docs>`
    : ""
}

${bootstrapBlock}

${knowledgeBase ? `<learned-knowledge>\n${knowledgeBase}\n</learned-knowledge>` : ""}

${
  previousReview && previousReview.trim().length > 0
    ? `<previous-review>
<!--
Findings already reported on this pull request in earlier Yama runs.
INSTRUCTIONS:
- Do NOT post a new comment for any finding listed here — it already has one.
- Focus on the commits pushed since the last run; verify whether each listed
  finding is now fixed by reading the current code.
- Report ids you VERIFIED as fixed in the "resolvedIssueIds" array of your
  final JSON verdict. Include still-valid listed findings in "issues" (same
  file/severity/title) so the verdict reflects the full picture.
-->
${previousReview.trim()}
</previous-review>`
    : ""
}

<review-task>
${this.buildPullRequestXML(request)}
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>
  <instructions>
    Review the pull request above, one changed file at a time, following the
    method and severity rules in the system prompt. ${modeLine}${additional}
  </instructions>
</review-task>
    `.trim();
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
    const basePrompt = await this.langfuseManager.getEnhancementPrompt();
    const enhancementConfigXML = this.buildEnhancementConfigXML(config);

    return `
${basePrompt}

<project-configuration>
${enhancementConfigXML}
</project-configuration>

<enhancement-task>
${this.buildPullRequestXML(request)}
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>
  <instructions>
    Read the pull request and its diff using the available tools, then produce an
    enhanced description covering the required sections above.
    ${request.dryRun ? "DRY-RUN: return the enhanced description only, do not update the PR." : "LIVE: update the PR description using the available tool."}
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
3. VERIFY BEFORE REPORTING.<!-- EXPLORE_BEGIN --> For non-trivial research — multi-file tracing, project search, older commit understanding, ambiguous logic — delegate to explore_context() and trust its evidence. Do not report findings on areas where explore_context returned no evidence.<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN --> Use bounded local-git/file tools available to you to verify before reporting. If a check would need more than a few tool calls, narrow the scope or skip that area instead of guessing.<!-- EXPLORE_DISABLED_END -->
4. NEVER use PR MCP tools in local mode.
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
