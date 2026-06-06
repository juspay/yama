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
import { buildReviewSystemPrompt } from "./ReviewSystemPrompt.js";
import { KnowledgeBaseManager } from "../learning/KnowledgeBaseManager.js";
import {
  getProviderToolset,
  type ProviderToolset,
  type ReviewPromptParams,
  type VCSProviderName,
} from "../providers/ProviderToolset.js";

export class PromptBuilder {
  private langfuseManager: LangfusePromptManager;

  constructor() {
    this.langfuseManager = new LangfusePromptManager();
  }

  /**
   * Build the provider-agnostic params object the ProviderToolset consumes.
   * Carries both Bitbucket (workspace/repository/pullRequestId) and GitHub
   * (owner/repo/prNumber) identifiers plus the shared branch; each toolset
   * reads only the fields it needs.
   */
  private toToolsetParams(request: ReviewRequest): ReviewPromptParams {
    const params: ReviewPromptParams = {};

    const workspace = (request.workspace || "").trim();
    const repository = (request.repository || "").trim();
    const branch = (request.branch || "N/A").trim();

    params.workspace = workspace;
    params.repository = repository;
    params.branch = branch;

    // Coalesce the PR identifier across both field names so the toolset always
    // receives the PR number regardless of which one the caller populated.
    // GitHub's identifierXml reads params.prNumber while Bitbucket's reads
    // params.pullRequestId; CLI callers set request.pullRequestId even for
    // GitHub, so without this a GitHub run would lose the PR number and fall
    // back to 'find-by-branch'. No-op for existing Bitbucket behavior.
    const resolvedPrNumber =
      request.prNumber ??
      (typeof request.pullRequestId === "number"
        ? request.pullRequestId
        : undefined);
    const resolvedPullRequestId = request.pullRequestId ?? request.prNumber;

    if (resolvedPullRequestId !== undefined) {
      params.pullRequestId = resolvedPullRequestId;
    }
    if (request.owner !== undefined) {
      params.owner = request.owner.trim();
    }
    // Coalesce the repo name across the GitHub-specific 'repo' field and the
    // shared 'repository' field, mirroring the prNumber<->pullRequestId
    // coalescing above. A GitHub caller may populate the shared 'repository'
    // field instead of 'repo'; without this the toolset would receive GitHub
    // identifiers with no repo name. No-op for existing Bitbucket behavior,
    // which never sets request.repo.
    const resolvedRepo = request.repo ?? request.repository;
    if (resolvedRepo !== undefined) {
      params.repo = resolvedRepo.trim();
    }
    if (resolvedPrNumber !== undefined) {
      params.prNumber = resolvedPrNumber;
    }

    return params;
  }

  /**
   * Build complete review instructions for AI
   * Combines generic base prompt + project-specific config
   */
  async buildReviewInstructions(
    request: ReviewRequest,
    config: YamaConfig,
    bootstrapStandards: string | null | undefined,
    provider: VCSProviderName,
  ): Promise<string> {
    const toolset = getProviderToolset(provider);

    // Base system prompt. Prefer a Langfuse-managed prompt when one is
    // configured (provider-agnostic remote override); otherwise fall back to
    // the provider-aware local prompt so the <tool-usage> section matches the
    // active provider's tool idiom.
    const basePromptRaw = this.langfuseManager.isEnabled()
      ? await this.langfuseManager.getReviewPrompt()
      : buildReviewSystemPrompt(toolset);

    // Project-specific configuration in XML format
    const projectConfig = this.buildProjectConfigXML(config, request);

    // Project-specific standards (if available)
    const projectStandards = await this.loadProjectStandards(config);

    // Knowledge base learnings (reinforcement learning)
    const knowledgeBase = await this.loadKnowledgeBase(config);
    const exploreEnabled = config.ai.explore.enabled;

    // Bitbucket native task creation: enabled only when provider is bitbucket
    // and bitbucket.taskCreation.enabled = true.
    const taskCreationEnabled =
      provider === "bitbucket" &&
      config.mcpServers.bitbucket?.taskCreation?.enabled === true;

    // Strip explore_context references when the subagent is disabled,
    // and task creation references when that feature is disabled.
    const basePrompt = PromptBuilder.stripDisabledSections(
      basePromptRaw,
      exploreEnabled,
      taskCreationEnabled,
    );

    const toolsetParams = this.toToolsetParams(request);

    const workflowBlock = PromptBuilder.stripDisabledSections(
      this.buildReviewWorkflow(request, toolset, toolsetParams),
      exploreEnabled,
      taskCreationEnabled,
    );

    const taskCreationBlock = taskCreationEnabled
      ? this.buildBitbucketTaskCreationBlock(config)
      : "";

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
${toolset.identifierXml(toolsetParams)}
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>

${taskCreationBlock}
${workflowBlock}
</review-task>
    `.trim();
  }

  /**
   * Per-PR workflow block. Standards-first, file-by-file, explore-on-uncertainty.
   * The agent stays autonomous; this just choreographs the order it should follow.
   */
  private buildReviewWorkflow(
    request: ReviewRequest,
    toolset: ProviderToolset,
    params: ReviewPromptParams,
  ): string {
    const modeLine = request.dryRun
      ? "DRY RUN MODE: simulate actions only, do not post real comments or change PR state."
      : "LIVE MODE: post real comments and make real decisions.";
    const additional = request.prompt
      ? `\n  ADDITIONAL INSTRUCTIONS: ${this.escapeXML(request.prompt)}`
      : "";

    // The numbered review steps (tool names + workflow prose) come from the
    // provider toolset; the <instructions> wrapper and the dynamic mode/
    // additional tail stay here so they apply to every provider unchanged.
    return `  <instructions>
${toolset.reviewWorkflowInstructions(params)}

    ${modeLine}${additional}
  </instructions>`;
  }

  /**
   * Strip sections that depend on explore_context being enabled, and sections
   * that depend on Bitbucket task creation being enabled.
   * Keeps the prompt single-source and avoids forking files for the disabled case.
   *
   * Markers and their semantics:
   *   <!-- EXPLORE_BEGIN -->...<!-- EXPLORE_END -->         — kept when explore ON, removed when OFF.
   *   <!-- EXPLORE_DISABLED_BEGIN -->...<!-- EXPLORE_DISABLED_END --> — removed when explore ON.
   *   <!-- TASK_CREATE_BEGIN -->...<!-- TASK_CREATE_END -->  — kept when task creation ON, removed when OFF.
   *
   * The marker comments themselves are always stripped.
   *
   * Implementation uses linear indexOf/slice instead of regex to avoid any
   * polynomial-backtracking risk on adversarial input.
   */
  static stripDisabledSections(
    prompt: string,
    exploreEnabled: boolean,
    taskCreationEnabled: boolean = false,
  ): string {
    const EXPLORE_BEGIN = "<!-- EXPLORE_BEGIN -->";
    const EXPLORE_END = "<!-- EXPLORE_END -->";
    const EXPLORE_DISABLED_BEGIN = "<!-- EXPLORE_DISABLED_BEGIN -->";
    const EXPLORE_DISABLED_END = "<!-- EXPLORE_DISABLED_END -->";
    const TASK_CREATE_BEGIN = "<!-- TASK_CREATE_BEGIN -->";
    const TASK_CREATE_END = "<!-- TASK_CREATE_END -->";

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

    // --- Explore sections ---
    let result: string;
    if (exploreEnabled) {
      result = stripBlock(prompt, EXPLORE_DISABLED_BEGIN, EXPLORE_DISABLED_END);
      result = removeAll(result, EXPLORE_BEGIN);
      result = removeAll(result, EXPLORE_END);
    } else {
      result = stripBlock(prompt, EXPLORE_BEGIN, EXPLORE_END);
      result = removeAll(result, EXPLORE_DISABLED_BEGIN);
      result = removeAll(result, EXPLORE_DISABLED_END);
    }

    // --- Task creation sections ---
    if (taskCreationEnabled) {
      // Keep the content inside TASK_CREATE markers, just remove the markers.
      result = removeAll(result, TASK_CREATE_BEGIN);
      result = removeAll(result, TASK_CREATE_END);
    } else {
      // Strip the entire TASK_CREATE block.
      result = stripBlock(result, TASK_CREATE_BEGIN, TASK_CREATE_END);
    }

    return result;
  }

  /**
   * Build the <bitbucket-task-creation> XML block injected into <review-task>.
   *
   * Only emitted when bitbucket.taskCreation.enabled = true. Contains:
   *  - Severity-based path: convert every qualifying comment into a task.
   *  - Keyword-based path: AI appends taskKeyword to any comment to escalate it.
   *  - Conditional rules: repo-specific "if PR touches X → create task Y" rules
   *    evaluated once in STEP 2 before the file-by-file review starts.
   */
  private buildBitbucketTaskCreationBlock(config: YamaConfig): string {
    const tc = config.mcpServers.bitbucket?.taskCreation;
    if (!tc?.enabled) {
      return "";
    }

    const severities = (tc.severities ?? ["CRITICAL", "MAJOR"]).join(", ");
    const keyword = tc.taskKeyword ?? "[TASK]";
    const keywordEnabled = keyword.length > 0;
    const rules = tc.conditionalTaskRules ?? [];

    const keywordPath = keywordEnabled
      ? `
      PATH 2 — Keyword-based (per-comment discretion):
      For any inline comment at ANY severity level that you judge deserves a
      developer action item — even MINOR or SUGGESTION — append "${keyword}" to
      the comment_text body. Then follow the same convert_pr_item flow (steps
      1-3 above). Use this sparingly for genuinely important non-critical findings
      where you want the developer to explicitly acknowledge the issue.
`
      : "";

    const onlyClause = keywordEnabled
      ? `severities: ${severities}, or when the comment body contains "${keyword}"`
      : `severities: ${severities}`;

    const noTaskClause = keywordEnabled
      ? `Do NOT call these tools for MINOR or SUGGESTION unless the comment body contains "${keyword}".`
      : `Do NOT call convert_pr_item or create_pr_task for MINOR or SUGGESTION.`;

    // Build the conditional rules section (only if rules are defined)
    const conditionalRulesBlock =
      rules.length > 0
        ? `\n  <conditional-task-rules>
    <!-- Evaluated ONCE in STEP 2, immediately after you read the changed files
         list from get_pull_request. For each rule whose trigger is met, call
         create_pr_task once with the configured task text. Never call a rule's
         task more than once per review, and never evaluate these rules inside
         explore_context. -->
${rules
  .map((rule) => {
    const triggers: string[] = [];
    if (rule.triggerWhen.always) {
      triggers.push(
        `<trigger-always>true — fire for every PR regardless of changes</trigger-always>`,
      );
    }
    if (rule.triggerWhen.filesMatch && rule.triggerWhen.filesMatch.length > 0) {
      triggers.push(
        `<trigger-files-match>Fire if ANY changed file path matches (case-insensitive substring or glob): ${rule.triggerWhen.filesMatch.map((p) => `"${this.escapeXML(p)}"`).join(", ")}</trigger-files-match>`,
      );
    }
    if (
      rule.triggerWhen.diffContains &&
      rule.triggerWhen.diffContains.length > 0
    ) {
      triggers.push(
        `<trigger-diff-contains>Fire if ANY of these appear in the diff content or file paths (case-insensitive): ${rule.triggerWhen.diffContains.map((p) => `"${this.escapeXML(p)}"`).join(", ")}</trigger-diff-contains>`,
      );
    }
    return `    <rule name="${this.escapeXML(rule.name)}"${rule.description ? ` description="${this.escapeXML(rule.description)}"` : ""}>
${triggers.map((t) => `      ${t}`).join("\n")}
      <task-text>${this.escapeXML(rule.createTask.text)}</task-text>
    </rule>`;
  })
  .join("\n")}
  </conditional-task-rules>`
        : "";

    return `  <bitbucket-task-creation>
    <enabled>true</enabled>
    <severities>${severities}</severities>${keywordEnabled ? `\n    <task-keyword>${keyword}</task-keyword>` : ""}
    <instructions>
      PART A — Conditional task rules (evaluated ONCE in STEP 2, before file review):
      After reading the PR's changed files list, evaluate each rule in
      &lt;conditional-task-rules&gt;. If a rule's trigger is met, call
      create_pr_task(workspace, repository, pull_request_id, text="&lt;rule task-text&gt;")
      immediately. Fire each rule at most once.

      PART B — Comment-to-task conversion (evaluated in STEP 3 per comment):
      Tasks are created after inline comments via two trigger paths:

      PATH 1 — Severity-based (automatic):
      For every inline comment you post with severity in [${severities}]:

      1. Post the comment with add_comment as normal.
      2. Immediately call create_pr_task(workspace, repository, pull_request_id,
            text="[SEVERITY] &lt;file_path&gt;:&lt;line&gt; — &lt;brief issue description&gt;").
         This is unconditional — do NOT depend on or wait for the add_comment id.
      3. Optional enhancement: also call convert_pr_item with:
         - workspace, repository, pull_request_id (same as the review context)
         - id: the comment.id value from the add_comment response JSON (nested under "comment" object, NOT a top-level field)
         - direction: "to_task"
         If convert_pr_item errors, ignore it — create_pr_task in step 2 already satisfies the requirement.
      Do NOT move to the next file until create_pr_task has been called.
${keywordPath}
       RECONCILIATION MODE: If you decide NOT to call add_comment for a CRITICAL/MAJOR
       finding because an existing comment already covers it (seen in STEP 2's
       get_pull_request response), you MUST still call create_pr_task for that finding
       (and optionally convert_pr_item with the existing comment's id).
       Do not skip task creation just because the comment is from a prior run.

      If both methods fail:
      - The PR comment was already posted — do NOT skip it.
      - Do NOT abort or pause the review.
      - Continue to the next file.

      ONLY convert/create comment-derived tasks for ${onlyClause}.
      ${noTaskClause}
      Do NOT call these tools inside explore_context.
    </instructions>
  </bitbucket-task-creation>${conditionalRulesBlock}`;
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
    provider: VCSProviderName,
  ): Promise<string> {
    const toolset = getProviderToolset(provider);
    const toolsetParams = this.toToolsetParams(request);

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
${toolset.identifierXml(toolsetParams)}
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>

  <instructions>
${toolset.descriptionEnhancementInstructions(toolsetParams)}

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
