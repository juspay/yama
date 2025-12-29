/**
 * Learning Orchestrator
 * Main entry point for the knowledge base learning feature
 * Orchestrates PR comment extraction, AI analysis, and knowledge base updates
 */

import { NeuroLink } from "@juspay/neurolink";
import { MCPServerManager } from "./MCPServerManager.js";
import { ConfigLoader } from "../config/ConfigLoader.js";
import { LangfusePromptManager } from "../prompts/LangfusePromptManager.js";
import { KnowledgeBaseManager } from "../learning/KnowledgeBaseManager.js";
import {
  LearnRequest,
  LearnResult,
  ExtractedLearning,
  LearningCategory,
} from "../learning/types.js";
import { YamaV2Config } from "../types/config.types.js";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../utils/ObservabilityConfig.js";

// Type for structured learning extraction output
interface LearningExtractionOutput {
  learnings: Array<{
    category: LearningCategory;
    subcategory?: string;
    learning: string;
    filePatterns?: string[];
    reasoning: string;
  }>;
  summary: {
    totalAIComments: number;
    totalDeveloperReplies: number;
    totalIndependentDevComments: number;
    actionablePairsFound: number;
  };
}

export class LearningOrchestrator {
  private neurolink!: NeuroLink;
  private mcpManager: MCPServerManager;
  private configLoader: ConfigLoader;
  private promptManager: LangfusePromptManager;
  private config!: YamaV2Config;
  private initialized = false;

  constructor() {
    this.configLoader = new ConfigLoader();
    this.mcpManager = new MCPServerManager();
    this.promptManager = new LangfusePromptManager();
  }

  /**
   * Initialize the learning orchestrator
   */
  async initialize(configPath?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log("🧠 Initializing Learning Orchestrator...\n");

    try {
      // Load configuration
      this.config = await this.configLoader.loadConfig(configPath);

      // Initialize NeuroLink
      console.log("   🔧 Initializing NeuroLink AI engine...");
      this.neurolink = this.initializeNeurolink();
      console.log("   ✅ NeuroLink initialized\n");

      // Setup MCP servers (need Bitbucket for PR access)
      await this.mcpManager.setupMCPServers(
        this.neurolink,
        this.config.mcpServers,
      );
      console.log("   ✅ MCP servers ready\n");

      this.initialized = true;
      console.log("✅ Learning Orchestrator initialized\n");
    } catch (error) {
      console.error("\n❌ Initialization failed:", (error as Error).message);
      throw error;
    }
  }

  /**
   * Extract learnings from a merged PR
   * Uses fully agentic AI approach - AI decides which tools to call
   */
  async extractLearnings(request: LearnRequest): Promise<LearnResult> {
    await this.ensureInitialized();

    console.log("\n" + "─".repeat(60));
    console.log(`📚 Extracting learnings from PR #${request.pullRequestId}`);
    console.log("─".repeat(60));
    console.log(`   Workspace: ${request.workspace}`);
    console.log(`   Repository: ${request.repository}`);
    console.log(`   Mode: ${request.dryRun ? "🔵 DRY RUN" : "🔴 LIVE"}`);
    console.log("─".repeat(60) + "\n");

    try {
      // STEP 1: Fetch PR comments using agentic approach (with tools)
      console.log("📥 Step 1: Fetching PR comments via Bitbucket MCP...");

      const fetchInstructions = this.buildFetchCommentsInstructions(request);
      const fetchResponse = await this.neurolink.generate({
        input: { text: fetchInstructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: 0.1,
        maxTokens: 50000,
        timeout: this.config.ai.timeout,
        context: {
          operation: "learning-fetch-comments",
          prId: request.pullRequestId,
        },
      });

      const commentsData = fetchResponse.content || "";
      console.log("   ✅ PR data fetched\n");

      // STEP 2: Extract learnings with structured schema (no tools needed)
      console.log("🤖 Step 2: Extracting learnings with structured output...");

      const learningPrompt = await this.promptManager.getLearningPrompt();
      const extractionInstructions = this.buildExtractionInstructions(
        request,
        learningPrompt,
        commentsData,
      );

      // Extract learnings - disableTools since we already have the data
      const extractResponse = await this.neurolink.generate({
        input: { text: extractionInstructions },
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        temperature: 0.2,
        maxTokens: 10000,
        timeout: "2m",
        disableTools: true, // No tools needed for extraction phase
        context: {
          operation: "learning-extraction",
          prId: request.pullRequestId,
        },
      });

      // Parse structured response
      const learnings = this.parseStructuredLearnings(
        extractResponse,
        request.pullRequestId,
      );

      console.log(`\n📊 AI extracted ${learnings.length} learnings\n`);

      if (learnings.length === 0) {
        // Log extraction response for debugging
        console.log("🔍 Extraction Response (for debugging):");
        console.log("─".repeat(60));
        const responsePreview = JSON.stringify(
          extractResponse.content || extractResponse,
          null,
          2,
        ).slice(0, 2000);
        console.log(responsePreview);
        console.log("─".repeat(60) + "\n");

        return this.createEmptyResult(
          request,
          "No actionable learnings found from PR feedback",
        );
      }

      // Handle dry run vs live mode
      if (request.dryRun) {
        return this.handleDryRun(request, learnings);
      }

      // Update knowledge base
      console.log("📝 Updating knowledge base...");
      const kbManager = new KnowledgeBaseManager(
        this.config.knowledgeBase,
        process.cwd(),
      );

      // Create if doesn't exist
      if (!kbManager.exists()) {
        console.log("   Creating new knowledge base file...");
        await kbManager.create();
      }

      const addedCount = await kbManager.append(learnings);
      const duplicateCount = learnings.length - addedCount;
      console.log(`   ✅ Added ${addedCount} learnings`);
      if (duplicateCount > 0) {
        console.log(`   ⏭️  Skipped ${duplicateCount} duplicates`);
      }

      // Check if summarization is needed
      let summarized = false;
      if (request.summarize || (await kbManager.needsSummarization())) {
        console.log("\n🔄 Running summarization...");
        await this.runSummarization(kbManager);
        summarized = true;
        console.log("   ✅ Summarization complete");
      }

      // Commit if requested
      let committed = false;
      if (request.commit || this.config.knowledgeBase.autoCommit) {
        console.log("\n📤 Committing knowledge base...");
        await kbManager.commit(request.pullRequestId, addedCount);
        committed = true;
        console.log("   ✅ Changes committed");
      }

      // Return result
      const result: LearnResult = {
        success: true,
        prId: request.pullRequestId,
        learningsFound: learnings.length,
        learningsAdded: addedCount,
        learningsDuplicate: duplicateCount,
        learnings,
        knowledgeBasePath: kbManager.getFilePath(),
        committed,
        summarized,
      };

      this.logResult(result);
      return result;
    } catch (error) {
      console.error(
        "\n❌ Learning extraction failed:",
        (error as Error).message,
      );
      return {
        success: false,
        prId: request.pullRequestId,
        learningsFound: 0,
        learningsAdded: 0,
        learningsDuplicate: 0,
        learnings: [],
        error: (error as Error).message,
      };
    }
  }

  /**
   * Build instructions for Step 1: Fetch PR comments
   */
  private buildFetchCommentsInstructions(request: LearnRequest): string {
    const aiPatterns = this.config.knowledgeBase.aiAuthorPatterns.join(", ");

    return `
<task>Fetch and analyze ALL PR comments for learning extraction</task>

<pr-details>
  <workspace>${request.workspace}</workspace>
  <repository>${request.repository}</repository>
  <pull_request_id>${request.pullRequestId}</pull_request_id>
</pr-details>

<instructions>
1. Use get_pull_request tool to fetch the PR details including all comments/activities
2. Look through ALL comments on the PR (both active and resolved if available)
3. Identify AI-generated comments by:
   - Author patterns: ${aiPatterns}
   - Text patterns: Comments starting with "🔒 CRITICAL:", "⚠️ MAJOR:", "💡 MINOR:", "💬 SUGGESTION:", or "Yama Review"
4. For each AI comment, look for developer replies (threaded responses or comments at same location)
5. IMPORTANT: Also identify DEVELOPER comments that are NOT replies to AI comments
   - These represent issues that AI MISSED and should have caught
   - Look for inline code comments from developers (not AI) that point out bugs, issues, or improvements
6. Output a structured summary of what you found
</instructions>

<output-format>
Provide a detailed summary in this format:

## PR Overview
- Title: [PR title]
- State: [merged/open/etc]
- Total comments found: [N]

## AI Comments Found
For each AI comment, list:
- Author: [name]
- Severity: [CRITICAL/MAJOR/MINOR/SUGGESTION]
- Comment text: [the comment]
- Location: [file path and line if inline]

## Developer Replies to AI Comments
For each developer reply to an AI comment:
- Original AI comment: [brief summary]
- Developer reply: [the full reply text]
- Developer name: [name]

## Developer Comments (NOT replies to AI)
IMPORTANT: List ALL developer-authored inline comments that are NOT replies to AI.
These represent issues AI MISSED and should have caught.
For each:
- Developer name: [name]
- File: [file path]
- Line: [line number if available]
- Comment text: [the full comment]
- Type: [bug/issue/suggestion/question]

If there are no developer comments (other than replies), state: "NO INDEPENDENT DEVELOPER COMMENTS FOUND"
</output-format>

Fetch the PR data now.
`;
  }

  /**
   * Build instructions for Step 2: Extract learnings from fetched data
   */
  private buildExtractionInstructions(
    request: LearnRequest,
    learningPrompt: string,
    commentsData: string,
  ): string {
    return `
<task>Extract project-level learnings from PR feedback</task>

<fetched-pr-data>
${commentsData}
</fetched-pr-data>

${learningPrompt}

<extraction-rules>
Extract learnings from TWO sources:

1. DEVELOPER REPLIES TO AI COMMENTS:
   - Developer explained why AI was wrong → false_positive
   - Developer provided context AI should know → domain_context
   - Developer indicated team preference → style_preference
   - Developer suggested how AI should improve → enhancement_guideline

2. INDEPENDENT DEVELOPER COMMENTS (not replies to AI):
   - These are issues AI MISSED and should have caught → missed_issue
   - If a developer added their own inline comment about a bug/issue, AI failed to spot it
   - Extract what type of issue it was so AI can catch similar issues in future

IMPORTANT RULES:
- Make learnings GENERIC - remove PR-specific details (file names, line numbers, variable names)
- Focus on the underlying principle or pattern that can apply to future reviews
- If BOTH "NO DEVELOPER REPLIES" AND "NO INDEPENDENT DEVELOPER COMMENTS", return empty learnings

Categories:
- false_positive: Developer explained why AI was wrong
- missed_issue: Developer pointed out something AI should have caught (including independent comments)
- style_preference: Team conventions that differ from general practice
- domain_context: Project-specific knowledge AI needs
- enhancement_guideline: How AI should provide better suggestions
</extraction-rules>

<output-format>
Return a JSON object in this exact format (wrapped in a json code block):

\`\`\`json
{
  "learnings": [
    {
      "category": "false_positive|missed_issue|style_preference|domain_context|enhancement_guideline",
      "subcategory": "Optional grouping (e.g., 'Async Patterns', 'Error Handling')",
      "learning": "The GENERIC, PROJECT-LEVEL guideline",
      "filePatterns": ["Optional array of file patterns where this applies"],
      "reasoning": "Why this learning was extracted"
    }
  ],
  "summary": {
    "totalAIComments": 0,
    "totalDeveloperReplies": 0,
    "totalIndependentDevComments": 0,
    "actionablePairsFound": 0
  }
}
\`\`\`

If no actionable feedback found, return empty learnings array with appropriate summary counts.
</output-format>

Analyze the PR data above and extract learnings.
`;
  }

  /**
   * Parse structured response from AI output
   */
  private parseStructuredLearnings(
    response: Record<string, unknown>,
    prId: number,
  ): ExtractedLearning[] {
    try {
      const content = (response.content || "") as string;

      // Find JSON in response (may be in code block)
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        console.log("   ⚠️ No JSON found in extraction response");
        return [];
      }

      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr) as LearningExtractionOutput;

      // Log summary if available
      if (parsed.summary) {
        const devComments = parsed.summary.totalIndependentDevComments || 0;
        console.log(
          `   📊 Summary: ${parsed.summary.totalAIComments} AI comments, ${parsed.summary.totalDeveloperReplies} dev replies, ${devComments} independent dev comments`,
        );
      }

      if (!parsed.learnings || !Array.isArray(parsed.learnings)) {
        return [];
      }

      const kbManager = new KnowledgeBaseManager(
        this.config.knowledgeBase,
        process.cwd(),
      );

      return parsed.learnings.map((item) => ({
        id: kbManager.generateLearningId(item.learning),
        category: item.category as LearningCategory,
        subcategory: item.subcategory,
        learning: item.learning,
        filePatterns: item.filePatterns,
        sourceInfo: {
          prId,
          timestamp: new Date().toISOString(),
        },
      }));
    } catch (error) {
      console.warn(
        "   ⚠️ Failed to parse structured output:",
        (error as Error).message,
      );
      return [];
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Initialize NeuroLink with observability
   */
  private initializeNeurolink(): NeuroLink {
    const observabilityConfig = buildObservabilityConfigFromEnv();

    const neurolinkConfig: Record<string, unknown> = {
      conversationMemory: this.config.ai.conversationMemory,
    };

    if (
      observabilityConfig &&
      validateObservabilityConfig(observabilityConfig)
    ) {
      neurolinkConfig.observability = observabilityConfig;
    }

    return new NeuroLink(neurolinkConfig);
  }

  /**
   * Ensure orchestrator is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Handle dry run mode
   */
  private handleDryRun(
    request: LearnRequest,
    learnings: ExtractedLearning[],
  ): LearnResult {
    console.log("\n📋 DRY RUN - Extracted learnings preview:\n");

    if (request.outputFormat === "json") {
      console.log(
        JSON.stringify(
          {
            prId: request.pullRequestId,
            learningsFound: learnings.length,
            learnings: learnings.map((l) => ({
              category: l.category,
              subcategory: l.subcategory,
              learning: l.learning,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      // Markdown format
      const byCategory = new Map<string, ExtractedLearning[]>();
      for (const learning of learnings) {
        const cat = learning.category;
        if (!byCategory.has(cat)) {
          byCategory.set(cat, []);
        }
        byCategory.get(cat)!.push(learning);
      }

      for (const [category, items] of byCategory) {
        console.log(`## ${category.replace(/_/g, " ").toUpperCase()}`);
        for (const item of items) {
          console.log(`- ${item.learning}`);
        }
        console.log("");
      }

      console.log("─".repeat(60));
      console.log("Run without --dry-run to commit these learnings.");
    }

    return {
      success: true,
      prId: request.pullRequestId,
      learningsFound: learnings.length,
      learningsAdded: 0,
      learningsDuplicate: 0,
      learnings,
    };
  }

  /**
   * Run AI-powered summarization
   */
  private async runSummarization(
    kbManager: KnowledgeBaseManager,
  ): Promise<void> {
    const currentContent = await kbManager.getForPrompt();
    if (!currentContent) {
      return;
    }

    const systemPrompt = await this.promptManager.getSummarizationPrompt();

    const prompt = `
${systemPrompt}

<current-knowledge-base>
${currentContent}
</current-knowledge-base>

Consolidate the learnings as instructed. Return the complete updated knowledge base in markdown format.
`;

    const response = await this.neurolink.generate({
      input: { text: prompt },
      provider: this.config.ai.provider,
      model: this.config.ai.model,
      temperature: 0.2,
      maxTokens: 30000,
    });

    // Parse and update the knowledge base
    const newContent = (response.content || "") as string;

    // Extract markdown content (may be in code block)
    let markdownContent = newContent;
    const mdMatch = newContent.match(/```(?:markdown|md)?\s*([\s\S]*?)```/);
    if (mdMatch) {
      markdownContent = mdMatch[1].trim();
    }

    // Verify it looks like valid markdown KB
    if (markdownContent.includes("# Project Knowledge Base")) {
      // Write the summarized content directly to file
      await kbManager.writeRaw(markdownContent);
    }
  }

  /**
   * Create empty result for cases with no learnings
   */
  private createEmptyResult(
    request: LearnRequest,
    reason: string,
  ): LearnResult {
    console.log(`\n⚠️ ${reason}\n`);
    return {
      success: true,
      prId: request.pullRequestId,
      learningsFound: 0,
      learningsAdded: 0,
      learningsDuplicate: 0,
      learnings: [],
    };
  }

  /**
   * Log the final result
   */
  private logResult(result: LearnResult): void {
    console.log("\n" + "═".repeat(60));
    console.log("✅ Learning Extraction Complete");
    console.log("═".repeat(60));
    console.log(`   PR: #${result.prId}`);
    console.log(`   Learnings found: ${result.learningsFound}`);
    console.log(`   Learnings added: ${result.learningsAdded}`);
    console.log(`   Duplicates skipped: ${result.learningsDuplicate}`);
    if (result.knowledgeBasePath) {
      console.log(`   Knowledge base: ${result.knowledgeBasePath}`);
    }
    if (result.committed) {
      console.log(`   📤 Changes committed`);
    }
    if (result.summarized) {
      console.log(`   🔄 Knowledge base summarized`);
    }
    console.log("═".repeat(60) + "\n");
  }
}

/**
 * Factory function to create LearningOrchestrator
 */
export function createLearningOrchestrator(): LearningOrchestrator {
  return new LearningOrchestrator();
}
