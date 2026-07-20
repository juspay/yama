/**
 * Unit tests for V2 Prompt System
 * Tests the new XML-based prompt architecture
 */

import { describe, it, expect } from "@jest/globals";
import { REVIEW_SYSTEM_PROMPT } from "../../../src/v2/prompts/ReviewSystemPrompt.js";
import { ENHANCEMENT_SYSTEM_PROMPT } from "../../../src/v2/prompts/EnhancementSystemPrompt.js";
import { PromptBuilder } from "../../../src/v2/prompts/PromptBuilder.js";
import { YamaConfig } from "../../../src/v2/types/index.js";
import { ReviewRequest } from "../../../src/v2/types/index.js";

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

  it("should contain a role section describing the reviewer", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<role>");
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toContain(
      "autonomous code review agent",
    );
  });

  it("should contain the core method rules (standards-first, verify, file-by-file, actionable)", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<method>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("STANDARDS FIRST");
    expect(REVIEW_SYSTEM_PROMPT).toContain("VERIFY BEFORE YOU CLAIM");
    expect(REVIEW_SYSTEM_PROMPT).toContain("FILE BY FILE");
    expect(REVIEW_SYSTEM_PROMPT).toContain("BE ACTIONABLE");
  });

  it("should NOT hardcode any provider/MCP tool names — the agent uses whatever tools it is given", () => {
    // The whole point of the config-driven redesign: no tool vocabulary is
    // baked into the prompt. It must instruct the agent to discover and use the
    // tools it actually has, never name specific ones.
    for (const toolName of [
      "get_pull_request",
      "get_pull_request_diff",
      "search_code",
      "add_comment",
      "set_pr_approval",
      "set_review_status",
      "pull_request_read",
      "push_files",
    ]) {
      expect(REVIEW_SYSTEM_PROMPT).not.toContain(toolName);
    }
    expect(REVIEW_SYSTEM_PROMPT).toContain("USE THE TOOLS YOU HAVE");
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toContain(
      "only tools that actually exist",
    );
  });

  it("should gate explore_context behind the strippable EXPLORE markers", () => {
    // explore_context is the ONE agent-internal tool the prompt may reference,
    // and only inside EXPLORE markers so it disappears when explore is disabled.
    expect(REVIEW_SYSTEM_PROMPT).toContain("explore_context");
    const exploreIdx = REVIEW_SYSTEM_PROMPT.indexOf("explore_context");
    const beginIdx = REVIEW_SYSTEM_PROMPT.lastIndexOf(
      "<!-- EXPLORE_BEGIN -->",
      exploreIdx,
    );
    const endIdx = REVIEW_SYSTEM_PROMPT.indexOf(
      "<!-- EXPLORE_END -->",
      beginIdx,
    );
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(exploreIdx);
  });

  it("should contain severity levels", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<severity>");
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="CRITICAL"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="MAJOR"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="MINOR"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('name="SUGGESTION"');
  });

  it("should define the structured-JSON output contract", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<output>");
    expect(REVIEW_SYSTEM_PROMPT).toContain('"decision"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('"issues"');
    expect(REVIEW_SYSTEM_PROMPT).toContain('"severity"');
  });

  it("should contain anti-patterns that forbid unverified comments and invented tools", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("<anti-patterns>");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Invent tool names");
    expect(REVIEW_SYSTEM_PROMPT.toLowerCase()).toContain(
      "code you have not verified",
    );
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
        servers: {},
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
        null,
      );

      expect(result).toContain("<yama-review-system>");
      expect(result.toLowerCase()).toContain("autonomous code review agent");
    });

    it("should include project configuration in XML", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
      );

      expect(result).toContain("<project-configuration>");
      expect(result).toContain("<workflow-instructions>");
      expect(result).toContain("<focus-areas>");
      expect(result).toContain("<blocking-criteria>");
    });

    it("should include a generic review task with the PR identifier", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
      );

      expect(result).toContain("<review-task>");
      // Provider-agnostic identifier: owner/workspace + repo joined into a slug,
      // never provider-specific <workspace>/<pull_request_id> tags.
      expect(result).toContain(
        "<repository>test-workspace/test-repo</repository>",
      );
      expect(result).toContain("<id>123</id>");
      expect(result).not.toContain("<workspace>");
      expect(result).not.toContain("<pull_request_id>");
    });

    it("should escape XML special characters in config", async () => {
      mockConfig.review.workflowInstructions =
        'Test with <special> & "characters"';
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
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
        null,
      );

      expect(result).toContain("<mode>dry-run</mode>");
      expect(result).toContain("DRY-RUN:");
    });

    it("should indicate live mode in task", async () => {
      mockRequest.dryRun = false;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
      );

      expect(result).toContain("<mode>live</mode>");
      expect(result).toContain("LIVE:");
    });

    it("should carry the standards-first / file-by-file method into the prompt", async () => {
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
      );

      // The method now lives in the system prompt; the task references it.
      expect(result).toContain("STANDARDS FIRST");
      expect(result).toContain("FILE BY FILE");
      expect(result).toContain("one changed file at a time");
      // Ordering invariant — the method must render before the review task.
      expect(result.indexOf("STANDARDS FIRST")).toBeLessThan(
        result.indexOf("<review-task>"),
      );
    });

    it("should reference explore_context when explore is enabled", async () => {
      mockConfig.ai.explore.enabled = true;
      const result = await builder.buildReviewInstructions(
        mockRequest,
        mockConfig,
        null,
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
        null,
      );

      // The only explore_context reference lives inside EXPLORE markers, so it
      // disappears entirely when explore is disabled.
      expect(result).not.toContain("explore_context");
      // Markers themselves must always be stripped.
      expect(result).not.toContain("EXPLORE_BEGIN");
      expect(result).not.toContain("EXPLORE_END");
      expect(result).not.toContain("EXPLORE_DISABLED_BEGIN");
      expect(result).not.toContain("EXPLORE_DISABLED_END");
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
      expect(result).toContain(
        "<repository>test-workspace/test-repo</repository>",
      );
    });
  });
});
