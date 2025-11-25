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
import { YamaV2Config } from "../types/config.types.js";
import { ReviewRequest } from "../types/v2.types.js";
import { REVIEW_SYSTEM_PROMPT } from "./ReviewSystemPrompt.js";
import { ENHANCEMENT_SYSTEM_PROMPT } from "./EnhancementSystemPrompt.js";

export class PromptBuilder {
  /**
   * Build complete review instructions for AI
   * Combines generic base prompt + project-specific config
   */
  async buildReviewInstructions(
    request: ReviewRequest,
    config: YamaV2Config,
  ): Promise<string> {
    // Base system prompt (generic, project-agnostic)
    const basePrompt = REVIEW_SYSTEM_PROMPT;

    // Project-specific configuration in XML format
    const projectConfig = this.buildProjectConfigXML(config, request);

    // Project-specific standards (if available)
    const projectStandards = await this.loadProjectStandards(config);

    // Combine all parts
    return `
${basePrompt}

<project-configuration>
${projectConfig}
</project-configuration>

${projectStandards ? `<project-standards>\n${projectStandards}\n</project-standards>` : ""}

<review-task>
  <workspace>${this.escapeXML(request.workspace)}</workspace>
  <repository>${this.escapeXML(request.repository)}</repository>
  <pull_request_id>${request.pullRequestId || "find-by-branch"}</pull_request_id>
  <branch>${this.escapeXML(request.branch || "N/A")}</branch>
  <mode>${request.dryRun ? "dry-run" : "live"}</mode>

  <instructions>
    Begin your autonomous code review now.

    1. Call get_pull_request() to read PR details and existing comments
    2. Analyze files one by one using get_pull_request_diff()
    3. Use search_code() BEFORE commenting on unfamiliar code
    4. Post comments immediately with add_comment() using code_snippet approach
    5. Apply blocking criteria to make final decision
    6. Call approve_pull_request() or request_changes()
    7. Post summary comment with statistics

    ${request.dryRun ? "DRY RUN MODE: Simulate actions only, do not post real comments." : "LIVE MODE: Post real comments and make real decisions."}
  </instructions>
</review-task>
    `.trim();
  }

  /**
   * Build project configuration in XML format
   * Injects project-specific rules into base system prompt
   */
  private buildProjectConfigXML(
    config: YamaV2Config,
    _request: ReviewRequest,
  ): string {
    const focusAreasXML = config.review.focusAreas
      .map(
        (area) => `
    <focus-area priority="${area.priority}">
      <name>${this.escapeXML(area.name)}</name>
      <description>${this.escapeXML(area.description)}</description>
    </focus-area>`,
      )
      .join("\n");

    const blockingCriteriaXML = config.review.blockingCriteria
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
    config: YamaV2Config,
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
   * Build description enhancement prompt separately (for description-only operations)
   */
  async buildDescriptionEnhancementInstructions(
    request: ReviewRequest,
    config: YamaV2Config,
  ): Promise<string> {
    // Base enhancement prompt (generic, project-agnostic)
    const basePrompt = ENHANCEMENT_SYSTEM_PROMPT;

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
  </instructions>
</enhancement-task>
    `.trim();
  }

  /**
   * Build enhancement configuration in XML format
   */
  private buildEnhancementConfigXML(config: YamaV2Config): string {
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
