/**
 * Unit tests for V2 Prompt System
 * Tests the new XML-based prompt architecture
 */

import { describe, it, expect } from "@jest/globals";
import { REVIEW_SYSTEM_PROMPT } from "../../../src/v2/prompts/ReviewSystemPrompt.js";
import { ENHANCEMENT_SYSTEM_PROMPT } from "../../../src/v2/prompts/EnhancementSystemPrompt.js";
import { PromptBuilder } from "../../../src/v2/prompts/PromptBuilder.js";
import { YamaConfig } from "../../../src/v2/types/config.types.js";
import { ReviewRequest } from "../../../src/v2/types/v2.types.js";

describe("Review System Prompt", () => {
  it("should export a non-empty string", () => {
    expect(REVIEW_SYSTEM_PROMPT).toBeDefined();
    expect(typeof REVIEW_SYSTEM_PROMPT).toBe("string");
    expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("should stay tight — guard against drift back to the long prompt", () => {
    // The slimmed prompt is ~75 lines of content. Cap at 110 so trivial
    // additions don't silently regrow it back toward the old ~295-line version.
    const lineCount = REVIEW_SYSTEM_PROMPT.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(110);
  });

  it("should contain core XML structure", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<yama-review-system>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("</yama-review-system>");
  });

  it("should contain identity section", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<identity>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("<role>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Autonomous Code Review Agent");
  });

  it("should contain core rules including the new standards-first and file-by-file rules", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<core-rules>");
    expect(REVIEW_SYSTEM_PROMPT).toContain('id="standards-first"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('id="verify-before-comment"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('id="file-by-file"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('id="accurate-commenting"');
  });

  it("should contain tool usage instructions for the tools the agent actually uses", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<tool-usage>");
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="get_pull_request">');
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      '<tool name="get_pull_request_diff">',
    );
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="search_code">');
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="explore_context">');
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="add_comment">');
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="set_pr_approval">');
    expect(REVIEW_SYSTEM_PROMPT).toContain('<tool name="set_review_status">');
  });

  it("should describe explore_context with use-when / do-not-use-when guidance", () => {
    // The whole point of the rewrite — the model needs a clear decision rule.
    const exploreBlockMatch = REVIEW_SYSTEM_PROMPT.match(
      /<tool name="explore_context">[\s\S]*?<\/tool>/,
    );
    expect(exploreBlockMatch).not.toBeNull();
    const block = exploreBlockMatch![0];
    expect(block).toContain("<use-when>");
    expect(block).toContain("<do-not-use-when>");
    expect(block).toMatch(/example positive/);
    expect(block).toMatch(/example negative/);
  });

  it("should contain severity levels", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<severity-levels>");
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="CRITICAL"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="MAJOR"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="MINOR"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="SUGGESTION"');
  });

  it("should contain anti-patterns", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<anti-patterns>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("lazy loading");
    expect(REVIEW_SYSTEM_PROMPT).toContain("code_snippet");
  });

  it("should NOT contain company-specific information", () => {
    const lowercasePrompt = REVIEW_SYSTEM_PROMPT.toLowerCase();
    expect(lowercasePrompt).not.toContain("juspay");
    expect(lowercasePrompt).not.toContain("bitbucket.juspay");
  });
});

describe("Enhancement System Prompt", () => {
  it("should export a non-empty string", () => {
    expect(ENHANCEMENT_SYSTEM_PROMPT).toBeDefined();
    expect(typeof ENHANCEMENT_SYSTEM_PROMPT).toBe("string");
    expect(ENHANCEMENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it("should contain core XML structure", () => {
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("<yama-enhancement-system>");
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("</yama-enhancement-system>");
  });

  it("should contain identity section", () => {
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("<identity>");
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain(
      "Technical Documentation Writer",
    );
  });

  it("should contain core rules", () => {
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("<core-rules>");
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain('id="complete-all-sections"');
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain('id="extract-from-code"');
  });

  it("should contain extraction strategies", () => {
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("<extraction-strategies>");
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("configuration-changes");
    expect(ENHANCEMENT_SYSTEM_PROMPT).toContain("api-modifications");
  });

  it("should NOT contain company-specific information", () => {
    const lowercasePrompt = ENHANCEMENT_SYSTEM_PROMPT.toLowerCase();
    expect(lowercasePrompt).not.toContain("juspay");
    expect(lowercasePrompt).not.toContain("bitbucket.juspay");
  });
});

describe("PromptBuilder", () => {
  let builder: PromptBuilder;
  let mockConfig: YamaConfig;
  let mockRequest: ReviewRequest;

  beforeEach(() => {
    builder = new PromptBuilder();

    mockConfig = {
      version: 2,
      configType: "yama",
      display: {
        showBanner: true,
        streamingMode: false,
        verboseToolCalls: false,
        showAIThinking: false,
      },
      ai: {
        provider: "google-ai",
        model: "gemini-2.5-pro",
        temperature: 0.3,
        maxTokens: 60000,
        enableAnalytics: true,
        enableEvaluation: false,
        timeout: "10m",
        retryAttempts: 3,
        explore: {
          enabled: true,
          provider: "google-ai",
          model: "gemini-2.5-flash",
          temperature: 0.1,
          maxTokens: 32000,
          timeout: "5m",
          cacheResults: true,
        },
        conversationMemory: {
          enabled: true,
          store: "memory",
          maxSessions: 50,
          maxTurnsPerSession: 300,
          enableSummarization: false,
        },
      },
      mcpServers: {
        jira: { enabled: false },
      },
      review: {
        enabled: true,
        workflowInstructions: "Test workflow instructions",
        focusAreas: [
          {
            name: "Security",
            priority: "CRITICAL",
            description: "Security testing",
          },
        ],
        blockingCriteria: [
          {
            condition: "Any critical issue",
            action: "BLOCK",
            reason: "Security",
          },
        ],
        excludePatterns: ["*.lock"],
        contextLines: 3,
        maxFilesPerReview: 100,
        fileAnalysisTimeout: "2m",
        toolPreferences: {
          lazyLoading: true,
          cacheToolResults: true,
          parallelToolCalls: false,
          maxToolCallsPerFile: 20,
          enableCodeSearch: true,
          enableDirectoryListing: true,
        },
      },
      descriptionEnhancement: {
        enabled: true,
        preserveContent: true,
        autoFormat: true,
        instructions: "Test enhancement instructions",
        requiredSections: [
          {
            key: "summary",
            name: "Summary",
            required: true,
            description: "Test summary",
          },
        ],
      },
      memoryBank: {
        enabled: true,
        path: "memory-bank",
        fallbackPaths: ["docs"],
        standardFiles: ["overview.md"],
      },
      projectStandards: {
        customPromptsPath: "",
        additionalFocusAreas: [],
        customBlockingRules: [],
        severityOverrides: {},
      },
      monitoring: {
        enabled: true,
        logToolCalls: true,
        logAIDecisions: true,
        logTokenUsage: true,
        exportFormat: "json",
        exportPath: ".yama/analytics",
      },
      performance: {
        maxReviewDuration: "15m",
        tokenBudget: {
          maxTokensPerReview: 500000,
          warningThreshold: 400000,
        },
        costControls: {
          maxCostPerReview: 2.0,
          warningThreshold: 1.5,
        },
      },
    };

    mockRequest = {
      workspace: "test-workspace",
      repository: "test-repo",
      pullRequestId: 123,
      dryRun: false,
      verbose: false,
    };
  });

  describe("buildReviewInstructions", () => {
    it("should include base system prompt", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<yama-review-system>");
      expect(result).toContain("Autonomous Code Review Agent");
    });

    it("should include project configuration in XML", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<project-configuration>");
      expect(result).toContain("<workflow-instructions>");
      expect(result).toContain("<focus-areas>");
      expect(result).toContain("<blocking-criteria>");
    });

    it("should include review task details", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<review-task>");
      expect(result).toContain("<workspace>test-workspace</workspace>");
      expect(result).toContain("<repository>test-repo</repository>");
      expect(result).toContain("<pull_request_id>123</pull_request_id>");
    });

    it("should escape XML special characters in config", async () => {
      mockConfig.review.workflowInstructions =
        'Test with <special> & "characters"';
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("&lt;special&gt;");
      expect(result).toContain("&amp;");
      expect(result).toContain("&quot;");
    });

    it("should indicate dry-run mode in task", async () => {
      mockRequest.dryRun = true;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<mode>dry-run</mode>");
      expect(result).toContain("DRY RUN MODE");
    });

    it("should indicate live mode in task", async () => {
      mockRequest.dryRun = false;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<mode>live</mode>");
      expect(result).toContain("LIVE MODE");
    });

    it("should follow the standards-first / file-by-file workflow", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("STEP 1 — Read project standards");
      expect(result).toContain("STEP 2 — Read the PR shell");
      expect(result).toContain("STEP 3 — Walk files one at a time");
      expect(result).toContain("STEP 4 — Decision");
      expect(result).toContain("STEP 5 — Summary comment");
      // Ordering invariant — STEP 1 must come before STEP 3 in the rendered prompt.
      expect(result.indexOf("STEP 1")).toBeLessThan(result.indexOf("STEP 3"));
    });

    it("should reference explore_context when explore is enabled", async () => {
      mockConfig.ai.explore.enabled = true;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("explore_context");
      // Markers themselves must always be stripped, regardless of mode.
      expect(result).not.toContain("EXPLORE_BEGIN");
      expect(result).not.toContain("EXPLORE_END");
      expect(result).not.toContain("EXPLORE_DISABLED_BEGIN");
      expect(result).not.toContain("EXPLORE_DISABLED_END");
    });

    it("should strip explore_context references when explore is disabled", async () => {
      mockConfig.ai.explore.enabled = false;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
      );

      // The dedicated tool block and the workflow callouts should be gone.
      expect(result).not.toContain('<tool name="explore_context">');
      // Markers themselves must always be stripped.
      expect(result).not.toContain("EXPLORE_BEGIN");
      expect(result).not.toContain("EXPLORE_END");
      expect(result).not.toContain("EXPLORE_DISABLED_BEGIN");
      expect(result).not.toContain("EXPLORE_DISABLED_END");
      // The fallback wording for the disabled case should be present in the workflow.
      expect(result).toContain("use search_code or get_file_content to verify");
    });
  });

  describe("buildLocalReviewInstructions", () => {
    const localRequest = {
      mode: "local" as const,
      repoPath: "/tmp/repo",
      dryRun: false,
      verbose: false,
    };
    const diffContext = {
      repoPath: "/tmp/repo",
      diffSource: "uncommitted" as const,
      diff: "diff --git a/foo.ts b/foo.ts\n+const x = 1;\n",
      changedFiles: ["foo.ts"],
      additions: 1,
      deletions: 0,
      truncated: false,
    };

    it("should render the standards-first / file-by-file local workflow", async () => {
      const result = await builder.buildLocalReviewInstructions(
        localRequest,
        mockConfig,
        diffContext,
      );

      expect(result).toContain("STANDARDS FIRST");
      expect(result).toContain("WALK FILES ONE AT A TIME");
      expect(result).toContain("VERIFY BEFORE REPORTING");
      expect(result).toContain("BUDGET");
      expect(result).toContain("OUTPUT");
    });

    it("should reference explore_context in local mode when enabled", async () => {
      mockConfig.ai.explore.enabled = true;
      const result = await builder.buildLocalReviewInstructions(
        localRequest,
        mockConfig,
        diffContext,
      );

      expect(result).toContain("explore_context");
      expect(result).not.toContain("EXPLORE_BEGIN");
      expect(result).not.toContain("EXPLORE_DISABLED_BEGIN");
    });

    it("should strip explore_context from local mode when disabled", async () => {
      mockConfig.ai.explore.enabled = false;
      const result = await builder.buildLocalReviewInstructions(
        localRequest,
        mockConfig,
        diffContext,
      );

      expect(result).not.toContain("explore_context");
      expect(result).not.toContain("EXPLORE_BEGIN");
      expect(result).not.toContain("EXPLORE_DISABLED_BEGIN");
      expect(result).toContain("Use bounded local-git/file tools");
    });
  });

  describe("buildDescriptionEnhancementInstructions", () => {
    it("should include base enhancement prompt", async () => {
      const result = await builder.buildDescriptionEnhancementInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<yama-enhancement-system>");
      expect(result).toContain("Technical Documentation Writer");
    });

    it("should include enhancement configuration", async () => {
      const result = await builder.buildDescriptionEnhancementInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<project-configuration>");
      expect(result).toContain("<required-sections>");
      expect(result).toContain('key="summary"');
    });

    it("should include enhancement task details", async () => {
      const result = await builder.buildDescriptionEnhancementInstructions(
        mockRequest,
        mockConfig,
      );

      expect(result).toContain("<enhancement-task>");
      expect(result).toContain("<workspace>test-workspace</workspace>");
    });
  });
});
