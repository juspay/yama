/**
 * Enhanced Code Reviewer - Optimized to work with Unified Context
 * Preserves all original functionality from pr-police.js but optimized
 */

// NeuroLink will be dynamically imported
import {
  Violation,
  ReviewResult,
  ReviewOptions,
  AIProviderConfig,
  CodeReviewConfig,
  ProviderError,
  BatchProcessingConfig,
  FileBatch,
  BatchResult,
  PrioritizedFile,
  FilePriority,
  DuplicateDetectionResult,
  PRComment,
  IncrementalState,
} from "../types/index.js";
import { UnifiedContext } from "../core/ContextGatherer.js";
import { BitbucketProvider } from "../core/providers/BitbucketProvider.js";
import { logger } from "../utils/Logger.js";
import { getProviderTokenLimit } from "../utils/ProviderLimits.js";

export class CodeReviewer {
  private neurolink: any;
  private bitbucketProvider: BitbucketProvider;
  private aiConfig: AIProviderConfig;
  private reviewConfig: CodeReviewConfig;

  constructor(
    bitbucketProvider: BitbucketProvider,
    aiConfig: AIProviderConfig,
    reviewConfig: CodeReviewConfig,
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.aiConfig = aiConfig;
    this.reviewConfig = reviewConfig;
  }

  /**
   * Enhanced review method with AI duplicate detection and incremental analysis
   */
  async reviewCodeWithContext(
    context: UnifiedContext,
    options: ReviewOptions,
  ): Promise<ReviewResult> {
    const startTime = Date.now();

    try {
      logger.phase("🧪 Conducting AI-powered code analysis...");

      // Enhanced logging for incremental vs full analysis
      if (context.diffStrategy.reason.includes("Incremental")) {
        logger.success("⚡ INCREMENTAL ANALYSIS MODE");
        logger.info(`📁 Analyzing ${context.diffStrategy.fileCount} changed files`);
        logger.info(`🎯 Strategy: ${context.diffStrategy.reason}`);
      } else {
        logger.info(
          `📁 Analyzing ${context.diffStrategy.fileCount} files using ${context.diffStrategy.strategy} strategy`,
        );
      }

      // Step 1: Determine if we should use batch processing
      const batchConfig = this.getBatchProcessingConfig();
      const shouldUseBatchProcessing = this.shouldUseBatchProcessing(context, batchConfig);

      // Step 2: Get violations (either full or incremental)
      let violations: Violation[];
      let processingStrategy: "single-request" | "batch-processing";

      if (shouldUseBatchProcessing) {
        logger.info("🔄 Using batch processing for large PR analysis");
        const batchResult = await this.reviewWithBatchProcessing(context, options, batchConfig);
        violations = batchResult.violations;
        processingStrategy = "batch-processing";
      } else {
        logger.info("⚡ Using single-request analysis for small PR");
        const analysisPrompt = this.buildAnalysisPrompt(context, options);
        violations = await this.analyzeWithAI(analysisPrompt, context);
        processingStrategy = "single-request";
      }

      // Step 3: AI duplicate detection (always enabled)
      const uniqueViolations = await this.filterDuplicatesWithAI(violations, context);

      // Step 4: Validate violations to ensure code snippets exist in diff
      const validatedViolations = this.validateViolations(uniqueViolations, context);

      // Step 5: Post comments if not dry run (for both single-request and batch processing)
      if (!options.dryRun && validatedViolations.length > 0) {
        logger.info(`📝 Posting ${validatedViolations.length} comments after ${processingStrategy} analysis`);
        await this.postComments(context, validatedViolations, options);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      const result = this.generateReviewResult(
        validatedViolations,
        duration,
        context,
        processingStrategy,
      );

      // Log duplicate detection results
      const duplicatesFiltered = violations.length - uniqueViolations.length;
      if (duplicatesFiltered > 0) {
        logger.info(`🔍 Filtered ${duplicatesFiltered} duplicate violations`);
      }

      logger.success(
        `Code review completed in ${duration}s: ${validatedViolations.length} violations found ` +
        `(${duplicatesFiltered} duplicates filtered, ${processingStrategy})`,
      );

      return result;
    } catch (error) {
      logger.error(`Code review failed: ${(error as Error).message}`);
      throw new ProviderError(
        `Code review failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Review code using pre-gathered unified context (OPTIMIZED with Batch Processing)
   * @deprecated Use reviewCodeWithContext instead - this method is kept for compatibility
   */
  async reviewCodeWithContextLegacy(
    context: UnifiedContext,
    options: ReviewOptions,
  ): Promise<ReviewResult> {
    // Delegate to new enhanced method but disable duplicate detection for legacy compatibility
    const enhancedOptions = { ...options, enableDuplicateDetection: false };
    return this.reviewCodeWithContext(context, enhancedOptions);
  }

  /**
   * Validate violations to ensure code snippets exist in diff
   */
  private validateViolations(
    violations: Violation[],
    context: UnifiedContext,
  ): Violation[] {
    const validatedViolations: Violation[] = [];
    const diffContent = this.extractDiffContent(context);

    for (const violation of violations) {
      if (
        violation.type === "inline" &&
        violation.code_snippet &&
        violation.file
      ) {
        // Check if the code snippet exists in the diff
        if (diffContent.includes(violation.code_snippet)) {
          validatedViolations.push(violation);
        } else {
          // Try to find a close match and fix the snippet
          const fixedViolation = this.tryFixCodeSnippet(violation, context);
          if (fixedViolation) {
            validatedViolations.push(fixedViolation);
          } else {
            logger.debug(
              `⚠️ Skipping violation - snippet not found in diff: ${violation.file}`,
            );
            logger.debug(`   Original snippet: "${violation.code_snippet}"`);
          }
        }
      } else {
        // Non-inline violations are always valid
        validatedViolations.push(violation);
      }
    }

    logger.debug(
      `Validated ${validatedViolations.length} out of ${violations.length} violations`,
    );
    return validatedViolations;
  }

  /**
   * Try to fix code snippet by finding it in the actual diff
   */
  private tryFixCodeSnippet(
    violation: Violation,
    context: UnifiedContext,
  ): Violation | null {
    if (!violation.file || !violation.code_snippet) {return null;}

    try {
      // Get the diff for this specific file
      let fileDiff: string | undefined;

      if (context.diffStrategy.strategy === "whole" && context.prDiff) {
        // Extract file diff from whole diff - handle different path formats
        const diffLines = context.prDiff.diff.split("\n");
        let fileStartIndex = -1;

        // Generate all possible path variations
        const pathVariations = this.generatePathVariations(violation.file);

        // Try to find the file in the diff with various path formats
        for (let i = 0; i < diffLines.length; i++) {
          const line = diffLines[i];
          if (line.startsWith("diff --git") || line.startsWith("Index:")) {
            for (const pathVariation of pathVariations) {
              if (line.includes(pathVariation)) {
                fileStartIndex = i;
                break;
              }
            }
            if (fileStartIndex >= 0) {break;}
          }
        }

        if (fileStartIndex >= 0) {
          const nextFileIndex = diffLines.findIndex(
            (line: string, idx: number) =>
              idx > fileStartIndex &&
              (line.startsWith("diff --git") || line.startsWith("Index:")),
          );

          fileDiff = diffLines
            .slice(
              fileStartIndex,
              nextFileIndex > 0 ? nextFileIndex : diffLines.length,
            )
            .join("\n");
        }
      } else if (
        context.diffStrategy.strategy === "file-by-file" &&
        context.fileDiffs
      ) {
        // Try all path variations
        const pathVariations = this.generatePathVariations(violation.file);

        for (const path of pathVariations) {
          fileDiff = context.fileDiffs.get(path);
          if (fileDiff) {
            logger.debug(
              `Found diff for ${violation.file} using variation: ${path}`,
            );
            break;
          }
        }

        // If still not found, try partial matching
        if (!fileDiff) {
          for (const [key, value] of context.fileDiffs.entries()) {
            if (key.endsWith(violation.file) || violation.file.endsWith(key)) {
              fileDiff = value;
              logger.debug(
                `Found diff for ${violation.file} using partial match: ${key}`,
              );
              break;
            }
          }
        }
      }

      if (!fileDiff) {
        logger.debug(`❌ Could not find diff for file: ${violation.file}`);
        return null;
      }

      // First, try to find the exact line with line number extraction
      const lineInfo = this.extractLineNumberFromDiff(
        fileDiff,
        violation.code_snippet,
      );
      if (lineInfo) {
        const fixedViolation = { ...violation };
        fixedViolation.line_type = lineInfo.lineType;

        // Extract search context from the diff
        const diffLines = fileDiff.split("\n");
        const snippetIndex = diffLines.findIndex(
          (line) => line === violation.code_snippet,
        );
        if (snippetIndex > 0 && snippetIndex < diffLines.length - 1) {
          fixedViolation.search_context = {
            before: [diffLines[snippetIndex - 1]],
            after: [diffLines[snippetIndex + 1]],
          };
        }

        logger.debug(
          `✅ Found exact match with line number for ${violation.file}`,
        );
        return fixedViolation;
      }

      // Fallback: Clean the snippet and try fuzzy matching
      const cleanSnippet = violation.code_snippet
        .trim()
        .replace(/^[+\-\s]/, ""); // Remove diff prefix for searching

      // Look for the clean snippet in the diff
      const diffLines = fileDiff.split("\n");
      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];
        const cleanLine = line.replace(/^[+\-\s]/, "").trim();

        if (
          cleanLine.includes(cleanSnippet) ||
          cleanSnippet.includes(cleanLine)
        ) {
          // Found a match! Update the violation with the correct snippet
          const fixedViolation = { ...violation };
          fixedViolation.code_snippet = line; // Use the full line with diff prefix

          // Update search context if needed
          if (i > 0 && i < diffLines.length - 1) {
            fixedViolation.search_context = {
              before: [diffLines[i - 1]],
              after: [diffLines[i + 1]],
            };
          }

          logger.debug(
            `✅ Fixed code snippet for ${violation.file} using fuzzy match`,
          );
          return fixedViolation;
        }
      }

      logger.debug(`❌ Could not find snippet in diff for ${violation.file}`);
      logger.debug(`   Looking for: "${violation.code_snippet}"`);
    } catch (error) {
      logger.debug(`Error fixing code snippet: ${(error as Error).message}`);
    }

    return null;
  }

  /**
   * Get system prompt for security-focused code review
   */
  private getSecurityReviewSystemPrompt(): string {
    return (
      this.reviewConfig.systemPrompt ||
      `You are an Expert Security Code Reviewer for enterprise applications. Your role is to:

🔒 SECURITY FIRST: Prioritize security vulnerabilities and data protection
⚡ PERFORMANCE AWARE: Identify performance bottlenecks and optimization opportunities  
🏗️ QUALITY FOCUSED: Ensure maintainable, readable, and robust code
🛡️ ERROR RESILIENT: Verify comprehensive error handling and edge cases

You provide actionable, educational feedback with specific examples and solutions.
Focus on critical issues that could impact production systems.

CRITICAL INSTRUCTION: When identifying issues, you MUST copy the EXACT line from the diff, including the diff prefix (+, -, or space). Do not modify or clean the line in any way.`
    );
  }

  /**
   * Get analysis requirements from config or defaults
   */
  private getAnalysisRequirements(): string {
    if (
      this.reviewConfig.focusAreas &&
      this.reviewConfig.focusAreas.length > 0
    ) {
      return this.reviewConfig.focusAreas
        .map((area: string) => `### ${area}`)
        .join("\n\n");
    }

    // Default analysis requirements
    return `### 🔒 Security Analysis (CRITICAL PRIORITY)
- SQL/XSS/Command injection vulnerabilities
- Authentication/authorization flaws
- Input validation and sanitization
- Hardcoded secrets or credentials
- Data exposure and privacy concerns

### ⚡ Performance Review
- Algorithm efficiency and complexity
- Database query optimization
- Memory management and resource leaks
- Caching opportunities

### 🏗️ Code Quality
- SOLID principles compliance
- Error handling robustness
- Code organization and readability
- Test coverage considerations`;
  }

  /**
   * Build focused analysis prompt separated from context
   */
  private buildCoreAnalysisPrompt(context: UnifiedContext): string {
    const diffContent = this.extractDiffContent(context);
    const existingIssuesSummary = this.formatExistingIssuesForAI(context.pr.comments || []);

    return `Conduct a comprehensive security and quality analysis of this ${context.diffStrategy.strategy === "whole" ? "pull request" : "code changeset"}.

## COMPLETE PR CONTEXT:
**Title**: ${context.pr.title}
**Author**: ${context.pr.author}  
**Description**: ${context.pr.description}
**Files Changed**: ${context.pr.fileChanges?.length || 0}
**Branch**: ${context.identifier.branch}
**Repository**: ${context.identifier.workspace}/${context.identifier.repository}

## ALREADY REPORTED ISSUES (DO NOT DUPLICATE):
${existingIssuesSummary}

## DIFF STRATEGY (${context.diffStrategy.strategy.toUpperCase()}):
**Reason**: ${context.diffStrategy.reason}
**File Count**: ${context.diffStrategy.fileCount}
**Estimated Size**: ${context.diffStrategy.estimatedSize}

## COMPLETE PROJECT CONTEXT:
${context.projectContext.memoryBank.projectContext || context.projectContext.memoryBank.summary}

## PROJECT RULES & STANDARDS:
${context.projectContext.clinerules || "No specific rules defined"}

## COMPLETE CODE CHANGES (NO TRUNCATION):
${diffContent}

## CRITICAL INSTRUCTIONS FOR CODE SNIPPETS:

When you identify an issue in the code, you MUST:
1. Copy the EXACT line from the diff above, including the diff prefix (+, -, or space at the beginning)
2. Do NOT modify, clean, or reformat the line
3. Include the complete line as it appears in the diff
4. If the issue spans multiple lines, choose the most relevant single line

Example of CORRECT snippet format:
- For added lines: "+    const password = 'hardcoded123';"
- For removed lines: "-    return userData;"  
- For context lines: "     function processPayment() {"

Example of INCORRECT snippet format (DO NOT DO THIS):
- "const password = 'hardcoded123';" (missing the + prefix)
- "return userData" (missing the - prefix and semicolon)

## ANALYSIS REQUIREMENTS:

${this.getAnalysisRequirements()}

### 📋 OUTPUT FORMAT
Return ONLY valid JSON:
{
  "violations": [
    {
      "type": "inline",
      "file": "exact/file/path.ext",
      "code_snippet": "EXACT line from diff INCLUDING the +/- prefix",
      "search_context": {
        "before": ["line before from diff with prefix"],
        "after": ["line after from diff with prefix"]
      },
      "severity": "CRITICAL|MAJOR|MINOR|SUGGESTION",
      "category": "security|performance|maintainability|functionality",
      "issue": "Brief issue title",
      "message": "Detailed explanation",
      "impact": "Potential impact description",
      "suggestion": "Clean, executable code fix (no diff symbols)"
    }
  ],
  "summary": "Analysis summary",
  "positiveObservations": ["Good practices found"],
  "statistics": {
    "filesReviewed": ${context.diffStrategy.fileCount},
    "totalIssues": 0,
    "criticalCount": 0,
    "majorCount": 0,
    "minorCount": 0,
    "suggestionCount": 0
  }
}`;
  }

  /**
   * Extract diff content based on strategy
   */
  private extractDiffContent(context: UnifiedContext): string {
    if (context.diffStrategy.strategy === "whole" && context.prDiff) {
      return context.prDiff.diff || JSON.stringify(context.prDiff, null, 2);
    } else if (
      context.diffStrategy.strategy === "file-by-file" &&
      context.fileDiffs
    ) {
      const fileDiffArray = Array.from(context.fileDiffs.entries()).map(
        ([file, diff]) => ({
          file,
          diff,
        }),
      );
      return JSON.stringify(fileDiffArray, null, 2);
    }
    return "No diff content available";
  }

  /**
   * Detect project type for better context
   */
  private detectProjectType(context: UnifiedContext): string {
    const fileExtensions = new Set<string>();

    // Extract file extensions from changes
    if (context.pr.fileChanges) {
      context.pr.fileChanges.forEach((file: any) => {
        const ext = file.split(".").pop()?.toLowerCase();
        if (ext) {fileExtensions.add(ext);}
      });
    }

    if (fileExtensions.has("rs") || fileExtensions.has("res"))
      {return "rescript";}
    if (fileExtensions.has("ts") || fileExtensions.has("tsx"))
      {return "typescript";}
    if (fileExtensions.has("js") || fileExtensions.has("jsx"))
      {return "javascript";}
    if (fileExtensions.has("py")) {return "python";}
    if (fileExtensions.has("go")) {return "golang";}
    if (fileExtensions.has("java")) {return "java";}
    if (fileExtensions.has("cpp") || fileExtensions.has("c")) {return "cpp";}

    return "mixed";
  }

  /**
   * Assess complexity level for better AI context
   */
  private assessComplexity(
    context: UnifiedContext,
  ): "low" | "medium" | "high" | "very-high" {
    const fileCount = context.diffStrategy.fileCount;
    const hasLargeFiles = context.diffStrategy.estimatedSize.includes("Large");
    const hasComments = (context.pr.comments?.length || 0) > 0;

    if (fileCount > 50) {return "very-high";}
    if (fileCount > 20 || hasLargeFiles) {return "high";}
    if (fileCount > 10 || hasComments) {return "medium";}
    return "low";
  }

  /**
   * Legacy method - kept for compatibility but simplified
   */
  private buildAnalysisPrompt(
    context: UnifiedContext,
    _options: ReviewOptions,
  ): string {
    // Legacy method - now delegates to new structure
    return this.buildCoreAnalysisPrompt(context);
  }

  /**
   * Get safe token limit based on AI provider using shared utility
   */
  private getSafeTokenLimit(): number {
    const provider = this.aiConfig.provider || "auto";
    const configuredTokens = this.aiConfig.maxTokens;
    
    // Use conservative limits for CodeReviewer (safer for large diffs)
    const providerLimit = getProviderTokenLimit(provider, true);
    
    // Use the smaller of configured tokens or provider limit
    if (configuredTokens && configuredTokens > 0) {
      const safeLimit = Math.min(configuredTokens, providerLimit);
      logger.debug(`Token limit: configured=${configuredTokens}, provider=${providerLimit}, using=${safeLimit}`);
      return safeLimit;
    }

    logger.debug(`Token limit: using provider default=${providerLimit} for ${provider}`);
    return providerLimit;
  }

  /**
   * Analyze code with AI using the enhanced prompt
   */
  private async analyzeWithAI(
    prompt: string,
    context: UnifiedContext,
  ): Promise<Violation[]> {
    try {
      logger.debug("Starting AI analysis...");

      // Initialize NeuroLink with eval-based dynamic import
      if (!this.neurolink) {
        const { NeuroLink  } = await import("@juspay/neurolink");
        this.neurolink = new NeuroLink();
      }

      // Extract context from unified context for better AI understanding
      const aiContext = {
        operation: "code-review",
        repository: `${context.identifier.workspace}/${context.identifier.repository}`,
        branch: context.identifier.branch,
        prId: context.identifier.pullRequestId,
        prTitle: context.pr.title,
        prAuthor: context.pr.author,
        fileCount: context.diffStrategy.fileCount,
        diffStrategy: context.diffStrategy.strategy,
        analysisType:
          context.diffStrategy.strategy === "whole"
            ? "comprehensive"
            : "file-by-file",
        projectType: this.detectProjectType(context),
        hasExistingComments: (context.pr.comments?.length || 0) > 0,
        complexity: this.assessComplexity(context),
      };

      // Simplified, focused prompt without context pollution
      const corePrompt = this.buildCoreAnalysisPrompt(context);

      // Log AI input data for debugging
      console.log("AI Analysis Prompt -----> ", corePrompt);
      console.log("AI System Prompt -----> ", this.getSecurityReviewSystemPrompt());
      console.log("AI Context Data -----> ", aiContext);

      // Get safe token limit based on provider
      const safeMaxTokens = this.getSafeTokenLimit();
      
      // Log AI configuration for debugging
      console.log("AI Config -----> ", {
        provider: this.aiConfig.provider || "auto",
        model: this.aiConfig.model || "best",
        temperature: this.aiConfig.temperature || 0.3,
        maxTokens: safeMaxTokens,
        timeout: "15m",
        enableAnalytics: this.aiConfig.enableAnalytics || true,
        enableEvaluation: false
      });
      
      logger.debug(`Using AI provider: ${this.aiConfig.provider || "auto"}`);
      logger.debug(`Configured maxTokens: ${this.aiConfig.maxTokens}`);
      logger.debug(`Safe maxTokens limit: ${safeMaxTokens}`);

      const result = await this.neurolink.generate({
        input: { text: corePrompt },
        systemPrompt: this.getSecurityReviewSystemPrompt(),
        provider: this.aiConfig.provider || "auto", // Auto-select best provider
        model: this.aiConfig.model || "best", // Use most capable model
        temperature: this.aiConfig.temperature || 0.3, // Lower for more focused analysis
        maxTokens: safeMaxTokens, // Use provider-aware safe token limit
        timeout: "15m", // Allow plenty of time for thorough analysis
        context: aiContext,
        enableAnalytics: this.aiConfig.enableAnalytics || true,
        enableEvaluation: false, // Disabled to prevent evaluation warnings
      });

      // Log analytics if available
      if (result.analytics) {
        logger.debug(
          `AI Analytics - Provider: ${result.provider}, Response Time: ${result.responseTime}ms, Quality Score: ${result.evaluation?.overallScore}`,
        );
      }

      logger.debug("AI analysis completed, parsing response...");

      // Log raw AI response for debugging
      console.log("Raw AI Response -----> ", result);

      // Modern NeuroLink returns { content: string }
      const analysisData = this.parseAIResponse(result);

      // Log parsed analysis data for debugging
      console.log("Parsed Analysis Data -----> ", analysisData);

      // Display AI response for debugging
      if (logger.getConfig().verbose) {
        logger.debug("AI Analysis Response:");
        logger.debug("═".repeat(80));
        logger.debug(JSON.stringify(analysisData, null, 2));
        logger.debug("═".repeat(80));
      }

      if (!analysisData.violations || !Array.isArray(analysisData.violations)) {
        logger.debug("No violations array found in AI response");
        return [];
      }

      logger.debug(
        `AI analysis found ${analysisData.violations.length} violations`,
      );
      return analysisData.violations;
    } catch (error) {
      if ((error as Error).message?.includes("timeout")) {
        logger.error("⏰ AI analysis timed out after 15 minutes");
        throw new Error(
          "Analysis timeout - try reducing diff size or adjusting timeout",
        );
      }
      logger.error(`AI analysis failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Post comments to PR using unified context - matching pr-police.js exactly
   */
  private async postComments(
    context: UnifiedContext,
    violations: Violation[],
    _options: ReviewOptions,
  ): Promise<void> {
    logger.phase("📝 Posting review comments...");

    let commentsPosted = 0;
    let commentsFailed = 0;
    const failedComments: { file?: string; issue: string; error: string }[] =
      [];

    // Post inline comments
    const inlineViolations = violations.filter(
      (v) => v.type === "inline" && v.file && v.code_snippet,
    );

    for (const violation of inlineViolations) {
      try {
        // Clean file path - remove protocol prefixes ONLY (keep a/ and b/ prefixes)
        let cleanFilePath = violation.file!;
        if (cleanFilePath.startsWith("src://")) {
          cleanFilePath = cleanFilePath.replace("src://", "");
        }
        if (cleanFilePath.startsWith("dst://")) {
          cleanFilePath = cleanFilePath.replace("dst://", "");
        }

        // Clean code snippet and fix search context - EXACTLY like pr-police.js
        const processedViolation = this.cleanCodeSnippet(violation);
        if (!processedViolation) {
          logger.debug(`⚠️ Skipping invalid violation for ${cleanFilePath}`);
          continue;
        }

        const formattedComment = this.formatInlineComment(processedViolation);

        // Debug logging
        logger.debug(`🔍 Posting inline comment:`);
        logger.debug(`   File: ${cleanFilePath}`);
        logger.debug(`   Issue: ${processedViolation.issue}`);
        logger.debug(`   Original snippet: ${violation.code_snippet}`);
        logger.debug(
          `   Processed snippet: ${processedViolation.code_snippet}`,
        );
        if (processedViolation.search_context) {
          logger.debug(
            `   Search context before: ${JSON.stringify(processedViolation.search_context.before)}`,
          );
          logger.debug(
            `   Search context after: ${JSON.stringify(processedViolation.search_context.after)}`,
          );
        }

        // Use new code snippet approach - EXACTLY like pr-police.js
        await this.bitbucketProvider.addComment(
          context.identifier,
          formattedComment,
          {
            filePath: cleanFilePath,
            lineNumber: undefined, // No line number needed - use pure snippet matching
            lineType: processedViolation.line_type || "ADDED", // Default to ADDED if not specified
            codeSnippet: processedViolation.code_snippet,
            searchContext: processedViolation.search_context,
            matchStrategy: "best", // Use best match strategy instead of strict for flexibility
            suggestion: processedViolation.suggestion, // Pass the suggestion for inline code suggestions
          },
        );

        commentsPosted++;
        logger.debug(
          `✅ Posted inline comment: ${cleanFilePath} (${processedViolation.issue})`,
        );
      } catch (error) {
        commentsFailed++;
        const errorMsg = (error as Error).message;
        logger.debug(`❌ Failed to post inline comment: ${errorMsg}`);
        logger.debug(`   File: ${violation.file}, Issue: ${violation.issue}`);
        logger.debug(`   Code snippet: ${violation.code_snippet}`);

        failedComments.push({
          file: violation.file,
          issue: violation.issue,
          error: errorMsg,
        });
      }
    }

    // Post summary comment (include failed comments info if any)
    if (violations.length > 0) {
      try {
        const summaryComment = this.generateSummaryComment(
          violations,
          context,
          failedComments,
        );
        await this.bitbucketProvider.addComment(
          context.identifier,
          summaryComment,
        );
        commentsPosted++;
        logger.debug("✅ Posted summary comment");
      } catch (error) {
        logger.debug(
          `❌ Failed to post summary comment: ${(error as Error).message}`,
        );
      }
    }

    logger.success(`✅ Posted ${commentsPosted} comments successfully`);
    if (commentsFailed > 0) {
      logger.warn(`⚠️ Failed to post ${commentsFailed} inline comments`);
    }
  }

  /**
   * Format inline comment for specific violation
   */
  private formatInlineComment(violation: Violation): string {
    const severityConfig = {
      CRITICAL: {
        emoji: "🚨",
        badge: "**🚨 CRITICAL SECURITY ISSUE**",
        color: "red",
      },
      MAJOR: { emoji: "⚠️", badge: "**⚠️ MAJOR ISSUE**", color: "orange" },
      MINOR: { emoji: "📝", badge: "**📝 MINOR IMPROVEMENT**", color: "blue" },
      SUGGESTION: { emoji: "💡", badge: "**💡 SUGGESTION**", color: "green" },
    };

    const categoryIcons = {
      security: "🔒",
      performance: "⚡",
      maintainability: "🏗️",
      functionality: "⚙️",
      error_handling: "🛡️",
      testing: "🧪",
      general: "📋",
    };

    const config = severityConfig[violation.severity] || severityConfig.MINOR;
    const categoryIcon =
      categoryIcons[violation.category] || categoryIcons.general;

    let comment = `${config.badge}

**${categoryIcon} ${violation.issue}**

**Category**: ${violation.category.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}

**Issue**: ${violation.message}`;

    if (violation.impact) {
      comment += `\n\n**Impact**: ${violation.impact}`;
    }

    // Add suggested fix section if suggestion is provided
    if (violation.suggestion) {
      comment += `\n\n**Suggested Fix**:\n`;
      
      // Detect the language for syntax highlighting
      const language = this.detectLanguageFromFile(violation.file || "");
      
      // Use proper markdown escaping for code blocks
      const escapedCodeBlock = this.escapeMarkdownCodeBlock(violation.suggestion, language);
      comment += escapedCodeBlock;
    }

    comment += `\n\n---\n*🛡️ Automated review by **Yama** • Powered by AI*`;

    return comment;
  }

  /**
   * Generate comprehensive summary comment with failed comments info
   */
  private generateSummaryComment(
    violations: Violation[],
    context: UnifiedContext,
    failedComments: { file?: string; issue: string; error: string }[] = [],
  ): string {
    const stats = this.calculateStats(violations);

    const statusEmoji =
      stats.criticalCount > 0
        ? "🚨"
        : stats.majorCount > 0
          ? "⚠️ "
          : stats.minorCount > 0
            ? "📝"
            : "✅";

    const statusText =
      stats.criticalCount > 0
        ? "CRITICAL ISSUES FOUND"
        : stats.majorCount > 0
          ? "ISSUES DETECTED"
          : stats.minorCount > 0
            ? "IMPROVEMENTS SUGGESTED"
            : "CODE QUALITY APPROVED";

    let comment = `
╭─────────────────────────────────────────────────────────────╮
│                    ⚔️ **YAMA REVIEW REPORT** ⚔️               │
╰─────────────────────────────────────────────────────────────╯

## ${statusEmoji} **${statusText}**

### 📊 **Security & Quality Analysis**
| **Severity** | **Count** | **Status** |
|--------------|-----------|------------|
| 🚨 Critical | ${stats.criticalCount} | ${stats.criticalCount > 0 ? "⛔ Must Fix" : "✅ Clear"} |
| ⚠️ Major | ${stats.majorCount} | ${stats.majorCount > 0 ? "⚠️ Should Fix" : "✅ Clear"} |
| 📝 Minor | ${stats.minorCount} | ${stats.minorCount > 0 ? "📝 Consider Fixing" : "✅ Clear"} |
| 💡 Suggestions | ${stats.suggestionCount} | ${stats.suggestionCount > 0 ? "💡 Optional" : "✅ Clear"} |

### 🔍 **Analysis Summary**
- **📁 Files Analyzed**: ${context.diffStrategy.fileCount}
- **📊 Strategy Used**: ${context.diffStrategy.strategy} (${context.diffStrategy.reason})
- **🎯 Total Issues**: ${stats.totalIssues}
- **🏷️ PR**: #${context.pr.id} - "${context.pr.title}"`;

    // Add category breakdown if there are violations
    const violationsByCategory = this.groupViolationsByCategory(violations);
    if (Object.keys(violationsByCategory).length > 0) {
      comment += `\n\n### 📍 **Issues by Category**\n`;

      for (const [category, categoryViolations] of Object.entries(
        violationsByCategory,
      )) {
        const categoryIcons = {
          security: "🔒",
          performance: "⚡",
          maintainability: "🏗️",
          functionality: "⚙️",
          error_handling: "🛡️",
          testing: "🧪",
          general: "📋",
        };

        const icon =
          categoryIcons[category as keyof typeof categoryIcons] || "📋";
        const name = category
          .replace(/_/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase());

        comment += `**${icon} ${name}**: ${categoryViolations.length} issue${categoryViolations.length !== 1 ? "s" : ""}\n`;
      }
    }

    // Add failed comments section if any
    if (failedComments.length > 0) {
      comment += `\n\n### ⚠️ **Note on Inline Comments**\n`;
      comment += `Some inline comments could not be posted due to code matching issues. `;
      comment += `Please review the following issues manually:\n\n`;

      for (const failed of failedComments) {
        comment += `- **${failed.issue}** in \`${failed.file || "unknown file"}\`\n`;
      }
    }

    // Add recommendation
    const recommendation =
      stats.criticalCount > 0
        ? "🚨 **URGENT**: Critical security issues must be resolved before merge"
        : stats.majorCount > 0
          ? "⚠️ **RECOMMENDED**: Address major issues before merge"
          : stats.minorCount > 0
            ? "📝 **OPTIONAL**: Consider addressing minor improvements"
            : "✅ **APPROVED**: Code meets security and quality standards";

    comment += `\n\n### 💡 **Recommendation**
${recommendation}

---
**🛡️ Automated Security & Quality Review**  
*Powered by Yama AI • Keeping your code secure and maintainable* 🚀`;

    return comment;
  }

  /**
   * Helper methods for processing violations
   */
  private cleanFilePath(filePath: string): string {
    // Clean the file path but preserve the structure - EXACTLY like pr-police.js
    // Only clean src:// and dst:// prefixes, keep a/ and b/ prefixes
    const cleaned = filePath.replace(/^(src|dst):\/\//, "");

    // Log the cleaning for debugging
    if (cleaned !== filePath) {
      logger.debug(`Cleaned file path: ${filePath} -> ${cleaned}`);
    }

    return cleaned;
  }

  /**
   * Extract exact file path from diff
   */
  private extractFilePathFromDiff(
    diff: string,
    fileName: string,
  ): string | null {
    const lines = diff.split("\n");
    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        // Extract both paths: a/path/to/file b/path/to/file
        const match = line.match(/diff --git a\/(.*?) b\/(.*?)$/);
        if (
          match &&
          (match[1].includes(fileName) || match[2].includes(fileName))
        ) {
          return match[2]; // Return the 'b/' path (destination)
        }
      }
    }
    return null;
  }

  /**
   * Extract line number from diff for a specific code snippet
   */
  private extractLineNumberFromDiff(
    fileDiff: string,
    codeSnippet: string,
  ): { lineNumber: number; lineType: "ADDED" | "REMOVED" | "CONTEXT" } | null {
    const lines = fileDiff.split("\n");
    let currentNewLine = 0;
    let currentOldLine = 0;
    let inHunk = false;

    // Debug logging
    logger.debug(`Looking for snippet: "${codeSnippet}"`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse hunk headers (e.g., @@ -10,6 +10,8 @@)
      const hunkMatch = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (hunkMatch) {
        // Hunk headers show the starting line numbers (1-based)
        currentOldLine = parseInt(hunkMatch[1]);
        currentNewLine = parseInt(hunkMatch[2]);
        inHunk = true;
        logger.debug(
          `Found hunk header: old=${currentOldLine}, new=${currentNewLine}`,
        );
        continue;
      }

      // Skip lines that aren't part of the diff content
      if (
        !inHunk ||
        (!line.startsWith("+") &&
          !line.startsWith("-") &&
          !line.startsWith(" "))
      ) {
        continue;
      }

      // Check if this line matches our snippet
      if (line === codeSnippet) {
        let resultLine: number;
        let lineType: "ADDED" | "REMOVED" | "CONTEXT";

        if (line.startsWith("+")) {
          resultLine = currentNewLine;
          lineType = "ADDED";
        } else if (line.startsWith("-")) {
          resultLine = currentOldLine;
          lineType = "REMOVED";
        } else {
          resultLine = currentNewLine;
          lineType = "CONTEXT";
        }

        logger.debug(`Found match at line ${resultLine} (${lineType})`);
        return { lineNumber: resultLine, lineType };
      }

      // Update line counters AFTER checking for match
      // For added lines: only increment new line counter
      // For removed lines: only increment old line counter
      // For context lines: increment both counters
      if (line.startsWith("+")) {
        currentNewLine++;
      } else if (line.startsWith("-")) {
        currentOldLine++;
      } else if (line.startsWith(" ")) {
        currentNewLine++;
        currentOldLine++;
      }
    }

    logger.debug(`Snippet not found in diff`);
    return null;
  }

  /**
   * Escape markdown code blocks properly
   */
  private escapeMarkdownCodeBlock(code: string, language: string): string {
    // If code contains triple backticks, use quadruple backticks
    if (code.includes("```")) {
      return `\`\`\`\`${language}\n${code}\n\`\`\`\``;
    }
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  private cleanCodeSnippet(violation: Violation): Violation | null {
    try {
      // Clone the violation to avoid modifying the original - EXACTLY like pr-police.js
      const fixed = JSON.parse(JSON.stringify(violation));

      // Fix search_context arrays if they contain embedded newlines
      if (fixed.search_context) {
        if (
          fixed.search_context.before &&
          Array.isArray(fixed.search_context.before)
        ) {
          fixed.search_context.before = this.splitArrayLines(
            fixed.search_context.before,
          );
        }
        if (
          fixed.search_context.after &&
          Array.isArray(fixed.search_context.after)
        ) {
          fixed.search_context.after = this.splitArrayLines(
            fixed.search_context.after,
          );
        }
      }

      // Ensure line_type is set based on code snippet prefix BEFORE cleaning
      if (!fixed.line_type && fixed.code_snippet) {
        if (fixed.code_snippet.startsWith("+")) {
          fixed.line_type = "ADDED";
        } else if (fixed.code_snippet.startsWith("-")) {
          fixed.line_type = "REMOVED";
        } else {
          fixed.line_type = "CONTEXT";
        }
      }

      // Clean the code_snippet field to remove diff symbols - EXACTLY like pr-police.js
      if (fixed.code_snippet) {
        fixed.code_snippet = fixed.code_snippet.replace(/^[+\-\s]/, "").trim();
      }

      // Clean the suggestion field to remove any diff symbols
      if (fixed.suggestion) {
        fixed.suggestion = fixed.suggestion
          .split("\n")
          .map((line: string) => line.replace(/^[+\-\s]/, "")) // Remove diff symbols at start of each line
          .join("\n")
          .trim();
      }

      return fixed;
    } catch (error) {
      logger.debug(
        `❌ Error cleaning code snippet: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private splitArrayLines(arr: string[]): string[] {
    const result: string[] = [];
    for (const item of arr) {
      if (typeof item === "string" && item.includes("\n")) {
        result.push(...item.split("\n").filter((line) => line.length > 0));
      } else {
        result.push(item);
      }
    }
    return result;
  }

  private groupViolationsByCategory(
    violations: Violation[],
  ): Record<string, Violation[]> {
    const grouped: Record<string, Violation[]> = {};

    violations.forEach((v) => {
      const category = v.category || "general";
      if (!grouped[category]) {grouped[category] = [];}
      grouped[category].push(v);
    });

    return grouped;
  }

  private calculateStats(violations: Violation[]): any {
    return {
      criticalCount: violations.filter((v) => v.severity === "CRITICAL").length,
      majorCount: violations.filter((v) => v.severity === "MAJOR").length,
      minorCount: violations.filter((v) => v.severity === "MINOR").length,
      suggestionCount: violations.filter((v) => v.severity === "SUGGESTION")
        .length,
      totalIssues: violations.length,
      filesReviewed:
        new Set(violations.filter((v) => v.file).map((v) => v.file)).size || 1,
    };
  }

  private generateReviewResult(
    violations: Violation[],
    _duration: number,
    _context: UnifiedContext,
    processingStrategy?: "single-request" | "batch-processing",
  ): ReviewResult {
    const stats = this.calculateStats(violations);

    return {
      violations,
      summary: `Review found ${stats.criticalCount} critical, ${stats.majorCount} major, ${stats.minorCount} minor issues, and ${stats.suggestionCount} suggestions`,
      statistics: {
        filesReviewed: stats.filesReviewed,
        totalIssues: stats.totalIssues,
        criticalCount: stats.criticalCount,
        majorCount: stats.majorCount,
        minorCount: stats.minorCount,
        suggestionCount: stats.suggestionCount,
        processingStrategy,
      },
      positiveObservations: [], // Could be extracted from AI response
    };
  }

  // ============================================================================
  // BATCH PROCESSING METHODS
  // ============================================================================

  /**
   * Get batch processing configuration with defaults
   */
  private getBatchProcessingConfig(): BatchProcessingConfig {
    const defaultConfig: BatchProcessingConfig = {
      enabled: true,
      maxFilesPerBatch: 3,
      prioritizeSecurityFiles: true,
      parallelBatches: false, // Sequential for better reliability
      batchDelayMs: 1000,
      singleRequestThreshold: 5, // Use single request for ≤5 files
    };

    return {
      ...defaultConfig,
      ...this.reviewConfig.batchProcessing,
    };
  }

  /**
   * Determine if batch processing should be used
   */
  private shouldUseBatchProcessing(
    context: UnifiedContext,
    batchConfig: BatchProcessingConfig,
  ): boolean {
    if (!batchConfig.enabled) {
      logger.debug("Batch processing disabled in config");
      return false;
    }

    const fileCount = context.diffStrategy.fileCount;
    
    if (fileCount <= batchConfig.singleRequestThreshold) {
      logger.debug(
        `File count (${fileCount}) ≤ threshold (${batchConfig.singleRequestThreshold}), using single request`,
      );
      return false;
    }

    // Force batch processing for file-by-file strategy with many files
    if (context.diffStrategy.strategy === "file-by-file" && fileCount > 10) {
      logger.debug(
        `File-by-file strategy with ${fileCount} files, forcing batch processing`,
      );
      return true;
    }

    logger.debug(
      `File count (${fileCount}) > threshold (${batchConfig.singleRequestThreshold}), using batch processing`,
    );
    return true;
  }

  /**
   * Main batch processing method
   */
  private async reviewWithBatchProcessing(
    context: UnifiedContext,
    options: ReviewOptions,
    batchConfig: BatchProcessingConfig,
  ): Promise<{ violations: Violation[]; batchResults: BatchResult[] }> {
    const startTime = Date.now();

    try {
      // Step 1: Prioritize and organize files
      const prioritizedFiles = await this.prioritizeFiles(context, batchConfig);
      logger.info(
        `📋 Prioritized ${prioritizedFiles.length} files: ${prioritizedFiles.filter(f => f.priority === "high").length} high, ${prioritizedFiles.filter(f => f.priority === "medium").length} medium, ${prioritizedFiles.filter(f => f.priority === "low").length} low priority`,
      );

      // Step 2: Create batches
      const batches = this.createBatches(prioritizedFiles, batchConfig);
      logger.info(
        `📦 Created ${batches.length} batches (max ${batchConfig.maxFilesPerBatch} files per batch)`,
      );

      // Step 3: Process batches
      const batchResults: BatchResult[] = [];
      const allViolations: Violation[] = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.info(
          `🔄 Processing batch ${i + 1}/${batches.length} (${batch.files.length} files, ${batch.priority} priority)`,
        );

        try {
          const batchResult = await this.processBatch(batch, context, options);
          batchResults.push(batchResult);
          allViolations.push(...batchResult.violations);

          logger.info(
            `✅ Batch ${i + 1} completed: ${batchResult.violations.length} violations found in ${Math.round(batchResult.processingTime / 1000)}s`,
          );

          // Add delay between batches if configured
          if (i < batches.length - 1 && batchConfig.batchDelayMs > 0) {
            logger.debug(`⏳ Waiting ${batchConfig.batchDelayMs}ms before next batch`);
            await new Promise(resolve => setTimeout(resolve, batchConfig.batchDelayMs));
          }
        } catch (error) {
          logger.error(
            `❌ Batch ${i + 1} failed: ${(error as Error).message}`,
          );
          
          // Record failed batch
          batchResults.push({
            batchIndex: i,
            files: batch.files,
            violations: [],
            processingTime: Date.now() - startTime,
            error: (error as Error).message,
          });
        }
      }

      const totalTime = Date.now() - startTime;
      const avgBatchSize = batches.reduce((sum, b) => sum + b.files.length, 0) / batches.length;

      logger.success(
        `🎯 Batch processing completed: ${allViolations.length} total violations from ${batches.length} batches in ${Math.round(totalTime / 1000)}s (avg ${avgBatchSize.toFixed(1)} files/batch)`,
      );

      return { violations: allViolations, batchResults };
    } catch (error) {
      logger.error(`Batch processing failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Prioritize files based on security importance and file type
   */
  private async prioritizeFiles(
    context: UnifiedContext,
    batchConfig: BatchProcessingConfig,
  ): Promise<PrioritizedFile[]> {
    const files = context.pr.fileChanges || [];
    const prioritizedFiles: PrioritizedFile[] = [];

    for (const filePath of files) {
      const priority = this.calculateFilePriority(filePath, batchConfig);
      const estimatedTokens = await this.estimateFileTokens(filePath, context);
      
      prioritizedFiles.push({
        path: filePath,
        priority,
        estimatedTokens,
        diff: context.fileDiffs?.get(filePath),
      });
    }

    // Sort by priority (high -> medium -> low) then by estimated tokens (smaller first)
    prioritizedFiles.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      
      return a.estimatedTokens - b.estimatedTokens;
    });

    return prioritizedFiles;
  }

  /**
   * Calculate file priority based on path and content
   */
  private calculateFilePriority(filePath: string, batchConfig: BatchProcessingConfig): FilePriority {
    if (!batchConfig.prioritizeSecurityFiles) {
      return "medium"; // All files same priority if not prioritizing
    }

    const path = filePath.toLowerCase();
    
    // High priority: Security-sensitive files
    const highPriorityPatterns = [
      /auth/i, /login/i, /password/i, /token/i, /jwt/i, /oauth/i,
      /crypto/i, /encrypt/i, /decrypt/i, /hash/i, /security/i,
      /payment/i, /billing/i, /transaction/i, /money/i, /wallet/i,
      /admin/i, /privilege/i, /permission/i, /role/i, /access/i,
      /config/i, /env/i, /secret/i, /key/i, /credential/i,
      /api/i, /endpoint/i, /route/i, /controller/i, /middleware/i,
    ];

    if (highPriorityPatterns.some(pattern => pattern.test(path))) {
      return "high";
    }

    // Low priority: Documentation, tests, config files
    const lowPriorityPatterns = [
      /\.md$/i, /\.txt$/i, /readme/i, /changelog/i, /license/i,
      /test/i, /spec/i, /\.test\./i, /\.spec\./i, /__tests__/i,
      /\.json$/i, /\.yaml$/i, /\.yml$/i, /\.toml$/i, /\.ini$/i,
      /\.lock$/i, /package-lock/i, /yarn\.lock/i, /pnpm-lock/i,
      /\.gitignore/i, /\.eslint/i, /\.prettier/i, /tsconfig/i,
      /\.svg$/i, /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.gif$/i,
    ];

    if (lowPriorityPatterns.some(pattern => pattern.test(path))) {
      return "low";
    }

    // Medium priority: Everything else
    return "medium";
  }

  /**
   * Estimate token count for a file
   */
  private async estimateFileTokens(filePath: string, context: UnifiedContext): Promise<number> {
    try {
      let content = "";
      
      if (context.fileDiffs?.has(filePath)) {
        content = context.fileDiffs.get(filePath) || "";
      } else if (context.prDiff) {
        // Extract file content from whole diff
        const diffLines = context.prDiff.diff.split("\n");
        let inFile = false;
        
        for (const line of diffLines) {
          if (line.startsWith("diff --git") && line.includes(filePath)) {
            inFile = true;
            continue;
          }
          if (inFile && line.startsWith("diff --git")) {
            break;
          }
          if (inFile) {
            content += line + "\n";
          }
        }
      }

      // Rough estimation: ~4 characters per token
      const estimatedTokens = Math.ceil(content.length / 4);
      
      // Add base overhead for context and prompts
      const baseOverhead = 1000;
      
      return estimatedTokens + baseOverhead;
    } catch (error) {
      logger.debug(`Error estimating tokens for ${filePath}: ${(error as Error).message}`);
      return 2000; // Default estimate
    }
  }

  /**
   * Create batches from prioritized files
   */
  private createBatches(
    prioritizedFiles: PrioritizedFile[],
    batchConfig: BatchProcessingConfig,
  ): FileBatch[] {
    const batches: FileBatch[] = [];
    const maxTokensPerBatch = this.getSafeTokenLimit() * 0.7; // Use 70% of limit for safety
    
    let currentBatch: FileBatch = {
      files: [],
      priority: "medium",
      estimatedTokens: 0,
      batchIndex: 0,
    };

    for (const file of prioritizedFiles) {
      const wouldExceedTokens = currentBatch.estimatedTokens + file.estimatedTokens > maxTokensPerBatch;
      const wouldExceedFileCount = currentBatch.files.length >= batchConfig.maxFilesPerBatch;
      
      if ((wouldExceedTokens || wouldExceedFileCount) && currentBatch.files.length > 0) {
        // Finalize current batch
        batches.push(currentBatch);
        
        // Start new batch
        currentBatch = {
          files: [],
          priority: file.priority,
          estimatedTokens: 0,
          batchIndex: batches.length,
        };
      }

      // Add file to current batch
      currentBatch.files.push(file.path);
      currentBatch.estimatedTokens += file.estimatedTokens;
      
      // Update batch priority to highest priority file in batch
      if (file.priority === "high" || 
          (file.priority === "medium" && currentBatch.priority === "low")) {
        currentBatch.priority = file.priority;
      }
    }

    // Add final batch if it has files
    if (currentBatch.files.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Process a single batch of files
   */
  private async processBatch(
    batch: FileBatch,
    context: UnifiedContext,
    options: ReviewOptions,
  ): Promise<BatchResult> {
    const startTime = Date.now();

    try {
      // Create batch-specific context
      const batchContext = this.createBatchContext(batch, context);
      
      // Build batch-specific prompt
      const batchPrompt = this.buildBatchAnalysisPrompt(batchContext, batch, options);
      
      // Analyze with AI
      const violations = await this.analyzeWithAI(batchPrompt, batchContext);
      
      const processingTime = Date.now() - startTime;

      return {
        batchIndex: batch.batchIndex,
        files: batch.files,
        violations,
        processingTime,
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      return {
        batchIndex: batch.batchIndex,
        files: batch.files,
        violations: [],
        processingTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Create context for a specific batch
   */
  private createBatchContext(batch: FileBatch, originalContext: UnifiedContext): UnifiedContext {
    // Create a filtered context containing only the files in this batch
    const batchFileDiffs = new Map<string, string>();
    
    if (originalContext.fileDiffs) {
      for (const filePath of batch.files) {
        const diff = originalContext.fileDiffs.get(filePath);
        if (diff) {
          batchFileDiffs.set(filePath, diff);
        }
      }
    }

    return {
      ...originalContext,
      fileDiffs: batchFileDiffs,
      diffStrategy: {
        ...originalContext.diffStrategy,
        fileCount: batch.files.length,
        strategy: "file-by-file", // Always use file-by-file for batches
        reason: `Batch processing ${batch.files.length} files`,
      },
      pr: {
        ...originalContext.pr,
        fileChanges: batch.files,
      },
    };
  }

  /**
   * Build analysis prompt for a specific batch
   */
  private buildBatchAnalysisPrompt(
    batchContext: UnifiedContext,
    batch: FileBatch,
    options: ReviewOptions,
  ): string {
    const diffContent = this.extractDiffContent(batchContext);

    return `Conduct a focused security and quality analysis of this batch of ${batch.files.length} files (${batch.priority} priority).

## BATCH CONTEXT:
**Batch**: ${batch.batchIndex + 1}
**Files**: ${batch.files.length}
**Priority**: ${batch.priority}
**Files in batch**: ${batch.files.join(", ")}

## PR CONTEXT:
**Title**: ${batchContext.pr.title}
**Author**: ${batchContext.pr.author}
**Repository**: ${batchContext.identifier.workspace}/${batchContext.identifier.repository}

## PROJECT CONTEXT:
${batchContext.projectContext.memoryBank.projectContext || batchContext.projectContext.memoryBank.summary}

## PROJECT RULES & STANDARDS:
${batchContext.projectContext.clinerules || "No specific rules defined"}

## BATCH CODE CHANGES:
${diffContent}

## CRITICAL INSTRUCTIONS FOR CODE SNIPPETS:

When you identify an issue in the code, you MUST:
1. Copy the EXACT line from the diff above, including the diff prefix (+, -, or space at the beginning)
2. Do NOT modify, clean, or reformat the line
3. Include the complete line as it appears in the diff
4. If the issue spans multiple lines, choose the most relevant single line

## ANALYSIS REQUIREMENTS:

${this.getAnalysisRequirements()}

### 📋 OUTPUT FORMAT
Return ONLY valid JSON:
{
  "violations": [
    {
      "type": "inline",
      "file": "exact/file/path.ext",
      "code_snippet": "EXACT line from diff INCLUDING the +/- prefix",
      "search_context": {
        "before": ["line before from diff with prefix"],
        "after": ["line after from diff with prefix"]
      },
      "severity": "CRITICAL|MAJOR|MINOR|SUGGESTION",
      "category": "security|performance|maintainability|functionality",
      "issue": "Brief issue title",
      "message": "Detailed explanation",
      "impact": "Potential impact description",
      "suggestion": "Clean, executable code fix (no diff symbols)"
    }
  ],
  "summary": "Batch analysis summary",
  "positiveObservations": ["Good practices found"],
  "statistics": {
    "filesReviewed": ${batch.files.length},
    "totalIssues": 0,
    "criticalCount": 0,
    "majorCount": 0,
    "minorCount": 0,
    "suggestionCount": 0
  }
}`;
  }

  /**
   * Utility methods
   */
  private parseAIResponse(result: any): any {
    try {
      const responseText =
        result.content || result.text || result.response || "";

      if (!responseText) {
        return { violations: [] };
      }

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return { violations: [] };
    } catch (error) {
      logger.debug(`Failed to parse AI response: ${(error as Error).message}`);
      return { violations: [] };
    }
  }

  /**
   * Extract line information for comment from context
   */
  private extractLineInfoForComment(
    violation: Violation,
    context: UnifiedContext,
  ): { lineNumber: number; lineType: "ADDED" | "REMOVED" | "CONTEXT" } | null {
    if (!violation.file || !violation.code_snippet) {return null;}

    try {
      // Get the diff for this specific file
      let fileDiff: string | undefined;

      if (context.diffStrategy.strategy === "whole" && context.prDiff) {
        // Extract file diff from whole diff
        const diffLines = context.prDiff.diff.split("\n");
        let fileStartIndex = -1;

        // Create all possible path variations for matching
        const filePathVariations = this.generatePathVariations(violation.file);

        for (let i = 0; i < diffLines.length; i++) {
          const line = diffLines[i];
          if (line.startsWith("diff --git")) {
            // Check if any variation matches
            for (const pathVariation of filePathVariations) {
              if (line.includes(pathVariation)) {
                fileStartIndex = i;
                break;
              }
            }
            if (fileStartIndex >= 0) {break;}
          }
        }

        if (fileStartIndex >= 0) {
          const nextFileIndex = diffLines.findIndex(
            (line, idx) =>
              idx > fileStartIndex && line.startsWith("diff --git"),
          );

          fileDiff = diffLines
            .slice(
              fileStartIndex,
              nextFileIndex > 0 ? nextFileIndex : diffLines.length,
            )
            .join("\n");
        }
      } else if (
        context.diffStrategy.strategy === "file-by-file" &&
        context.fileDiffs
      ) {
        // Try all possible path variations
        const pathVariations = this.generatePathVariations(violation.file);

        for (const path of pathVariations) {
          fileDiff = context.fileDiffs.get(path);
          if (fileDiff) {
            logger.debug(
              `Found diff for ${violation.file} using variation: ${path}`,
            );
            break;
          }
        }

        // If still not found, try to find by partial match
        if (!fileDiff) {
          for (const [key, value] of context.fileDiffs.entries()) {
            if (key.endsWith(violation.file) || violation.file.endsWith(key)) {
              fileDiff = value;
              logger.debug(
                `Found diff for ${violation.file} using partial match: ${key}`,
              );
              break;
            }
          }
        }
      }

      if (fileDiff) {
        const lineInfo = this.extractLineNumberFromDiff(
          fileDiff,
          violation.code_snippet,
        );
        if (lineInfo) {
          logger.debug(
            `Extracted line info for ${violation.file}: line ${lineInfo.lineNumber}, type ${lineInfo.lineType}`,
          );
        }
        return lineInfo;
      } else {
        logger.debug(`No diff found for file: ${violation.file}`);
      }
    } catch (error) {
      logger.debug(`Error extracting line info: ${(error as Error).message}`);
    }

    return null;
  }

  /**
   * Detect programming language from file extension
   */
  private detectLanguageFromFile(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase();
    
    const languageMap: Record<string, string> = {
      js: "javascript",
      jsx: "javascript",
      ts: "typescript",
      tsx: "typescript",
      py: "python",
      java: "java",
      cpp: "cpp",
      c: "c",
      cs: "csharp",
      php: "php",
      rb: "ruby",
      go: "go",
      rs: "rust",
      res: "rescript",
      kt: "kotlin",
      swift: "swift",
      scala: "scala",
      sh: "bash",
      sql: "sql",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      xml: "xml",
      html: "html",
      css: "css",
      scss: "scss",
      sass: "sass",
      md: "markdown",
    };

    return languageMap[ext || ""] || "text";
  }

  /**
   * Format existing issues for AI to avoid duplicates
   */
  private formatExistingIssuesForAI(comments: any[]): string {
    if (!comments || comments.length === 0) {
      return "No existing issues reported on this PR.";
    }

    // Filter to only Yama comments
    const yamaComments = comments.filter(comment => this.isYamaComment(comment));

    if (yamaComments.length === 0) {
      return "No existing Yama-generated issues found. This is a fresh analysis.";
    }

    // Extract issues from Yama comments with improved parsing
    const existingIssues = this.extractYamaIssuesFromComments(yamaComments);

    if (existingIssues.length === 0) {
      return "Found Yama comments but could not extract specific issues. Proceed with caution to avoid duplicates.";
    }

    // Clean and validate extracted issues
    const cleanedIssues = this.cleanAndValidateExtractedIssues(existingIssues);

    if (cleanedIssues.length === 0) {
      return "Found Yama comments but extracted issues were malformed. Proceed with caution to avoid duplicates.";
    }

    // Group issues by category for better AI understanding
    const issuesByCategory = this.groupIssuesByCategory(cleanedIssues);

    // Format for AI consumption with clear, clean structure
    let summary = `Found ${cleanedIssues.length} existing issues that have already been reported. DO NOT report similar issues:\n\n`;
    
    // Add category-based summary with clean formatting
    summary += `## ISSUES BY CATEGORY:\n`;
    Object.entries(issuesByCategory).forEach(([category, issues]) => {
      summary += `### ${category.toUpperCase()} (${issues.length} issues):\n`;
      issues.forEach((issue, index) => {
        // Clean title and ensure it's meaningful
        const cleanTitle = this.cleanIssueTitle(issue.title);
        if (!cleanTitle || cleanTitle.length < 5) {
          return; // Skip malformed issues
        }

        summary += `${index + 1}. **${cleanTitle}**`;
        if (issue.file && issue.file !== 'general' && !issue.file.includes('╭')) {
          summary += ` in \`${issue.file}\``;
        }
        summary += ` (${issue.severity}) - ${category}\n`;
        
        if (issue.description && issue.description !== cleanTitle) {
          const cleanDescription = this.cleanIssueDescription(issue.description);
          if (cleanDescription && cleanDescription.length > 10) {
            summary += `   Description: ${cleanDescription}\n`;
          }
        }
        
        if (issue.codeSnippet) {
          const cleanCode = issue.codeSnippet
            .replace(/[╭╮╯╰─│┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
            .replace(/^\s*[+\-\s]/, '') // Remove diff prefixes
            .trim();
          if (cleanCode && cleanCode.length > 5) {
            summary += `   Code: \`${cleanCode.substring(0, 80)}${cleanCode.length > 80 ? '...' : ''}\`\n`;
          }
        }
      });
      summary += '\n';
    });

    summary += `**CRITICAL: Do NOT report any violations that are semantically similar to the above existing issues. Focus on genuinely new problems.**\n`;

    return summary;
  }

  /**
   * Extract structured issues from Yama comments with improved parsing
   */
  private extractYamaIssuesFromComments(yamaComments: any[]): Array<{
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  }> {
    const issues: Array<{
      title: string;
      description: string;
      file?: string;
      severity: string;
      category: string;
      codeSnippet?: string;
    }> = [];

    for (const comment of yamaComments) {
      try {
        const text = comment.text || comment.content || '';
        
        // Skip if text contains malformed Unicode artifacts
        if (this.containsUnicodeArtifacts(text)) {
          logger.debug("Skipping comment with Unicode artifacts");
          continue;
        }

        // Try multiple parsing strategies
        const extractedIssue = this.parseYamaCommentMultiStrategy(text, comment);
        
        if (extractedIssue) {
          issues.push(extractedIssue);
        }
      } catch (error) {
        logger.debug(`Error parsing Yama comment: ${(error as Error).message}`);
        continue;
      }
    }

    logger.debug(`Extracted ${issues.length} issues from ${yamaComments.length} Yama comments`);
    return issues;
  }

  /**
   * Group issues by category for better AI understanding
   */
  private groupIssuesByCategory(issues: Array<{
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  }>): Record<string, Array<{
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  }>> {
    const grouped: Record<string, Array<{
      title: string;
      description: string;
      file?: string;
      severity: string;
      category: string;
      codeSnippet?: string;
    }>> = {};

    for (const issue of issues) {
      const category = issue.category || 'general';
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(issue);
    }

    return grouped;
  }

  /**
   * Check if text contains Unicode artifacts that indicate parsing issues
   */
  private containsUnicodeArtifacts(text: string): boolean {
    // Check for box drawing characters and other artifacts
    const unicodeArtifacts = /[╭╮╯╰─│┌┐└┘├┤┬┴┼]/;
    return unicodeArtifacts.test(text);
  }

  /**
   * Parse Yama comment using multiple strategies
   */
  private parseYamaCommentMultiStrategy(text: string, comment: any): {
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  } | null {
    // Strategy 1: Use BitbucketProvider's analyzeComment method
    try {
      const analysis = this.bitbucketProvider.analyzeComment(comment);
      
      if (analysis.issueDescription && analysis.violationType) {
        return {
          title: analysis.issueDescription,
          description: analysis.issueDescription,
          file: analysis.filePath,
          severity: this.extractSeverityFromComment(text),
          category: analysis.violationType,
          codeSnippet: this.extractCodeSnippetFromComment(text),
        };
      }
    } catch (error) {
      // Continue to next strategy
    }

    // Strategy 2: Parse structured Yama comment format
    const structuredIssue = this.parseStructuredYamaComment(text);
    if (structuredIssue) {
      return structuredIssue;
    }

    // Strategy 3: Extract from markdown headers
    const headerIssue = this.parseMarkdownHeaderIssue(text);
    if (headerIssue) {
      return headerIssue;
    }

    // Strategy 4: Simple pattern matching fallback
    return this.parseSimplePatternIssue(text);
  }

  /**
   * Parse structured Yama comment format
   */
  private parseStructuredYamaComment(text: string): {
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  } | null {
    // Look for the standard Yama format
    const issueMatch = text.match(/\*\*Issue\*\*:\s*([^\n]+)/i);
    const categoryMatch = text.match(/\*\*Category\*\*:\s*([^\n]+)/i);
    
    if (issueMatch) {
      return {
        title: issueMatch[1].trim(),
        description: issueMatch[1].trim(),
        severity: this.extractSeverityFromComment(text),
        category: categoryMatch ? this.cleanCategoryName(categoryMatch[1].trim()) : 'general',
        codeSnippet: this.extractCodeSnippetFromComment(text),
      };
    }

    return null;
  }

  /**
   * Parse markdown header-based issue format
   */
  private parseMarkdownHeaderIssue(text: string): {
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  } | null {
    // Look for markdown headers with issue titles
    const headerMatch = text.match(/\*\*([^*]+)\*\*/);
    
    if (headerMatch) {
      const title = headerMatch[1].trim();
      
      // Skip if title contains artifacts
      if (this.containsUnicodeArtifacts(title) || title.length < 5) {
        return null;
      }

      return {
        title,
        description: title,
        severity: this.extractSeverityFromComment(text),
        category: this.inferCategoryFromText(text),
        codeSnippet: this.extractCodeSnippetFromComment(text),
      };
    }

    return null;
  }

  /**
   * Simple pattern matching fallback
   */
  private parseSimplePatternIssue(text: string): {
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  } | null {
    // Extract first meaningful line as title
    const lines = text.split('\n').filter(line => {
      const trimmed = line.trim();
      return trimmed && 
             !trimmed.includes('🛡️') && 
             !trimmed.includes('---') &&
             !trimmed.includes('**Category**') &&
             !this.containsUnicodeArtifacts(trimmed) &&
             trimmed.length > 10;
    });
    
    if (lines.length > 0) {
      const title = lines[0].trim().replace(/^\*+|\*+$/g, ''); // Remove markdown asterisks
      
      return {
        title,
        description: title,
        severity: this.extractSeverityFromComment(text),
        category: this.inferCategoryFromText(text),
        codeSnippet: this.extractCodeSnippetFromComment(text),
      };
    }

    return null;
  }

  /**
   * Clean and validate extracted issues
   */
  private cleanAndValidateExtractedIssues(issues: Array<{
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  }>): Array<{
    title: string;
    description: string;
    file?: string;
    severity: string;
    category: string;
    codeSnippet?: string;
  }> {
    return issues.filter(issue => {
      // Filter out issues with malformed titles
      if (!issue.title || issue.title.length < 5) {
        return false;
      }

      // Filter out issues with Unicode artifacts
      if (this.containsUnicodeArtifacts(issue.title)) {
        return false;
      }

      // Filter out issues with generic/meaningless titles
      const genericTitles = ['issue', 'problem', 'error', 'warning', 'suggestion'];
      if (genericTitles.includes(issue.title.toLowerCase())) {
        return false;
      }

      return true;
    }).map(issue => ({
      ...issue,
      title: this.cleanIssueTitle(issue.title),
      description: this.cleanIssueDescription(issue.description),
      category: this.cleanCategoryName(issue.category),
    }));
  }

  /**
   * Clean issue title by removing artifacts and formatting
   */
  private cleanIssueTitle(title: string): string {
    return title
      .replace(/[╭╮╯╰─│┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
      .replace(/^\*+|\*+$/g, '') // Remove markdown asterisks
      .replace(/^#+\s*/, '') // Remove markdown headers
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Clean issue description
   */
  private cleanIssueDescription(description: string): string {
    return description
      .replace(/[╭╮╯╰─│┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Clean category name
   */
  private cleanCategoryName(category: string): string {
    return category
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '') // Keep only alphanumeric and underscore
      .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
      .trim() || 'general';
  }


  /**
   * Infer category from text content
   */
  private inferCategoryFromText(text: string): string {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('security') || lowerText.includes('🔒') || 
        lowerText.includes('vulnerability') || lowerText.includes('injection')) {
      return 'security';
    }
    
    if (lowerText.includes('performance') || lowerText.includes('⚡') ||
        lowerText.includes('optimization') || lowerText.includes('slow')) {
      return 'performance';
    }
    
    if (lowerText.includes('maintainability') || lowerText.includes('🏗️') ||
        lowerText.includes('refactor') || lowerText.includes('clean')) {
      return 'maintainability';
    }
    
    if (lowerText.includes('functionality') || lowerText.includes('⚙️') ||
        lowerText.includes('bug') || lowerText.includes('error')) {
      return 'functionality';
    }
    
    return 'general';
  }

  /**
   * Extract severity from comment text
   */
  private extractSeverityFromComment(text: string): string {
    const severityMatch = text.match(/(CRITICAL|MAJOR|MINOR|SUGGESTION)/i);
    return severityMatch ? severityMatch[1].toUpperCase() : 'UNKNOWN';
  }

  /**
   * Extract code snippet from comment text
   */
  private extractCodeSnippetFromComment(text: string): string | undefined {
    // Look for code blocks in markdown
    const codeBlockMatch = text.match(/```[\s\S]*?\n([\s\S]*?)\n```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1]
        .replace(/[╭╮╯╰─│┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
        .replace(/^\s*[+\-\s]/, '') // Remove diff prefixes
        .trim();
    }

    // Look for inline code
    const inlineCodeMatch = text.match(/`([^`]+)`/);
    if (inlineCodeMatch) {
      return inlineCodeMatch[1]
        .replace(/[╭╮╯╰─│┌┐└┘├┤┬┴┼]/g, '') // Remove box drawing characters
        .replace(/^\s*[+\-\s]/, '') // Remove diff prefixes
        .trim();
    }

    return undefined;
  }

  /**
   * Generate all possible path variations for a file
   */
  private generatePathVariations(filePath: string): string[] {
    const variations = new Set<string>();

    // Add original path
    variations.add(filePath);

    // Add with a/ and b/ prefixes
    variations.add(`a/${filePath}`);
    variations.add(`b/${filePath}`);

    // Handle nested paths
    if (filePath.includes("/")) {
      const parts = filePath.split("/");

      // Try removing first directory
      if (parts.length > 1) {
        variations.add(parts.slice(1).join("/"));
      }

      // Try removing first two directories
      if (parts.length > 2) {
        variations.add(parts.slice(2).join("/"));
      }

      // Try with just the filename
      variations.add(parts[parts.length - 1]);
    }

    // Remove app/ prefix variations
    if (filePath.startsWith("app/")) {
      const withoutApp = filePath.substring(4);
      variations.add(withoutApp);
      variations.add(`a/${withoutApp}`);
      variations.add(`b/${withoutApp}`);
    }

    // Add app/ prefix variations
    if (!filePath.startsWith("app/")) {
      variations.add(`app/${filePath}`);
      variations.add(`a/app/${filePath}`);
      variations.add(`b/app/${filePath}`);
    }

    return Array.from(variations);
  }

  // ============================================================================
  // AI DUPLICATE DETECTION METHODS
  // ============================================================================

  /**
   * Filter duplicate violations using AI-powered semantic analysis
   */
  private async filterDuplicatesWithAI(
    newViolations: Violation[],
    context: UnifiedContext,
  ): Promise<Violation[]> {
    if (newViolations.length === 0) {
      return newViolations;
    }

    try {
      // Log input data for debugging
      console.log("New Violations Input -----> ", newViolations);

      // Step 1: Filter duplicates against existing comments
      const existingComments = context.pr.comments || [];
      
      // Log existing comments for debugging
      console.log("Existing Comments -----> ", existingComments);
      
      logger.info(`🔍 Found ${existingComments.length} existing comments on PR #${context.pr.id}`);
      
      let uniqueVsExisting = newViolations;
      
      if (existingComments.length > 0) {
        // Filter to only Yama comments for duplicate detection
        const yamaComments = existingComments.filter(comment => 
          this.isYamaComment(comment)
        );

        logger.info(`🤖 Identified ${yamaComments.length} Yama comments for duplicate detection`);
        
        if (yamaComments.length > 0) {
          // Log details about existing Yama comments
          logger.debug("📋 Existing Yama comments:");
          yamaComments.forEach((comment, index) => {
            const analysis = this.bitbucketProvider.analyzeComment(comment);
            logger.debug(`   ${index + 1}. ${analysis.issueDescription} (${analysis.violationType}) in ${analysis.filePath || 'general'}`);
          });

          logger.info(`🔄 Checking ${newViolations.length} new violations against existing comments...`);

          // Use AI to detect duplicates against existing comments
          const deduplicationPrompt = this.buildDuplicateDetectionPrompt(newViolations, yamaComments);
          
          // Log duplicate detection input for debugging
          console.log("Duplicate Detection Prompt -----> ", deduplicationPrompt);
          console.log("Existing Comments for AI -----> ", yamaComments);
          console.log("New Violations for AI -----> ", newViolations);
          
          const result = await this.analyzeWithAI(deduplicationPrompt, context);

          // Log duplicate detection AI response for debugging
          console.log("Duplicate Detection AI Response -----> ", result);

          // Parse the duplicate detection result
          uniqueVsExisting = this.parseDuplicateDetectionResult(result, newViolations);

          // Log unique violations after existing filter for debugging
          console.log("Unique Violations After Existing Filter -----> ", uniqueVsExisting);

          const duplicatesVsExisting = newViolations.length - uniqueVsExisting.length;
          
          if (duplicatesVsExisting > 0) {
            logger.info(`🚫 Filtered ${duplicatesVsExisting} violations duplicate with existing comments`);
          }
        }
      }

      // Step 2: Filter intra-batch duplicates (new violations against each other)
      logger.info(`🔄 Checking for duplicates within ${uniqueVsExisting.length} new violations...`);
      
      const finalUniqueViolations = await this.filterIntraBatchDuplicates(uniqueVsExisting, context);
      
      // Log final unique violations for debugging
      console.log("Final Unique Violations -----> ", finalUniqueViolations);
      
      const intraBatchDuplicates = uniqueVsExisting.length - finalUniqueViolations.length;
      
      if (intraBatchDuplicates > 0) {
        logger.info(`🚫 Filtered ${intraBatchDuplicates} intra-batch duplicate violations`);
      }

      // Final summary
      const totalFiltered = newViolations.length - finalUniqueViolations.length;
      
      if (totalFiltered > 0) {
        logger.info(`🚫 Total filtered: ${totalFiltered} duplicate violations`);
        logger.success(`✅ Posting ${finalUniqueViolations.length} unique violations`);
      } else {
        logger.success(`✅ All ${newViolations.length} violations are unique, posting all`);
      }

      return finalUniqueViolations;
    } catch (error) {
      logger.warn(`⚠️ Duplicate detection failed, proceeding with all violations: ${(error as Error).message}`);
      return newViolations;
    }
  }

  /**
   * Check if a comment is generated by Yama
   */
  private isYamaComment(comment: any): boolean {
    const text = comment.text || comment.content || '';
    const author = comment.author?.name || comment.author?.displayName || '';
    
    return text.includes('🛡️ Automated review by **Yama**') ||
           text.includes('Powered by Yama AI') ||
           author.toLowerCase().includes('yama') ||
           text.includes('⚔️ **YAMA REVIEW REPORT**');
  }

  /**
   * Build AI prompt for duplicate detection
   */
  private buildDuplicateDetectionPrompt(
    newViolations: Violation[],
    existingComments: any[]
  ): string {
    return `TASK: Identify and remove duplicate code review violations.

EXISTING YAMA COMMENTS ON THIS PR:
${JSON.stringify(existingComments, null, 2)}

NEW VIOLATIONS TO CHECK:
${JSON.stringify(newViolations, null, 2)}

DUPLICATE DETECTION RULES:
1. Remove violations that address the same underlying issue as existing Yama comments
2. Consider violations duplicate if they:
   - Target the same security/quality concern in the same file
   - Have the same violation type with similar description
   - Address the same code pattern issue
   - Report the same underlying problem with different wording
3. Keep violations that are genuinely new or different
4. When in doubt, keep the violation (better to have a potential duplicate than miss a real issue)

IMPORTANT: Only compare against Yama-generated comments, not human comments.

Return ONLY the non-duplicate violations in this JSON format:
{
  "uniqueViolations": [
    /* Only violations that are NOT duplicates */
  ],
  "duplicatesFound": [
    {
      "violationIndex": 0,
      "matchedCommentId": "comment-123",
      "reason": "Same SQL injection vulnerability already reported",
      "confidence": 0.95
    }
  ]
}`;
  }

  /**
   * Parse duplicate detection result from AI response
   */
  private parseDuplicateDetectionResult(
    aiResult: any,
    originalViolations: Violation[]
  ): Violation[] {
    try {
      // The AI result should already be parsed by analyzeWithAI
      if (aiResult && aiResult.uniqueViolations && Array.isArray(aiResult.uniqueViolations)) {
        return aiResult.uniqueViolations;
      }

      // Fallback: if AI response doesn't have the expected format, return all violations
      logger.debug("AI duplicate detection response format unexpected, returning all violations");
      return originalViolations;
    } catch (error) {
      logger.debug(`Error parsing duplicate detection result: ${(error as Error).message}`);
      return originalViolations;
    }
  }

  /**
   * Filter intra-batch duplicates (new violations against each other)
   */
  private async filterIntraBatchDuplicates(
    violations: Violation[],
    context: UnifiedContext,
  ): Promise<Violation[]> {
    if (violations.length <= 1) {
      return violations; // No duplicates possible with 0 or 1 violations
    }

    try {
      // Log violations for intra-batch analysis for debugging
      console.log("Violations for Intra-Batch Analysis -----> ", violations);

      // Group violations by issue pattern for efficient duplicate detection
      const violationGroups = this.groupViolationsByPattern(violations);
      
      // Log violation groups for debugging
      console.log("Violation Groups -----> ", violationGroups);
      
      // If all violations are in different groups, no duplicates possible
      if (Object.keys(violationGroups).length === violations.length) {
        logger.debug("All violations have unique patterns, no intra-batch duplicates");
        return violations;
      }

      // Find groups with multiple violations (potential duplicates)
      const duplicateGroups = Object.entries(violationGroups).filter(
        ([_, groupViolations]) => groupViolations.length > 1
      );

      if (duplicateGroups.length === 0) {
        logger.debug("No violation groups with multiple items, no intra-batch duplicates");
        return violations;
      }

      logger.debug(`Found ${duplicateGroups.length} groups with potential duplicates`);

      // Use AI to analyze each group for semantic duplicates
      const uniqueViolations: Violation[] = [];
      
      for (const [pattern, groupViolations] of Object.entries(violationGroups)) {
        if (groupViolations.length === 1) {
          // Single violation in group, definitely unique
          uniqueViolations.push(groupViolations[0]);
        } else {
          // Multiple violations in group, use AI to deduplicate
          logger.debug(`Analyzing ${groupViolations.length} violations with pattern: ${pattern}`);
          
          // Log intra-batch prompt input for debugging
          console.log("Intra-Batch Prompt -----> ", this.buildIntraBatchDeduplicationPrompt(groupViolations));
          console.log("Group Violations for AI -----> ", groupViolations);
          
          const deduplicatedGroup = await this.deduplicateViolationGroup(
            groupViolations,
            context
          );
          
          uniqueViolations.push(...deduplicatedGroup);
          
          const filtered = groupViolations.length - deduplicatedGroup.length;
          if (filtered > 0) {
            logger.debug(`   Filtered ${filtered} duplicates from group: ${pattern}`);
          }
        }
      }

      // Log unique violations after intra-batch filter for debugging
      console.log("Unique Violations After Intra-Batch Filter -----> ", uniqueViolations);

      return uniqueViolations;
    } catch (error) {
      logger.warn(`Intra-batch duplicate detection failed: ${(error as Error).message}`);
      return violations;
    }
  }

  /**
   * Group violations by issue pattern for duplicate detection
   */
  private groupViolationsByPattern(violations: Violation[]): Record<string, Violation[]> {
    const groups: Record<string, Violation[]> = {};

    for (const violation of violations) {
      // Create a pattern key based on issue type and category
      const pattern = this.createViolationPattern(violation);
      
      if (!groups[pattern]) {
        groups[pattern] = [];
      }
      
      groups[pattern].push(violation);
    }

    return groups;
  }

  /**
   * Create a pattern key for violation grouping
   */
  private createViolationPattern(violation: Violation): string {
    // More aggressive normalization for better duplicate detection
    const normalizedIssue = violation.issue
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\b(introduces?|causes?|leads?\s+to|results?\s+in|creates?)\b/g, '') // Remove action words
      .replace(/\b(data|code|security|integrity|risk|issue|problem|vulnerability)\b/g, '') // Remove common words
      .replace(/\s+/g, ' ') // Normalize whitespace again
      .trim();

    // Also normalize the message for better pattern matching
    const normalizedMessage = violation.message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100); // First 100 chars for pattern matching

    // Create more comprehensive pattern
    return `${violation.category}:${normalizedIssue}:${normalizedMessage}`;
  }

  /**
   * Deduplicate a group of violations using AI
   */
  private async deduplicateViolationGroup(
    groupViolations: Violation[],
    context: UnifiedContext,
  ): Promise<Violation[]> {
    try {
      // Log group violations input for debugging
      console.log("Group Violations Input -----> ", groupViolations);

      const intraBatchPrompt = this.buildIntraBatchDeduplicationPrompt(groupViolations);
      
      // Use a special AI analysis method for intra-batch deduplication
      const result = await this.analyzeIntraBatchWithAI(intraBatchPrompt, context);

      // Log intra-batch AI response for debugging
      console.log("Intra-Batch AI Response -----> ", result);

      // Parse the result
      if (result && result.uniqueViolations && Array.isArray(result.uniqueViolations)) {
        // Log deduplicated group result for debugging
        console.log("Deduplicated Group Result -----> ", result.uniqueViolations);
        return result.uniqueViolations;
      }

      // Fallback: if AI analysis fails, use simple deduplication
      const simpleResult = this.simpleDeduplicateGroup(groupViolations);
      console.log("Simple Deduplication Fallback Result -----> ", simpleResult);
      return simpleResult;
    } catch (error) {
      logger.debug(`AI group deduplication failed: ${(error as Error).message}`);
      return this.simpleDeduplicateGroup(groupViolations);
    }
  }

  /**
   * Build AI prompt for intra-batch duplicate detection
   */
  private buildIntraBatchDeduplicationPrompt(violations: Violation[]): string {
    return `TASK: Remove duplicate violations within this group of similar issues.

VIOLATIONS TO ANALYZE:
${JSON.stringify(violations, null, 2)}

INTRA-BATCH DEDUPLICATION RULES:
1. These violations all have similar issue patterns
2. Remove violations that report the EXACT same issue in the SAME file at the SAME location
3. Keep violations that are in different files (even if same issue type)
4. Keep violations that are in different locations within the same file
5. For truly identical violations (same file, same location, same issue), keep only the most detailed one
6. When in doubt, keep the violation (better to have a potential duplicate than miss a real issue)

EXAMPLES OF DUPLICATES TO REMOVE:
- Same "SQL injection" issue at line 45 in login.js (keep most detailed)
- Same "hardcoded password" at line 12 in config.js (keep most detailed)

EXAMPLES OF NON-DUPLICATES TO KEEP:
- "SQL injection" in login.js AND "SQL injection" in register.js (different files)
- "SQL injection" at line 45 AND "SQL injection" at line 67 (different locations)

Return ONLY the unique violations in this JSON format:
{
  "uniqueViolations": [
    /* Only violations that are truly unique */
  ],
  "duplicatesRemoved": [
    {
      "reason": "Identical SQL injection issue at same location",
      "keptViolation": "Most detailed version",
      "removedCount": 2
    }
  ]
}`;
  }

  /**
   * Simple deduplication fallback when AI fails
   */
  private simpleDeduplicateGroup(violations: Violation[]): Violation[] {
    const uniqueViolations: Violation[] = [];
    const seen = new Set<string>();

    for (const violation of violations) {
      // Create a simple key for exact duplicate detection
      const key = `${violation.file}:${violation.issue}:${violation.code_snippet}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        uniqueViolations.push(violation);
      }
    }

    const filtered = violations.length - uniqueViolations.length;
    if (filtered > 0) {
      logger.debug(`Simple deduplication removed ${filtered} exact duplicates`);
    }

    return uniqueViolations;
  }

  /**
   * Specialized AI analysis for intra-batch deduplication
   */
  private async analyzeIntraBatchWithAI(
    prompt: string,
    context: UnifiedContext,
  ): Promise<any> {
    try {
      // Initialize NeuroLink if not already done
      if (!this.neurolink) {
        const { NeuroLink } = await import("@juspay/neurolink");
        this.neurolink = new NeuroLink();
      }

      // Use a simpler context for intra-batch analysis
      const aiContext = {
        operation: "intra-batch-deduplication",
        repository: `${context.identifier.workspace}/${context.identifier.repository}`,
        prId: context.identifier.pullRequestId,
      };

      // Get safe token limit
      const safeMaxTokens = this.getSafeTokenLimit();

      const result = await this.neurolink.generate({
        input: { text: prompt },
        systemPrompt: "You are an expert at identifying duplicate code review violations. Focus on semantic similarity and avoid false positives.",
        provider: this.aiConfig.provider || "auto",
        model: this.aiConfig.model || "best",
        temperature: 0.1, // Very low temperature for consistent deduplication
        maxTokens: Math.min(safeMaxTokens, 4000), // Smaller limit for deduplication
        timeout: "5m", // Shorter timeout for deduplication
        context: aiContext,
        enableAnalytics: false,
        enableEvaluation: false,
      });

      // Log intra-batch AI raw response for debugging
      console.log("Intra-Batch AI Raw Response -----> ", result);

      // Parse the response
      const parsedResult = this.parseAIResponse(result);

      // Log intra-batch parsed response for debugging
      console.log("Intra-Batch Parsed Response -----> ", parsedResult);

      return parsedResult;
    } catch (error) {
      logger.debug(`Intra-batch AI analysis failed: ${(error as Error).message}`);
      throw error;
    }
  }
}

export function createCodeReviewer(
  bitbucketProvider: BitbucketProvider,
  aiConfig: AIProviderConfig,
  reviewConfig: CodeReviewConfig,
): CodeReviewer {
  return new CodeReviewer(bitbucketProvider, aiConfig, reviewConfig);
}
