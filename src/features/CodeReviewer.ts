/**
 * Enhanced Code Reviewer - Optimized to work with Unified Context
 * Preserves all original functionality from pr-police.js but optimized
 */

import { NeuroLink } from '@juspay/neurolink';
import {
  PRIdentifier,
  Violation,
  ReviewResult,
  ReviewOptions,
  AIProviderConfig,
  ProviderError
} from '../types';
import { UnifiedContext } from '../core/ContextGatherer';
import { BitbucketProvider } from '../core/providers/BitbucketProvider';
import { logger } from '../utils/Logger';

export class CodeReviewer {
  private neurolink: NeuroLink;
  private bitbucketProvider: BitbucketProvider;
  private aiConfig: AIProviderConfig;

  constructor(
    bitbucketProvider: BitbucketProvider,
    aiConfig: AIProviderConfig
  ) {
    this.bitbucketProvider = bitbucketProvider;
    this.aiConfig = aiConfig;
    this.neurolink = new NeuroLink();
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

      // Build analysis prompt using unified context
      const analysisPrompt = this.buildAnalysisPrompt(context, options);

      // Conduct AI analysis
      const violations = await this.analyzeWithAI(analysisPrompt);

      // Post comments if not dry run
      if (!options.dryRun && violations.length > 0) {
        await this.postComments(context, violations, options);
      }

      const duration = Math.round((Date.now() - startTime) / 1000);
      const result = this.generateReviewResult(violations, duration, context);

      logger.success(
        `Code review completed in ${duration}s: ${violations.length} violations found`
      );

      return result;

    } catch (error) {
      logger.error(`Code review failed: ${(error as Error).message}`);
      throw new ProviderError(`Code review failed: ${(error as Error).message}`);
    }
  }

  /**
   * Build comprehensive analysis prompt using unified context
   */
  private buildAnalysisPrompt(context: UnifiedContext, options: ReviewOptions): string {
    // Prepare diff data based on strategy
    let diffContent = '';
    if (context.diffStrategy.strategy === 'whole' && context.prDiff) {
      diffContent = JSON.stringify(context.prDiff, null, 2);
    } else if (context.diffStrategy.strategy === 'file-by-file' && context.fileDiffs) {
      const fileDiffArray = Array.from(context.fileDiffs.entries()).map(([file, diff]) => ({
        file,
        diff
      }));
      diffContent = JSON.stringify(fileDiffArray, null, 2);
    }

    return `You are an Expert Code Reviewer conducting a comprehensive security and quality analysis.

## IMPORTANT CONTEXT:
**✅ All code changes have been successfully compiled and type-checked.**
Focus on: logic, security, performance, maintainability, and best practices.

## PR DETAILS:
**Title**: ${context.pr.title}
**Author**: ${context.pr.author}
**Description**: ${context.pr.description}
**Files Changed**: ${context.pr.fileChanges?.length || 0}
**Comments**: ${JSON.stringify(context.pr.comments || [], null, 2)}

## DIFF ANALYSIS (${context.diffStrategy.strategy.toUpperCase()} STRATEGY):
**Reason**: ${context.diffStrategy.reason}
**File Count**: ${context.diffStrategy.fileCount}
**Estimated Size**: ${context.diffStrategy.estimatedSize}

### CODE CHANGES:
${this.truncateForAI(diffContent)}

## PROJECT CONTEXT:
${context.projectContext.memoryBank.summary}

## PROJECT RULES:
${context.projectContext.clinerules || 'No specific rules defined'}

## REVIEW FRAMEWORK:

### 🔒 Security Analysis (Priority: CRITICAL)
- Input validation and sanitization
- SQL/XSS/Command injection prevention
- Authentication/authorization flaws
- Hardcoded secrets detection
- Dependency vulnerabilities

### ⚡ Performance Review (Priority: MAJOR)
- Algorithm efficiency (O(n) complexity issues)
- Database query optimization (N+1 problems)
- Memory leaks and resource management
- Caching opportunities
- Unnecessary computations

### 🏗️ Code Quality (Priority: MINOR/SUGGESTION)
- SOLID principles adherence
- DRY principle violations
- Consistent naming conventions
- Proper error handling
- Code organization and readability

### 🛡️ Reliability & Error Handling
- Comprehensive error handling
- Edge case coverage
- Graceful failure modes
- Proper logging implementation

## SEVERITY GUIDELINES:
- **CRITICAL** 🚨: Security vulnerabilities, data corruption risks, breaking changes
- **MAJOR** ⚠️: Logic errors, performance issues, maintainability problems
- **MINOR** 📝: Code style issues, minor optimizations, naming improvements
- **SUGGESTION** 💡: Best practices, refactoring opportunities, additional features

## CRITICAL REQUIREMENTS:

### Comment Awareness:
- Review existing PR comments: ${JSON.stringify(context.pr.comments || [])}
- DO NOT repeat issues already discussed
- Acknowledge developer responses if present
- Focus on NEW issues not yet addressed

### Code Snippet Format:
- **MANDATORY**: code_snippet must be EXACTLY ONE LINE from the diff
- Include diff prefixes (+, -, or space) in code_snippet
- Use search_context for additional context lines
- Each context line must be a separate array element

### Suggestion Format:
- Must contain CLEAN, executable code
- NO diff symbols (+, -, spaces) in suggestions
- Complete, copy-pasteable code solutions

## OUTPUT FORMAT:
Return ONLY this JSON structure:

{
  "violations": [
    {
      "type": "inline",
      "file": "path/to/file.ext",
      "code_snippet": "+const query = \`SELECT * FROM users WHERE id = \${id}\`;",
      "search_context": {
        "before": ["function getUser(id) {", "  try {"],
        "after": ["    return db.query(query);", "  } catch (error) {"]
      },
      "severity": "CRITICAL",
      "category": "security",
      "issue": "SQL Injection Vulnerability",
      "message": "Direct string interpolation in SQL query enables injection attacks",
      "impact": "Attackers could execute arbitrary SQL commands, potentially accessing or modifying sensitive data",
      "suggestion": "const query = 'SELECT * FROM users WHERE id = ?';\\nreturn db.query(query, [id]);"
    }
  ],
  "summary": "Review identified X critical, Y major, Z minor issues requiring attention",
  "positiveObservations": [
    "Excellent error handling implementation",
    "Good use of TypeScript for type safety",
    "Well-structured component architecture"
  ],
  "statistics": {
    "filesReviewed": ${context.diffStrategy.fileCount},
    "totalIssues": 0,
    "criticalCount": 0,
    "majorCount": 0,
    "minorCount": 0,
    "suggestionCount": 0
  }
}

**FINAL REMINDERS:**
1. Focus on actionable feedback with specific examples
2. Provide educational explanations for violations
3. Balance criticism with positive observations
4. Ensure suggestions contain clean, runnable code
5. Consider the project context and established patterns`;
  }

  /**
   * Analyze code with AI using the enhanced prompt
   */
  private async analyzeWithAI(prompt: string): Promise<Violation[]> {
    try {
      logger.debug('Starting AI analysis...');

      const result = await this.neurolink.generate({
        input: { text: prompt },
        provider: this.aiConfig.provider,
        model: this.aiConfig.model,
        temperature: this.aiConfig.temperature || 0.7,
        maxTokens: this.aiConfig.maxTokens || 1000000,
        timeout: '6m',
        enableAnalytics: this.aiConfig.enableAnalytics,
        enableEvaluation: this.aiConfig.enableEvaluation
      });

      logger.debug('AI analysis completed, parsing response...');

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
        logger.error('⏰ AI analysis timed out after 6 minutes');
        throw new Error('Analysis timeout - try reducing diff size or adjusting timeout');
      }
      logger.error(`AI analysis failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Post comments to PR using unified context
   */
  private async postComments(
    context: UnifiedContext,
    violations: Violation[],
    options: ReviewOptions
  ): Promise<void> {
    logger.phase('📝 Posting review comments...');

    let commentsPosted = 0;
    
    // Post inline comments
    const inlineViolations = violations.filter(v => 
      v.type === 'inline' && v.file && v.code_snippet
    );

    for (const violation of inlineViolations) {
      try {
        const processedViolation = this.cleanCodeSnippet(violation);
        if (!processedViolation) {
          logger.debug(`⚠️ Skipping invalid violation for ${violation.file}`);
          continue;
        }

        const formattedComment = this.formatInlineComment(processedViolation);

        await this.bitbucketProvider.addComment(
          context.identifier,
          formattedComment,
          {
            filePath: this.cleanFilePath(violation.file!),
            codeSnippet: processedViolation.code_snippet,
            searchContext: processedViolation.search_context,
            matchStrategy: 'best',
            suggestion: processedViolation.suggestion
          }
        );

        commentsPosted++;
        logger.debug(`✅ Posted comment: ${violation.file} (${violation.issue})`);
        
      } catch (error) {
        logger.debug(`❌ Failed to post comment: ${(error as Error).message}`);
      }
    }

    // Post summary comment
    if (violations.length > 0) {
      try {
        const summaryComment = this.generateSummaryComment(violations, context);
        await this.bitbucketProvider.addComment(context.identifier, summaryComment);
        commentsPosted++;
        logger.debug('✅ Posted summary comment');
      } catch (error) {
        logger.debug(`❌ Failed to post summary comment: ${(error as Error).message}`);
      }
    }

    logger.success(`✅ Posted ${commentsPosted} comments successfully`);
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

      comment += `\n\n**💡 Suggested Fix**:\n\`\`\`${language}\n${violation.suggestion}\n\`\`\``;
    }

    comment += `\n\n---\n*🛡️ Automated review by **Yama** • Powered by AI*`;

    return comment;
  }

  /**
   * Generate comprehensive summary comment
   */
  private generateSummaryComment(violations: Violation[], context: UnifiedContext): string {
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
│                    🛡️ **PR GUARDIAN REPORT** 🛡️               │
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
    return filePath.replace(/^(src|dst):\/\//, '');
  }

  private cleanCodeSnippet(violation: Violation): Violation | null {
    try {
      const fixed = JSON.parse(JSON.stringify(violation));

      // Clean search context arrays
      if (fixed.search_context) {
        if (fixed.search_context.before) {
          fixed.search_context.before = this.splitArrayLines(fixed.search_context.before);
        }
        if (fixed.search_context.after) {
          fixed.search_context.after = this.splitArrayLines(fixed.search_context.after);
        }
      }

      // Set line type based on code snippet prefix
      if (!fixed.line_type && fixed.code_snippet) {
        if (fixed.code_snippet.startsWith('+')) {
          fixed.line_type = 'ADDED';
        } else if (fixed.code_snippet.startsWith('-')) {
          fixed.line_type = 'REMOVED';
        } else {
          fixed.line_type = 'CONTEXT';
        }
      }

      // Clean suggestion field
      if (fixed.suggestion) {
        fixed.suggestion = fixed.suggestion
          .split('\n')
          .map((line: string) => line.replace(/^[+\-\s]/, ''))
          .join('\n')
          .trim();
      }

      return fixed;
    } catch (error) {
      logger.debug(`Error cleaning code snippet: ${(error as Error).message}`);
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
    duration: number, 
    context: UnifiedContext
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
      let responseText = result.content || result.text || result.response || '';
      
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

  private truncateForAI(text: string): string {
    const maxLength = 15000; // Larger limit for better analysis
    if (text.length > maxLength) {
      return text.substring(0, maxLength) + '\n\n... (content truncated for analysis)';
    }
    return text;
  }
}

export function createCodeReviewer(
  bitbucketProvider: BitbucketProvider,
  aiConfig: AIProviderConfig
): CodeReviewer {
  return new CodeReviewer(bitbucketProvider, aiConfig);
}