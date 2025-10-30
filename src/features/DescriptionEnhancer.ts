/**
 * Enhanced Description Enhancer - Optimized to work with Unified Context
 * Preserves all original functionality from pr-describe.js but optimized
 */

import {
  EnhancementOptions,
  EnhancementResult,
  RequiredSection,
  PreservableContent,
  SectionAnalysis,
  AIProviderConfig,
  DescriptionEnhancementConfig,
  ProviderError,
} from "../types/index.js";
import { UnifiedContext } from "../core/ContextGatherer.js";
import { BitbucketProvider } from "../core/providers/BitbucketProvider.js";
import { logger } from "../utils/Logger.js";
import { initializeNeuroLink } from "../utils/NeuroLinkFactory.js";

export class DescriptionEnhancer {
  private neurolink: any;
  private bitbucketProvider: BitbucketProvider;
  private aiConfig: AIProviderConfig;
  private enhancementConfig: DescriptionEnhancementConfig;

  private defaultRequiredSections: RequiredSection[] = [
    { key: "changelog", name: "Changelog (Modules Modified)", required: true },
    {
      key: "testcases",
      name: "Test Cases (What to be tested)",
      required: true,
    },
    {
      key: "config_changes",
      name: "CAC Config Or Service Config Changes",
      required: true,
    },
  ];

  constructor(
    bitbucketProvider: BitbucketProvider,
    aiConfig: AIProviderConfig,
    enhancementConfig: DescriptionEnhancementConfig,
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.aiConfig = aiConfig;
    this.enhancementConfig = enhancementConfig;
  }

  /**
   * Get system prompt for description enhancement
   * Uses config.systemPrompt if provided, otherwise uses default
   */
  private getSystemPrompt(): string {
    const isCustomPrompt = !!this.enhancementConfig.systemPrompt;

    if (isCustomPrompt) {
      logger.debug("✓ Using custom systemPrompt from configuration");
      logger.debug(
        `Custom prompt preview: ${this.enhancementConfig.systemPrompt?.substring(0, 100)}...`,
      );
    } else {
      logger.debug("Using default systemPrompt (no custom prompt configured)");
    }

    return (
      this.enhancementConfig.systemPrompt ||
      `You are an Expert Technical Writer specializing in pull request documentation.
Focus on clarity, completeness, and helping reviewers understand the changes.

CRITICAL INSTRUCTION: Return ONLY the enhanced PR description content.
- DO NOT add meta-commentary like "No description provided" or "Here is the enhanced description"
- DO NOT add explanatory text about what you're doing
- START directly with the actual PR content (title, sections, etc.)
- If there's no existing description, just write the new sections without mentioning it`
    );
  }

  /**
   * Enhance description using pre-gathered unified context (OPTIMIZED)
   */
  async enhanceWithContext(
    context: UnifiedContext,
    options: EnhancementOptions,
  ): Promise<EnhancementResult> {
    const startTime = Date.now();

    try {
      logger.phase("📝 Enhancing PR description...");
      logger.info(`Processing PR #${context.pr.id}: "${context.pr.title}"`);

      // Step 1: Analyze existing content and identify what needs enhancement
      const sectionsToUse =
        options.customSections || this.defaultRequiredSections;

      logger.debug(
        `Checking ${sectionsToUse.length} required sections: ${sectionsToUse.map((s) => s.key).join(", ")}`,
      );

      const analysisResult = this.analyzeExistingContent(
        context.pr.description,
        sectionsToUse,
      );

      const presentSections = analysisResult.requiredSections
        .filter((s) => s.present)
        .map((s) => s.key);
      const missingSections = analysisResult.requiredSections
        .filter((s) => !s.present)
        .map((s) => s.key);

      if (presentSections.length > 0) {
        logger.debug(`✓ Present sections: ${presentSections.join(", ")}`);
      }
      if (missingSections.length > 0) {
        logger.debug(`✗ Missing sections: ${missingSections.join(", ")}`);
      }

      logger.info(
        `Content analysis: ${analysisResult.preservedContent.media.length} media items, ` +
          `${analysisResult.missingCount} missing sections`,
      );

      // Step 2: Generate enhanced description using AI
      const enhancedDescription = await this.generateEnhancedDescription(
        context,
        analysisResult,
        options,
      );

      // Step 3: Update PR description if not dry run
      if (!options.dryRun) {
        await this.updatePRDescription(context, enhancedDescription);
      } else {
        this.showDescriptionPreview(enhancedDescription, analysisResult);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      const result = this.generateEnhancementResult(
        context.pr.description,
        enhancedDescription,
        analysisResult,
        duration,
      );

      logger.success(
        `Description enhancement completed in ${duration}s: ` +
          `${result.sectionsAdded.length} sections added, ${result.sectionsEnhanced.length} enhanced`,
      );

      return result;
    } catch (error) {
      logger.error(
        `Description enhancement failed: ${(error as Error).message}`,
      );
      throw new ProviderError(
        `Description enhancement failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Analyze existing PR description content
   */
  private analyzeExistingContent(
    description: string,
    requiredSections: RequiredSection[],
  ): SectionAnalysis {
    logger.debug("Analyzing existing PR description content...");

    // Extract preservable content (media, files, links)
    const preservedContent = this.extractPreservableContent(description);

    // Validate required sections
    const sectionsAnalysis = this.validateRequiredSections(
      description,
      requiredSections,
    );
    const missingCount = sectionsAnalysis.filter((s) => !s.present).length;

    // Identify content gaps
    const gaps = this.identifyContentGaps(description);

    return {
      requiredSections: sectionsAnalysis,
      missingCount,
      preservedContent,
      gaps,
    };
  }

  /**
   * Extract preservable content (media, files, links)
   */
  private extractPreservableContent(description: string): PreservableContent {
    const preservableContent: PreservableContent = {
      media: [],
      files: [],
      links: [],
      originalText: description || "",
    };

    if (!description) {
      return preservableContent;
    }

    // Extract images and media (screenshots, etc.)
    const mediaRegex = /!\[.*?\]\(.*?\)|<img[^>]*>|<video[^>]*>|<audio[^>]*>/g;
    preservableContent.media = description.match(mediaRegex) || [];

    // Extract file attachments
    const fileRegex =
      /\[.*?\]\([^)]*\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|tar|gz)[^)]*\)/gi;
    preservableContent.files = description.match(fileRegex) || [];

    // Extract links (excluding images and files)
    const linkRegex = /\[[^\]]*\]\([^)]+\)/g;
    const allLinks = description.match(linkRegex) || [];
    preservableContent.links = allLinks.filter(
      (link) => !mediaRegex.test(link) && !fileRegex.test(link),
    );

    logger.debug(
      `Preservable content: ${preservableContent.media.length} media, ` +
        `${preservableContent.files.length} files, ${preservableContent.links.length} links`,
    );

    return preservableContent;
  }

  /**
   * Validate presence of required sections
   */
  private validateRequiredSections(
    description: string,
    requiredSections: RequiredSection[],
  ): RequiredSection[] {
    if (!description) {
      return requiredSections.map((section) => ({
        ...section,
        present: false,
        content: "",
      }));
    }

    const sectionPatterns: Record<string, RegExp[]> = {
      changelog: [
        /##.*?[Cc]hangelog/i,
        /##.*?[Mm]odules?\s+[Mm]odified/i,
        /##.*?[Cc]hanges?\s+[Mm]ade/i,
        /📋.*?[Cc]hangelog/i,
      ],
      testcases: [
        /##.*?[Tt]est\s+[Cc]ases?/i,
        /##.*?[Tt]esting/i,
        /🧪.*?[Tt]est/i,
        /##.*?[Tt]est\s+[Pp]lan/i,
      ],
      config_changes: [
        /##.*?[Cc]onfig/i,
        /##.*?CAC/i,
        /##.*?[Ss]ervice\s+[Cc]onfig/i,
        /⚙️.*?[Cc]onfig/i,
      ],
    };

    return requiredSections.map((section) => {
      let patterns = sectionPatterns[section.key];

      if (!patterns) {
        logger.debug(
          `No predefined pattern for section "${section.key}", using dynamic pattern based on name`,
        );

        const nameWords = section.name.split(/\s+/).filter((w) => w.length > 2); // Filter out short words like "Or", "Of"
        const namePattern = new RegExp(`##.*?${nameWords.join(".*?")}`, "i");

        const keyWords = section.key.split("_").filter((w) => w.length > 2);
        const keyPattern = new RegExp(`##.*?${keyWords.join(".*?")}`, "i");

        patterns = [namePattern, keyPattern];
      }

      const isPresent = patterns.some((pattern) => pattern.test(description));

      return {
        ...section,
        present: isPresent,
        content: isPresent
          ? this.extractSectionContent(description, patterns)
          : "",
      };
    });
  }

  /**
   * Extract content for a specific section
   */
  private extractSectionContent(
    description: string,
    patterns: RegExp[],
  ): string {
    for (const pattern of patterns) {
      const match = description.match(pattern);
      if (match) {
        const startIndex = match.index! + match[0].length;
        const nextHeaderIndex = description
          .substring(startIndex)
          .search(/\n##/);
        const endIndex =
          nextHeaderIndex === -1
            ? description.length
            : startIndex + nextHeaderIndex;
        return description.substring(startIndex, endIndex).trim();
      }
    }
    return "";
  }

  /**
   * Identify content gaps (TODOs, unanswered questions, etc.)
   */
  private identifyContentGaps(description: string): string[] {
    const gaps: string[] = [];

    if (!description) {
      gaps.push("No description provided");
      return gaps;
    }

    // Check for unanswered questions and placeholders
    const gapMarkers = [
      { pattern: /\?\s*$/gm, name: "unanswered questions" },
      { pattern: /TODO/gi, name: "TODO items" },
      { pattern: /FIXME/gi, name: "FIXME items" },
      { pattern: /\[TBD\]/gi, name: "TBD placeholders" },
      { pattern: /\[TO BE DETERMINED\]/gi, name: "TBD placeholders" },
      { pattern: /\[PENDING\]/gi, name: "pending items" },
    ];

    gapMarkers.forEach((marker) => {
      const matches = description.match(marker.pattern);
      if (matches) {
        gaps.push(`${matches.length} ${marker.name}`);
      }
    });

    return gaps;
  }

  /**
   * Generate enhanced description using AI and unified context
   */
  private async generateEnhancedDescription(
    context: UnifiedContext,
    analysisResult: SectionAnalysis,
    options: EnhancementOptions,
  ): Promise<string> {
    logger.debug("Generating AI-enhanced description...");

    // Initialize NeuroLink with observability config if not already done
    if (!this.neurolink) {
      this.neurolink = await initializeNeuroLink();
    }

    const enhancementPrompt = this.buildEnhancementPrompt(
      context,
      analysisResult,
      options,
    );

    try {
      const result = await this.neurolink.generate({
        input: { text: enhancementPrompt },
        systemPrompt: this.getSystemPrompt(), // Use config or default system prompt
        provider: this.aiConfig.provider,
        model: this.aiConfig.model,
        temperature: this.aiConfig.temperature || 0.7,
        maxTokens: this.aiConfig.maxTokens || 1000000,
        timeout: "8m", // Longer timeout for description generation
        enableAnalytics: this.aiConfig.enableAnalytics,
        enableEvaluation: this.aiConfig.enableEvaluation,
      });

      let enhancedDescription =
        result.content ||
        (result as any).text ||
        (result as any).response ||
        "";

      // Clean up any markdown code blocks if AI wrapped the response
      enhancedDescription = enhancedDescription
        .replace(/^```markdown\s*/, "")
        .replace(/\s*```$/, "")
        .trim();

      // Remove any meta-commentary that AI might have added
      enhancedDescription = enhancedDescription
        .replace(/^No description provided\.?\s*/i, "")
        .replace(/^Here is the enhanced description:?\s*/i, "")
        .replace(/^I will enhance.*?:\s*/i, "")
        .replace(/^Enhanced description:?\s*/i, "")
        .trim();

      if (!enhancedDescription) {
        throw new Error("AI generated empty description");
      }

      // Validate that required sections are present after enhancement
      const finalValidation = this.validateRequiredSections(
        enhancedDescription,
        options.customSections || this.defaultRequiredSections,
      );

      const stillMissing = finalValidation.filter((s) => !s.present);
      if (stillMissing.length > 0) {
        const missingSectionNames = stillMissing.map((s) => s.key).join(", ");
        logger.warn(
          `Warning: ${stillMissing.length} required sections still missing after AI enhancement: ${missingSectionNames}`,
        );
        logger.debug(
          `AI may not have added these sections or they don't match detection patterns`,
        );
      } else {
        logger.debug(
          `✓ All ${finalValidation.length} required sections are now present`,
        );
      }

      return enhancedDescription;
    } catch (error) {
      if ((error as Error).message?.includes("timeout")) {
        logger.error("⏰ Description enhancement timed out after 8 minutes");
        throw new Error(
          "Enhancement timeout - try with smaller diff or adjust timeout",
        );
      }
      logger.error(
        `AI description generation failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Build comprehensive enhancement prompt using unified context
   */
  private buildEnhancementPrompt(
    context: UnifiedContext,
    analysisResult: SectionAnalysis,
    _options: EnhancementOptions,
  ): string {
    // Prepare diff information based on strategy
    let diffInfo = "";
    if (context.diffStrategy.strategy === "whole" && context.prDiff) {
      diffInfo = `**Diff Strategy**: Whole PR diff (${context.diffStrategy.fileCount} files)
**Changes**: ${JSON.stringify(context.prDiff.fileChanges?.slice(0, 20) || [], null, 2)}`;
    } else if (
      context.diffStrategy.strategy === "file-by-file" &&
      context.fileDiffs
    ) {
      const fileList = Array.from(context.fileDiffs.keys()).slice(0, 20);
      diffInfo = `**Diff Strategy**: File-by-file analysis (${context.diffStrategy.fileCount} files)
**Modified Files**: ${JSON.stringify(fileList, null, 2)}`;
    }

    const customInstructions =
      this.enhancementConfig.enhancementInstructions || "";

    if (customInstructions) {
      logger.debug("✓ Using custom enhancementInstructions from configuration");
      logger.debug(
        `Instructions preview: ${customInstructions.substring(0, 80)}...`,
      );
    } else {
      logger.debug("Using default enhancementInstructions");
    }

    return `${customInstructions || "You are an expert technical writer specializing in comprehensive PR descriptions."}

## PR INFORMATION:
**Title**: ${context.pr.title}
**Author**: ${context.pr.author}
**Current Description**: 
${analysisResult.preservedContent.originalText || "[No existing description]"}

## CODE CHANGES ANALYSIS:
${diffInfo}

## PROJECT CONTEXT:
${context.projectContext.memoryBank.summary}

## PROJECT RULES:
${context.projectContext.clinerules || "No specific rules defined"}

## CONTENT PRESERVATION REQUIREMENTS:
**CRITICAL**: This is content ENHANCEMENT, not replacement!

### Preserved Content Analysis:
- **Media Items**: ${analysisResult.preservedContent.media.length} (${analysisResult.preservedContent.media.join(", ")})
- **File Attachments**: ${analysisResult.preservedContent.files.length} (${analysisResult.preservedContent.files.join(", ")})
- **Links**: ${analysisResult.preservedContent.links.length}
- **Content Gaps**: ${analysisResult.gaps.join(", ") || "None identified"}

### PRESERVATION RULES:
- **NEVER REMOVE**: Screenshots, images, file attachments, existing explanations, or links
- **PRESERVE EXACTLY**: All media links, file references, and existing valuable content
- **ONLY ADD**: Missing required sections or enhance clearly incomplete ones
- **MAINTAIN**: Original structure, tone, and author's explanations

## REQUIRED SECTIONS STATUS:
${analysisResult.requiredSections
  .map(
    (section: any) => `
**${section.name}**:
- Present: ${section.present ? "✅ Yes" : "❌ Missing"}
- Content: ${section.content ? `"${section.content.substring(0, 100)}..."` : "None"}
- Action Needed: ${section.present ? ((section.content?.length || 0) < 50 ? "Enhancement" : "None") : "Add Section"}`,
  )
  .join("")}

## REQUIRED SECTIONS TO IMPLEMENT:

### 1. 📋 CHANGELOG (Modules Modified)
**Purpose**: Clear documentation of what changed
**Content Requirements**:
- List specific files/modules modified, added, or removed
- Categorize changes (Features, Bug Fixes, Improvements, Breaking Changes)
- Mention key components affected
- Highlight any architectural changes

### 2. 🧪 TEST CASES (What to be tested)
**Purpose**: Comprehensive testing guidance
**Content Requirements**:
- Unit tests to run or add
- Integration test scenarios
- Manual testing steps for reviewers
- Edge cases to verify
- Regression testing considerations
- Performance testing if applicable

### 3. ⚙️ CAC CONFIG OR SERVICE CONFIG CHANGES
**Purpose**: Infrastructure and configuration impact
**Content Requirements**:
- Configuration files modified
- Environment variables added/changed/removed
- Service configuration updates
- Database schema changes
- Deployment considerations
- If no config changes: explicitly state "No configuration changes required"

## ENHANCEMENT STRATEGY:

### For Missing Sections:
1. **START** with the complete existing description
2. **ANALYZE** the code changes to understand the scope
3. **ADD** each missing required section with comprehensive content
4. **EXTRACT** relevant information from the diff to populate sections

### For Incomplete Sections:
1. **PRESERVE** all existing content in the section
2. **ENHANCE** with additional details based on code analysis
3. **MAINTAIN** the original structure and format

### Content Generation Guidelines:
- **Be Specific**: Use actual file names, function names, and module names from the changes
- **Be Actionable**: Provide clear, executable test instructions
- **Be Complete**: Cover all aspects of the change comprehensively
- **Be Professional**: Maintain technical accuracy and clear communication

## OUTPUT REQUIREMENTS:
Return the COMPLETE enhanced description as properly formatted markdown text (NOT JSON).

**CRITICAL INSTRUCTIONS**:
1. **START WITH**: The entire existing description as your foundation
2. **PRESERVE**: Every single piece of existing content (media, links, explanations)
3. **ADD ONLY**: Missing required sections at appropriate locations
4. **ENHANCE ONLY**: Clearly incomplete sections with additional details
5. **EXTRACT**: Specific details from the code changes for accuracy
6. **MAINTAIN**: Professional tone and clear markdown formatting

Generate the enhanced description now, ensuring ALL preservation requirements are met:`;
  }

  /**
   * Update PR description in Bitbucket
   */
  private async updatePRDescription(
    context: UnifiedContext,
    enhancedDescription: string,
  ): Promise<void> {
    logger.debug(`Updating PR description for #${context.pr.id}...`);

    try {
      await this.bitbucketProvider.updatePRDescription(
        context.identifier,
        enhancedDescription,
      );

      logger.success("✅ PR description updated successfully");
    } catch (error) {
      logger.error(
        `Failed to update PR description: ${(error as Error).message}`,
      );
      throw new ProviderError(
        `Description update failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Show description preview for dry run
   */
  private showDescriptionPreview(
    enhancedDescription: string,
    analysisResult: SectionAnalysis,
  ): void {
    console.log("\n" + "═".repeat(80));
    console.log("📝 ENHANCED PR DESCRIPTION PREVIEW");
    console.log("═".repeat(80));
    console.log(enhancedDescription);
    console.log("═".repeat(80));

    console.log("\n📊 ENHANCEMENT SUMMARY:");
    console.log(
      `✅ Required sections completed: ${analysisResult.requiredSections.filter((s: any) => s.present).length}/${analysisResult.requiredSections.length}`,
    );
    console.log(
      `📎 Preserved content: ${analysisResult.preservedContent.media.length} media items, ${analysisResult.preservedContent.files.length} files`,
    );
    console.log(
      `📏 Enhanced description length: ${enhancedDescription.length} characters`,
    );

    if (analysisResult.gaps.length > 0) {
      console.log(
        `🔍 Content gaps addressed: ${analysisResult.gaps.join(", ")}`,
      );
    }
  }

  /**
   * Generate enhancement result summary
   */
  private generateEnhancementResult(
    originalDescription: string,
    enhancedDescription: string,
    analysisResult: SectionAnalysis,
    _duration: number,
  ): EnhancementResult {
    // Determine what sections were added or enhanced
    const originalSections = this.validateRequiredSections(
      originalDescription,
      analysisResult.requiredSections,
    );
    const enhancedSections = this.validateRequiredSections(
      enhancedDescription,
      analysisResult.requiredSections,
    );

    const sectionsAdded = enhancedSections
      .filter((enhanced, i) => enhanced.present && !originalSections[i].present)
      .map((s) => s.name);

    const sectionsEnhanced = enhancedSections
      .filter(
        (enhanced, i) =>
          enhanced.present &&
          originalSections[i].present &&
          (enhanced.content?.length || 0) >
            (originalSections[i].content?.length || 0) + 50,
      )
      .map((s) => s.name);

    const completedSections = enhancedSections.filter((s) => s.present).length;

    return {
      originalDescription: originalDescription || "",
      enhancedDescription,
      sectionsAdded,
      sectionsEnhanced,
      preservedItems: {
        media: analysisResult.preservedContent.media.length,
        files: analysisResult.preservedContent.files.length,
        links: analysisResult.preservedContent.links.length,
      },
      statistics: {
        originalLength: originalDescription?.length || 0,
        enhancedLength: enhancedDescription.length,
        completedSections,
        totalSections: analysisResult.requiredSections.length,
      },
    };
  }

  /**
   * Get enhancement statistics
   */
  getStats(): any {
    return {
      defaultSections: this.defaultRequiredSections.length,
      aiProvider: this.aiConfig.provider,
    };
  }
}

export function createDescriptionEnhancer(
  bitbucketProvider: BitbucketProvider,
  aiConfig: AIProviderConfig,
  enhancementConfig: DescriptionEnhancementConfig,
): DescriptionEnhancer {
  return new DescriptionEnhancer(
    bitbucketProvider,
    aiConfig,
    enhancementConfig,
  );
}
