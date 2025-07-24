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
  ProviderError
} from '../types';
import { UnifiedContext } from '../core/ContextGatherer';
import { BitbucketProvider } from '../core/providers/BitbucketProvider';
import { logger } from '../utils/Logger';

export class CodeReviewer {
  private neurolink: any;
  private bitbucketProvider: BitbucketProvider;
  private aiConfig: AIProviderConfig;
  private reviewConfig: CodeReviewConfig;

  constructor(
    bitbucketProvider: BitbucketProvider,
    aiConfig: AIProviderConfig,
    reviewConfig: CodeReviewConfig
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.aiConfig = aiConfig;
    this.reviewConfig = reviewConfig;
  }

  /**
   * Review code using pre-gathered unified context (OPTIMIZED)
   */
  async reviewCodeWithContext(
    context: UnifiedContext,
    options: ReviewOptions
  ): Promise<ReviewResult> {
    const startTime = Date.now();
    
    try {
      logger.phase('🧪 Conducting AI-powered code analysis...');
      logger.info(`Analyzing ${context.diffStrategy.fileCount} files using ${context.diffStrategy.strategy} strategy`);

      const analysisPrompt = this.buildAnalysisPrompt(context, options);
      const violations = await this.analyzeWithAI(analysisPrompt, context);
      const validatedViolations = this.validateViolations(violations, context);

      if (!options.dryRun && validatedViolations.length > 0) {
        await this.postComments(context, validatedViolations, options);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      const result = this.generateReviewResult(validatedViolations, duration, context);

      logger.success(
        `Code review completed in ${duration}s: ${validatedViolations.length} violations found`
      );

      return result;

    } catch (error) {
      logger.error(`Code review failed: ${(error as Error).message}`);
      throw new ProviderError(`Code review failed: ${(error as Error).message}`);
    }
  }

  /**
   * Validate violations to ensure code snippets exist in diff
   */
  private validateViolations(violations: Violation[], context: UnifiedContext): Violation[] {
    const validatedViolations: Violation[] = [];
    const diffContent = this.extractDiffContent(context);

    for (const violation of violations) {
      if (violation.type === 'inline' && violation.code_snippet && violation.file) {
        // Check if the code snippet exists in the diff
        if (diffContent.includes(violation.code_snippet)) {
          validatedViolations.push(violation);
        } else {
          // Try to find a close match and fix the snippet
          const fixedViolation = this.tryFixCodeSnippet(violation, context);
          if (fixedViolation) {
            validatedViolations.push(fixedViolation);
          } else {
            logger.debug(`⚠️ Skipping violation - snippet not found in diff: ${violation.file}`);
            logger.debug(`   Original snippet: "${violation.code_snippet}"`);
          }
        }
      } else {
        // Non-inline violations are always valid
        validatedViolations.push(violation);
      }
    }

    logger.debug(`Validated ${validatedViolations.length} out of ${violations.length} violations`);
    return validatedViolations;
  }

  /**
   * Try to fix code snippet by finding it in the actual diff
   */
  private tryFixCodeSnippet(violation: Violation, context: UnifiedContext): Violation | null {
    if (!violation.file || !violation.code_snippet) return null;

    try {
      // Get the diff for this specific file
      let fileDiff: string | undefined;
      
      if (context.diffStrategy.strategy === 'whole' && context.prDiff) {
        // Extract file diff from whole diff - handle different path formats
        const diffLines = context.prDiff.diff.split('\n');
        let fileStartIndex = -1;
        
        // Generate all possible path variations
        const pathVariations = this.generatePathVariations(violation.file);
        
        // Try to find the file in the diff with various path formats
        for (let i = 0; i < diffLines.length; i++) {
          const line = diffLines[i];
          if (line.startsWith('diff --git') || line.startsWith('Index:')) {
            for (const pathVariation of pathVariations) {
              if (line.includes(pathVariation)) {
                fileStartIndex = i;
                break;
              }
            }
            if (fileStartIndex >= 0) break;
          }
        }
        
        if (fileStartIndex >= 0) {
          const nextFileIndex = diffLines.findIndex((line, idx) => 
            idx > fileStartIndex && (line.startsWith('diff --git') || line.startsWith('Index:'))
          );
          
          fileDiff = diffLines.slice(
            fileStartIndex, 
            nextFileIndex > 0 ? nextFileIndex : diffLines.length
          ).join('\n');
        }
      } else if (context.diffStrategy.strategy === 'file-by-file' && context.fileDiffs) {
        // Try all path variations
        const pathVariations = this.generatePathVariations(violation.file);
        
        for (const path of pathVariations) {
          fileDiff = context.fileDiffs.get(path);
          if (fileDiff) {
            logger.debug(`Found diff for ${violation.file} using variation: ${path}`);
            break;
          }
        }

        // If still not found, try partial matching
        if (!fileDiff) {
          for (const [key, value] of context.fileDiffs.entries()) {
            if (key.endsWith(violation.file) || violation.file.endsWith(key)) {
              fileDiff = value;
              logger.debug(`Found diff for ${violation.file} using partial match: ${key}`);
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
      const lineInfo = this.extractLineNumberFromDiff(fileDiff, violation.code_snippet);
      if (lineInfo) {
        const fixedViolation = { ...violation };
        fixedViolation.line_type = lineInfo.lineType;
        
        // Extract search context from the diff
        const diffLines = fileDiff.split('\n');
        const snippetIndex = diffLines.findIndex(line => line === violation.code_snippet);
        if (snippetIndex > 0 && snippetIndex < diffLines.length - 1) {
          fixedViolation.search_context = {
            before: [diffLines[snippetIndex - 1]],
            after: [diffLines[snippetIndex + 1]]
          };
        }
        
        logger.debug(`✅ Found exact match with line number for ${violation.file}`);
        return fixedViolation;
      }

      // Fallback: Clean the snippet and try fuzzy matching
      const cleanSnippet = violation.code_snippet
        .trim()
        .replace(/^[+\-\s]/, ''); // Remove diff prefix for searching

      // Look for the clean snippet in the diff
      const diffLines = fileDiff.split('\n');
      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];
        const cleanLine = line.replace(/^[+\-\s]/, '').trim();
        
        if (cleanLine.includes(cleanSnippet) || cleanSnippet.includes(cleanLine)) {
          // Found a match! Update the violation with the correct snippet
          const fixedViolation = { ...violation };
          fixedViolation.code_snippet = line; // Use the full line with diff prefix
          
          // Update search context if needed
          if (i > 0 && i < diffLines.length - 1) {
            fixedViolation.search_context = {
              before: [diffLines[i - 1]],
              after: [diffLines[i + 1]]
            };
          }
          
          logger.debug(`✅ Fixed code snippet for ${violation.file} using fuzzy match`);
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
    return this.reviewConfig.systemPrompt || 
      `You are an Expert Security Code Reviewer for enterprise applications. Your role is to:

🔒 SECURITY FIRST: Prioritize security vulnerabilities and data protection
⚡ PERFORMANCE AWARE: Identify performance bottlenecks and optimization opportunities  
🏗️ QUALITY FOCUSED: Ensure maintainable, readable, and robust code
🛡️ ERROR RESILIENT: Verify comprehensive error handling and edge cases

You provide actionable, educational feedback with specific examples and solutions.
Focus on critical issues that could impact production systems.

CRITICAL INSTRUCTION: When identifying issues, you MUST copy the EXACT line from the diff, including the diff prefix (+, -, or space). Do not modify or clean the line in any way.`;
  }

  /**
   * Get analysis requirements from config or defaults
   */
  private getAnalysisRequirements(): string {
    if (this.reviewConfig.focusAreas && this.reviewConfig.focusAreas.length > 0) {
      return this.reviewConfig.focusAreas.map(area => `### ${area}`).join('\n\n');
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
    
    return `Conduct a comprehensive security and quality analysis of this ${context.diffStrategy.strategy === 'whole' ? 'pull request' : 'code changeset'}.

## COMPLETE PR CONTEXT:
**Title**: ${context.pr.title}
**Author**: ${context.pr.author}  
**Description**: ${context.pr.description}
**Files Changed**: ${context.pr.fileChanges?.length || 0}
**Existing Comments**: ${JSON.stringify(context.pr.comments || [], null, 2)}
**Branch**: ${context.identifier.branch}
**Repository**: ${context.identifier.workspace}/${context.identifier.repository}

## DIFF STRATEGY (${context.diffStrategy.strategy.toUpperCase()}):
**Reason**: ${context.diffStrategy.reason}
**File Count**: ${context.diffStrategy.fileCount}
**Estimated Size**: ${context.diffStrategy.estimatedSize}

## COMPLETE PROJECT CONTEXT:
${context.projectContext.memoryBank.projectContext || context.projectContext.memoryBank.summary}

## PROJECT RULES & STANDARDS:
${context.projectContext.clinerules || 'No specific rules defined'}

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
    if (context.diffStrategy.strategy === 'whole' && context.prDiff) {
      return context.prDiff.diff || JSON.stringify(context.prDiff, null, 2);
    } else if (context.diffStrategy.strategy === 'file-by-file' && context.fileDiffs) {
      const fileDiffArray = Array.from(context.fileDiffs.entries()).map(([file, diff]) => ({
        file,
        diff
      }));
      return JSON.stringify(fileDiffArray, null, 2);
    }
    return 'No diff content available';
  }

  /**
   * Detect project type for better context
   */
  private detectProjectType(context: UnifiedContext): string {
    const fileExtensions = new Set<string>();
    
    // Extract file extensions from changes
    if (context.pr.fileChanges) {
      context.pr.fileChanges.forEach(file => {
        const ext = file.split('.').pop()?.toLowerCase();
        if (ext) fileExtensions.add(ext);
      });
    }

    if (fileExtensions.has('rs') || fileExtensions.has('res')) return 'rescript';
    if (fileExtensions.has('ts') || fileExtensions.has('tsx')) return 'typescript';
    if (fileExtensions.has('js') || fileExtensions.has('jsx')) return 'javascript';
    if (fileExtensions.has('py')) return 'python';
    if (fileExtensions.has('go')) return 'golang';
    if (fileExtensions.has('java')) return 'java';
    if (fileExtensions.has('cpp') || fileExtensions.has('c')) return 'cpp';
    
    return 'mixed';
  }

  /**
   * Assess complexity level for better AI context
   */
  private assessComplexity(context: UnifiedContext): 'low' | 'medium' | 'high' | 'very-high' {
    const fileCount = context.diffStrategy.fileCount;
    const hasLargeFiles = context.diffStrategy.estimatedSize.includes('Large');
    const hasComments = (context.pr.comments?.length || 0) > 0;
    
    if (fileCount > 50) return 'very-high';
    if (fileCount > 20 || hasLargeFiles) return 'high';
    if (fileCount > 10 || hasComments) return 'medium';
    return 'low';
  }

  /**
   * Legacy method - kept for compatibility but simplified
   */
  private buildAnalysisPrompt(context: UnifiedContext, _options: ReviewOptions): string {
    // Legacy method - now delegates to new structure
    return this.buildCoreAnalysisPrompt(context);
  }

  /**
   * Analyze code with AI using the enhanced prompt
   */
  private async analyzeWithAI(prompt: string, context: UnifiedContext): Promise<Violation[]> {
    try {
      logger.debug('Starting AI analysis...');

      // Initialize NeuroLink with eval-based dynamic import
      if (!this.neurolink) {
        const dynamicImport = eval('(specifier) => import(specifier)');
        const { NeuroLink } = await dynamicImport('@juspay/neurolink');
        this.neurolink = new NeuroLink();
      }

      // Extract context from unified context for better AI understanding
      const aiContext = {
        operation: 'code-review',
        repository: `${context.identifier.workspace}/${context.identifier.repository}`,
        branch: context.identifier.branch,
        prId: context.identifier.pullRequestId,
        prTitle: context.pr.title,
        prAuthor: context.pr.author,
        fileCount: context.diffStrategy.fileCount,
        diffStrategy: context.diffStrategy.strategy,
        analysisType: context.diffStrategy.strategy === 'whole' ? 'comprehensive' : 'file-by-file',
        projectType: this.detectProjectType(context),
        hasExistingComments: (context.pr.comments?.length || 0) > 0,
        complexity: this.assessComplexity(context)
      };

      // Simplified, focused prompt without context pollution
      const corePrompt = this.buildCoreAnalysisPrompt(context);

      const result = await this.neurolink.generate({
        input: { text: corePrompt },
        systemPrompt: this.getSecurityReviewSystemPrompt(),
        provider: this.aiConfig.provider || 'auto', // Auto-select best provider
        model: this.aiConfig.model || 'best', // Use most capable model
        temperature: this.aiConfig.temperature || 0.3, // Lower for more focused analysis
        maxTokens: Math.max(this.aiConfig.maxTokens || 0, 2000000), // Quality first - always use higher limit
        timeout: '15m', // Allow plenty of time for thorough analysis
        context: aiContext,
        enableAnalytics: this.aiConfig.enableAnalytics || true,
        enableEvaluation: false // Disabled to prevent evaluation warnings
      });

      // Log analytics if available
      if (result.analytics) {
        logger.debug(`AI Analytics - Provider: ${result.provider}, Response Time: ${result.responseTime}ms, Quality Score: ${result.evaluation?.overallScore}`);
      }

      logger.debug('AI analysis completed, parsing response...');

      // Modern NeuroLink returns { content: string }
      const analysisData = this.parseAIResponse(result);
      
      // Display AI response for debugging
      if (logger.getConfig().verbose) {
        logger.debug('AI Analysis Response:');
        logger.debug('═'.repeat(80));
        logger.debug(JSON.stringify(analysisData, null, 2));
        logger.debug('═'.repeat(80));
      }

      if (!analysisData.violations || !Array.isArray(analysisData.violations)) {
        logger.debug('No violations array found in AI response');
        return [];
      }

      logger.debug(`AI analysis found ${analysisData.violations.length} violations`);
      return analysisData.violations;

    } catch (error) {
      if ((error as Error).message?.includes('timeout')) {
        logger.error('⏰ AI analysis timed out after 15 minutes');
        throw new Error('Analysis timeout - try reducing diff size or adjusting timeout');
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
    _options: ReviewOptions
  ): Promise<void> {
    logger.phase('📝 Posting review comments...');

    let commentsPosted = 0;
    let commentsFailed = 0;
    const failedComments: { file?: string; issue: string; error: string }[] = [];
    
    // Post inline comments
    const inlineViolations = violations.filter(v => 
      v.type === 'inline' && v.file && v.code_snippet
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
        logger.debug(`   Processed snippet: ${processedViolation.code_snippet}`);
        if (processedViolation.search_context) {
          logger.debug(`   Search context before: ${JSON.stringify(processedViolation.search_context.before)}`);
          logger.debug(`   Search context after: ${JSON.stringify(processedViolation.search_context.after)}`);
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
            suggestion: processedViolation.suggestion // Pass the suggestion for inline code suggestions
          }
        );
        
        commentsPosted++;
        logger.debug(`✅ Posted inline comment: ${cleanFilePath} (${processedViolation.issue})`);
      } catch (error) {
        commentsFailed++;
        const errorMsg = (error as Error).message;
        logger.debug(`❌ Failed to post inline comment: ${errorMsg}`);
        logger.debug(`   File: ${violation.file}, Issue: ${violation.issue}`);
        logger.debug(`   Code snippet: ${violation.code_snippet}`);
        
        failedComments.push({
          file: violation.file,
          issue: violation.issue,
          error: errorMsg
        });
      }
    }

    // Post summary comment (include failed comments info if any)
    if (violations.length > 0) {
      try {
        const summaryComment = this.generateSummaryComment(violations, context, failedComments);
        await this.bitbucketProvider.addComment(context.identifier, summaryComment);
        commentsPosted++;
        logger.debug('✅ Posted summary comment');
      } catch (error) {
        logger.debug(`❌ Failed to post summary comment: ${(error as Error).message}`);
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
      CRITICAL: { emoji: '🚨', badge: '**🚨 CRITICAL SECURITY ISSUE**', color: 'red' },
      MAJOR: { emoji: '⚠️', badge: '**⚠️ MAJOR ISSUE**', color: 'orange' },
      MINOR: { emoji: '📝', badge: '**📝 MINOR IMPROVEMENT**', color: 'blue' },
      SUGGESTION: { emoji: '💡', badge: '**💡 SUGGESTION**', color: 'green' }
    };

    const categoryIcons = {
      security: '🔒', performance: '⚡', maintainability: '🏗️',
      functionality: '⚙️', error_handling: '🛡️', testing: '🧪', general: '📋'
    };

    const config = severityConfig[violation.severity] || severityConfig.MINOR;
    const categoryIcon = categoryIcons[violation.category] || categoryIcons.general;

    let comment = `${config.badge}

**${categoryIcon} ${violation.issue}**

**Category**: ${violation.category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}

**Issue**: ${violation.message}`;

    if (violation.impact) {
      comment += `\n\n**Impact**: ${violation.impact}`;
    }

    if (violation.suggestion) {
      const fileExt = violation.file?.split('.').pop() || 'text';
      const langMap: Record<string, string> = {
        js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
        res: 'rescript', resi: 'rescript', py: 'python', java: 'java',
        go: 'go', rb: 'ruby', php: 'php', sql: 'sql', json: 'json'
      };
      const language = langMap[fileExt] || 'text';

      // Use the escape method for code blocks
      const escapedCodeBlock = this.escapeMarkdownCodeBlock(violation.suggestion, language);
      comment += `\n\n**💡 Suggested Fix**:\n${escapedCodeBlock}`;
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
    failedComments: { file?: string; issue: string; error: string }[] = []
  ): string {
    const stats = this.calculateStats(violations);
    
    const statusEmoji = stats.criticalCount > 0 ? '🚨' : 
                       stats.majorCount > 0 ? '⚠️ ' : 
                       stats.minorCount > 0 ? '📝' : '✅';
    
    const statusText = stats.criticalCount > 0 ? 'CRITICAL ISSUES FOUND' :
                      stats.majorCount > 0 ? 'ISSUES DETECTED' :
                      stats.minorCount > 0 ? 'IMPROVEMENTS SUGGESTED' : 
                      'CODE QUALITY APPROVED';

    let comment = `
╭─────────────────────────────────────────────────────────────╮
│                    ⚔️ **YAMA REVIEW REPORT** ⚔️               │
╰─────────────────────────────────────────────────────────────╯

## ${statusEmoji} **${statusText}**

### 📊 **Security & Quality Analysis**
| **Severity** | **Count** | **Status** |
|--------------|-----------|------------|
| 🚨 Critical | ${stats.criticalCount} | ${stats.criticalCount > 0 ? '⛔ Must Fix' : '✅ Clear'} |
| ⚠️ Major | ${stats.majorCount} | ${stats.majorCount > 0 ? '⚠️ Should Fix' : '✅ Clear'} |
| 📝 Minor | ${stats.minorCount} | ${stats.minorCount > 0 ? '📝 Consider Fixing' : '✅ Clear'} |
| 💡 Suggestions | ${stats.suggestionCount} | ${stats.suggestionCount > 0 ? '💡 Optional' : '✅ Clear'} |

### 🔍 **Analysis Summary**
- **📁 Files Analyzed**: ${context.diffStrategy.fileCount}
- **📊 Strategy Used**: ${context.diffStrategy.strategy} (${context.diffStrategy.reason})
- **🎯 Total Issues**: ${stats.totalIssues}
- **🏷️ PR**: #${context.pr.id} - "${context.pr.title}"`;

    // Add category breakdown if there are violations
    const violationsByCategory = this.groupViolationsByCategory(violations);
    if (Object.keys(violationsByCategory).length > 0) {
      comment += `\n\n### 📍 **Issues by Category**\n`;
      
      for (const [category, categoryViolations] of Object.entries(violationsByCategory)) {
        const categoryIcons = {
          security: '🔒', performance: '⚡', maintainability: '🏗️',
          functionality: '⚙️', error_handling: '🛡️', testing: '🧪', general: '📋'
        };
        
        const icon = categoryIcons[category as keyof typeof categoryIcons] || '📋';
        const name = category.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        
        comment += `**${icon} ${name}**: ${categoryViolations.length} issue${categoryViolations.length !== 1 ? 's' : ''}\n`;
      }
    }

    // Add failed comments section if any
    if (failedComments.length > 0) {
      comment += `\n\n### ⚠️ **Note on Inline Comments**\n`;
      comment += `Some inline comments could not be posted due to code matching issues. `;
      comment += `Please review the following issues manually:\n\n`;
      
      for (const failed of failedComments) {
        comment += `- **${failed.issue}** in \`${failed.file || 'unknown file'}\`\n`;
      }
    }

    // Add recommendation
    const recommendation = stats.criticalCount > 0 
      ? '🚨 **URGENT**: Critical security issues must be resolved before merge'
      : stats.majorCount > 0
      ? '⚠️ **RECOMMENDED**: Address major issues before merge'
      : stats.minorCount > 0
      ? '📝 **OPTIONAL**: Consider addressing minor improvements'
      : '✅ **APPROVED**: Code meets security and quality standards';

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
    const cleaned = filePath
      .replace(/^(src|dst):\/\//, '');
    
    // Log the cleaning for debugging
    if (cleaned !== filePath) {
      logger.debug(`Cleaned file path: ${filePath} -> ${cleaned}`);
    }
    
    return cleaned;
  }

  /**
   * Extract exact file path from diff
   */
  private extractFilePathFromDiff(diff: string, fileName: string): string | null {
    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        // Extract both paths: a/path/to/file b/path/to/file
        const match = line.match(/diff --git a\/(.*?) b\/(.*?)$/);
        if (match && (match[1].includes(fileName) || match[2].includes(fileName))) {
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
    codeSnippet: string
  ): { lineNumber: number; lineType: 'ADDED' | 'REMOVED' | 'CONTEXT' } | null {
    const lines = fileDiff.split('\n');
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
        logger.debug(`Found hunk header: old=${currentOldLine}, new=${currentNewLine}`);
        continue;
      }
      
      // Skip lines that aren't part of the diff content
      if (!inHunk || (!line.startsWith('+') && !line.startsWith('-') && !line.startsWith(' '))) {
        continue;
      }
      
      // Check if this line matches our snippet
      if (line === codeSnippet) {
        let resultLine: number;
        let lineType: 'ADDED' | 'REMOVED' | 'CONTEXT';
        
        if (line.startsWith('+')) {
          resultLine = currentNewLine;
          lineType = 'ADDED';
        } else if (line.startsWith('-')) {
          resultLine = currentOldLine;
          lineType = 'REMOVED';
        } else {
          resultLine = currentNewLine;
          lineType = 'CONTEXT';
        }
        
        logger.debug(`Found match at line ${resultLine} (${lineType})`);
        return { lineNumber: resultLine, lineType };
      }
      
      // Update line counters AFTER checking for match
      // For added lines: only increment new line counter
      // For removed lines: only increment old line counter
      // For context lines: increment both counters
      if (line.startsWith('+')) {
        currentNewLine++;
      } else if (line.startsWith('-')) {
        currentOldLine++;
      } else if (line.startsWith(' ')) {
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
    if (code.includes('```')) {
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
        if (fixed.search_context.before && Array.isArray(fixed.search_context.before)) {
          fixed.search_context.before = this.splitArrayLines(fixed.search_context.before);
        }
        if (fixed.search_context.after && Array.isArray(fixed.search_context.after)) {
          fixed.search_context.after = this.splitArrayLines(fixed.search_context.after);
        }
      }

      // Ensure line_type is set based on code snippet prefix BEFORE cleaning
      if (!fixed.line_type && fixed.code_snippet) {
        if (fixed.code_snippet.startsWith('+')) {
          fixed.line_type = 'ADDED';
        } else if (fixed.code_snippet.startsWith('-')) {
          fixed.line_type = 'REMOVED';
        } else {
          fixed.line_type = 'CONTEXT';
        }
      }

      // Clean the code_snippet field to remove diff symbols - EXACTLY like pr-police.js
      if (fixed.code_snippet) {
        fixed.code_snippet = fixed.code_snippet.replace(/^[+\-\s]/, '').trim();
      }

      // Clean the suggestion field to remove any diff symbols
      if (fixed.suggestion) {
        fixed.suggestion = fixed.suggestion
          .split('\n')
          .map((line: string) => line.replace(/^[+\-\s]/, '')) // Remove diff symbols at start of each line
          .join('\n')
          .trim();
      }

      return fixed;
    } catch (error) {
      logger.debug(`❌ Error cleaning code snippet: ${(error as Error).message}`);
      return null;
    }
  }

  private splitArrayLines(arr: string[]): string[] {
    const result: string[] = [];
    for (const item of arr) {
      if (typeof item === 'string' && item.includes('\n')) {
        result.push(...item.split('\n').filter(line => line.length > 0));
      } else {
        result.push(item);
      }
    }
    return result;
  }

  private groupViolationsByCategory(violations: Violation[]): Record<string, Violation[]> {
    const grouped: Record<string, Violation[]> = {};
    
    violations.forEach(v => {
      const category = v.category || 'general';
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(v);
    });

    return grouped;
  }

  private calculateStats(violations: Violation[]): any {
    return {
      criticalCount: violations.filter(v => v.severity === 'CRITICAL').length,
      majorCount: violations.filter(v => v.severity === 'MAJOR').length,
      minorCount: violations.filter(v => v.severity === 'MINOR').length,
      suggestionCount: violations.filter(v => v.severity === 'SUGGESTION').length,
      totalIssues: violations.length,
      filesReviewed: new Set(violations.filter(v => v.file).map(v => v.file)).size || 1
    };
  }

  private generateReviewResult(
    violations: Violation[], 
    _duration: number, 
    _context: UnifiedContext
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
        suggestionCount: stats.suggestionCount
      },
      positiveObservations: [] // Could be extracted from AI response
    };
  }

  /**
   * Utility methods
   */
  private parseAIResponse(result: any): any {
    try {
      const responseText = result.content || result.text || result.response || '';
      
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
    context: UnifiedContext
  ): { lineNumber: number; lineType: 'ADDED' | 'REMOVED' | 'CONTEXT' } | null {
    if (!violation.file || !violation.code_snippet) return null;

    try {
      // Get the diff for this specific file
      let fileDiff: string | undefined;
      
      if (context.diffStrategy.strategy === 'whole' && context.prDiff) {
        // Extract file diff from whole diff
        const diffLines = context.prDiff.diff.split('\n');
        let fileStartIndex = -1;
        
        // Create all possible path variations for matching
        const filePathVariations = this.generatePathVariations(violation.file);
        
        for (let i = 0; i < diffLines.length; i++) {
          const line = diffLines[i];
          if (line.startsWith('diff --git')) {
            // Check if any variation matches
            for (const pathVariation of filePathVariations) {
              if (line.includes(pathVariation)) {
                fileStartIndex = i;
                break;
              }
            }
            if (fileStartIndex >= 0) break;
          }
        }
        
        if (fileStartIndex >= 0) {
          const nextFileIndex = diffLines.findIndex((line, idx) => 
            idx > fileStartIndex && line.startsWith('diff --git')
          );
          
          fileDiff = diffLines.slice(
            fileStartIndex, 
            nextFileIndex > 0 ? nextFileIndex : diffLines.length
          ).join('\n');
        }
      } else if (context.diffStrategy.strategy === 'file-by-file' && context.fileDiffs) {
        // Try all possible path variations
        const pathVariations = this.generatePathVariations(violation.file);
        
        for (const path of pathVariations) {
          fileDiff = context.fileDiffs.get(path);
          if (fileDiff) {
            logger.debug(`Found diff for ${violation.file} using variation: ${path}`);
            break;
          }
        }

        // If still not found, try to find by partial match
        if (!fileDiff) {
          for (const [key, value] of context.fileDiffs.entries()) {
            if (key.endsWith(violation.file) || violation.file.endsWith(key)) {
              fileDiff = value;
              logger.debug(`Found diff for ${violation.file} using partial match: ${key}`);
              break;
            }
          }
        }
      }

      if (fileDiff) {
        const lineInfo = this.extractLineNumberFromDiff(fileDiff, violation.code_snippet);
        if (lineInfo) {
          logger.debug(`Extracted line info for ${violation.file}: line ${lineInfo.lineNumber}, type ${lineInfo.lineType}`);
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
    if (filePath.includes('/')) {
      const parts = filePath.split('/');
      
      // Try removing first directory
      if (parts.length > 1) {
        variations.add(parts.slice(1).join('/'));
      }
      
      // Try removing first two directories
      if (parts.length > 2) {
        variations.add(parts.slice(2).join('/'));
      }
      
      // Try with just the filename
      variations.add(parts[parts.length - 1]);
    }
    
    // Remove app/ prefix variations
    if (filePath.startsWith('app/')) {
      const withoutApp = filePath.substring(4);
      variations.add(withoutApp);
      variations.add(`a/${withoutApp}`);
      variations.add(`b/${withoutApp}`);
    }
    
    // Add app/ prefix variations
    if (!filePath.startsWith('app/')) {
      variations.add(`app/${filePath}`);
      variations.add(`a/app/${filePath}`);
      variations.add(`b/app/${filePath}`);
    }
    
    return Array.from(variations);
  }
}

export function createCodeReviewer(
  bitbucketProvider: BitbucketProvider,
  aiConfig: AIProviderConfig,
  reviewConfig: CodeReviewConfig
): CodeReviewer {
  return new CodeReviewer(bitbucketProvider, aiConfig, reviewConfig);
}
