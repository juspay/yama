/**
 * Comprehensive unit tests for Guardian main class
 * Tests orchestration, initialization, PR processing, streaming, and all core functionality
 */

import { Guardian, createGuardian, guardian } from "../../src/core/Guardian";
import { BitbucketProvider } from "../../src/core/providers/BitbucketProvider";
import { ContextGatherer } from "../../src/core/ContextGatherer";
import { CodeReviewer } from "../../src/features/CodeReviewer";
import { DescriptionEnhancer } from "../../src/features/DescriptionEnhancer";
import { logger } from "../../src/utils/Logger";
import { configManager } from "../../src/utils/ConfigManager";
import { cache } from "../../src/utils/Cache";
import {
  GuardianConfig,
  OperationOptions,
  ReviewOptions,
  EnhancementOptions,
} from "../../src/types";

// Mock NeuroLink
const mockNeurolink = {
  generate: jest.fn(),
};

// Mock dynamic import for NeuroLink
global.eval = jest.fn().mockReturnValue(
  jest.fn().mockResolvedValue({
    NeuroLink: jest.fn().mockImplementation(() => mockNeurolink),
  }),
);

// Mock all dependencies
jest.mock("../../src/core/providers/BitbucketProvider");
jest.mock("../../src/core/ContextGatherer");
jest.mock("../../src/features/CodeReviewer");
jest.mock("../../src/features/DescriptionEnhancer");
jest.mock("../../src/utils/Logger");
jest.mock("../../src/utils/ConfigManager");
jest.mock("../../src/utils/Cache");

describe("Guardian", () => {
  let guardianInstance: Guardian;
  let mockBitbucketProvider: jest.Mocked<BitbucketProvider>;
  let mockContextGatherer: jest.Mocked<ContextGatherer>;
  let mockCodeReviewer: jest.Mocked<CodeReviewer>;
  let mockDescriptionEnhancer: jest.Mocked<DescriptionEnhancer>;
  let mockConfig: GuardianConfig;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock config
    mockConfig = {
      providers: {
        git: {
          credentials: {
            username: "test-user",
            token: "test-token",
            baseUrl: "https://test-bitbucket.com",
          },
        },
        ai: {
          provider: "google-ai",
          model: "gemini-2.5-pro",
          enableAnalytics: true,
          enableFallback: true,
          timeout: "5m",
          temperature: 0.3,
          maxTokens: 1000000,
        },
      },
      features: {
        codeReview: {
          enabled: true,
          severityLevels: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
          categories: [
            "security",
            "performance",
            "maintainability",
            "functionality",
            "error_handling",
            "testing",
          ],
          excludePatterns: ["*.lock", "*.min.js"],
          contextLines: 3,
          systemPrompt: "Test system prompt",
          focusAreas: ["🔒 Security Analysis", "⚡ Performance Review"],
        },
        descriptionEnhancement: {
          enabled: true,
          preserveContent: true,
          requiredSections: [
            {
              key: "changelog",
              name: "Changelog (Modules Modified)",
              required: true,
            },
          ],
          autoFormat: true,
          systemPrompt: "Test enhancement system prompt",
          outputTemplate: "# Test Template",
          enhancementInstructions: "Test instructions",
        },
      },
      cache: {
        enabled: true,
      },
    } as GuardianConfig;

    // Setup mock providers
    mockBitbucketProvider = {
      initialize: jest.fn(),
      healthCheck: jest.fn(),
      getStats: jest.fn(),
      clearCache: jest.fn(),
    } as any;

    mockContextGatherer = {
      gatherContext: jest.fn(),
      getCachedContext: jest.fn(),
      getStats: jest.fn(),
    } as any;

    mockCodeReviewer = {
      reviewCodeWithContext: jest.fn(),
    } as any;

    mockDescriptionEnhancer = {
      enhanceWithContext: jest.fn(),
    } as any;

    // Setup constructor mocks
    (BitbucketProvider as jest.Mock).mockImplementation(
      () => mockBitbucketProvider,
    );
    (ContextGatherer as jest.Mock).mockImplementation(
      () => mockContextGatherer,
    );
    (CodeReviewer as jest.Mock).mockImplementation(() => mockCodeReviewer);
    (DescriptionEnhancer as jest.Mock).mockImplementation(
      () => mockDescriptionEnhancer,
    );

    // Setup utility mocks
    (configManager.loadConfig as jest.Mock).mockResolvedValue(mockConfig);
    (logger.badge as jest.Mock).mockImplementation(() => {});
    (logger.phase as jest.Mock).mockImplementation(() => {});
    (logger.success as jest.Mock).mockImplementation(() => {});
    (logger.error as jest.Mock).mockImplementation(() => {});
    (logger.info as jest.Mock).mockImplementation(() => {});
    (logger.debug as jest.Mock).mockImplementation(() => {});
    (logger.operation as jest.Mock).mockImplementation(() => {});
    (logger.getConfig as jest.Mock).mockReturnValue({ verbose: false });
    (cache.stats as jest.Mock).mockReturnValue({ keys: 0, hits: 0, misses: 0 });
    (cache.clear as jest.Mock).mockImplementation(() => {});

    guardianInstance = new Guardian();
  });

  describe("Constructor and Factory", () => {
    it("should create Guardian instance", () => {
      expect(guardianInstance).toBeDefined();
      expect(guardianInstance).toBeInstanceOf(Guardian);
    });

    it("should create Guardian with partial config", () => {
      const partialConfig: Partial<GuardianConfig> = {
        cache: {
          enabled: false,
          ttl: "30m",
          maxSize: "100MB",
          storage: "memory",
        },
      };

      const guardian = new Guardian(partialConfig);
      expect(guardian).toBeDefined();
    });

    it("should create Guardian using factory function", () => {
      const guardian = createGuardian();
      expect(guardian).toBeDefined();
      expect(guardian).toBeInstanceOf(Guardian);
    });

    it("should provide default exported instance", () => {
      expect(guardian).toBeDefined();
      expect(guardian).toBeInstanceOf(Guardian);
    });
  });

  describe("initialize", () => {
    it("should initialize Guardian successfully", async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();

      await guardianInstance.initialize();

      expect(configManager.loadConfig).toHaveBeenCalled();
      expect(BitbucketProvider).toHaveBeenCalledWith(
        mockConfig.providers.git.credentials,
      );
      expect(mockBitbucketProvider.initialize).toHaveBeenCalled();
      expect(ContextGatherer).toHaveBeenCalledWith(
        mockBitbucketProvider,
        mockConfig.providers.ai,
        expect.objectContaining({
          enabled: true,
          path: "memory-bank",
          fallbackPaths: expect.arrayContaining([
            "docs/memory-bank",
            ".memory-bank",
          ]),
        }),
      );
      expect(CodeReviewer).toHaveBeenCalledWith(
        mockBitbucketProvider,
        mockConfig.providers.ai,
        mockConfig.features.codeReview,
      );
      expect(DescriptionEnhancer).toHaveBeenCalledWith(
        mockBitbucketProvider,
        mockConfig.providers.ai,
        mockConfig.features.descriptionEnhancement,
      );
      expect(logger.badge).toHaveBeenCalled();
      expect(logger.phase).toHaveBeenCalledWith("🚀 Initializing Yama...");
      expect(logger.success).toHaveBeenCalledWith(
        "✅ Yama initialized successfully",
      );
    });

    it("should skip initialization if already initialized", async () => {
      await guardianInstance.initialize();
      jest.clearAllMocks();

      await guardianInstance.initialize();

      expect(configManager.loadConfig).not.toHaveBeenCalled();
    });

    it("should handle initialization errors", async () => {
      const initError = new Error("Initialization failed");
      mockBitbucketProvider.initialize.mockRejectedValue(initError);

      await expect(guardianInstance.initialize()).rejects.toThrow(
        "Initialization failed: Initialization failed",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to initialize Yama: Initialization failed",
      );
    });

    it("should initialize with custom config path", async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();

      await guardianInstance.initialize("/custom/config.yml");

      expect(configManager.loadConfig).toHaveBeenCalledWith(
        "/custom/config.yml",
      );
    });
  });

  describe("processPR", () => {
    const mockOptions: OperationOptions = {
      workspace: "test-workspace",
      repository: "test-repo",
      branch: "feature/test",
      operations: ["review", "enhance-description"],
      dryRun: false,
    };

    const mockContext = {
      pr: globalThis.testUtils.createMockPR({
        id: 12345,
        title: "Test PR",
      }),
      identifier: {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
      },
      diffStrategy: {
        strategy: "whole",
        fileCount: 3,
      },
    };

    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should process PR with multiple operations successfully", async () => {
      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: ["Good code structure"],
        statistics: {
          filesReviewed: 3,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });
      mockDescriptionEnhancer.enhanceWithContext.mockResolvedValue({
        originalDescription: "Test PR",
        enhancedDescription: "Enhanced description",
        sectionsAdded: ["Changelog"],
        sectionsEnhanced: [],
        preservedItems: { media: 0, files: 0, links: 0 },
        statistics: {
          originalLength: 7,
          enhancedLength: 20,
          completedSections: 1,
          totalSections: 1,
        },
      });

      const result = await guardianInstance.processPR(mockOptions);

      expect(result).toEqual({
        pullRequest: mockContext.pr,
        operations: [
          {
            operation: "review",
            status: "success",
            data: {
              violations: [],
              summary: "No issues found",
              positiveObservations: ["Good code structure"],
              statistics: {
                filesReviewed: 3,
                totalIssues: 0,
                criticalCount: 0,
                majorCount: 0,
                minorCount: 0,
                suggestionCount: 0,
              },
            },
            duration: expect.any(Number),
            timestamp: expect.any(String),
          },
          {
            operation: "enhance-description",
            status: "success",
            data: {
              originalDescription: "Test PR",
              enhancedDescription: "Enhanced description",
              sectionsAdded: ["Changelog"],
              sectionsEnhanced: [],
              preservedItems: { media: 0, files: 0, links: 0 },
              statistics: {
                originalLength: 7,
                enhancedLength: 20,
                completedSections: 1,
                totalSections: 1,
              },
            },
            duration: expect.any(Number),
            timestamp: expect.any(String),
          },
        ],
        summary: {
          totalOperations: 2,
          successCount: 2,
          errorCount: 0,
          skippedCount: 0,
          totalDuration: expect.any(Number),
        },
      });

      expect(logger.operation).toHaveBeenCalledWith("PR Processing", "started");
      expect(logger.operation).toHaveBeenCalledWith(
        "PR Processing",
        "completed",
      );
      expect(logger.phase).toHaveBeenCalledWith(
        "📋 Gathering unified context...",
      );
    });

    it('should handle "all" operation type', async () => {
      const optionsWithAll = { ...mockOptions, operations: ["all"] as any };

      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 2,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });
      mockDescriptionEnhancer.enhanceWithContext.mockResolvedValue({
        originalDescription: "Original",
        enhancedDescription: "Enhanced",
        sectionsAdded: ["Changelog"],
        sectionsEnhanced: [],
        preservedItems: { media: 0, files: 0, links: 0 },
        statistics: {
          originalLength: 8,
          enhancedLength: 8,
          completedSections: 1,
          totalSections: 1,
        },
      });

      const result = await guardianInstance.processPR(optionsWithAll);

      expect(result.operations).toHaveLength(2);
      expect(result.operations[0].operation).toBe("review");
      expect(result.operations[1].operation).toBe("enhance-description");
    });

    it("should use cached context when available", async () => {
      const fullMockContext = {
        ...mockContext,
        pr: globalThis.testUtils.createMockPR({ id: 12345, title: "Test PR" }),
        diffStrategy: { fileCount: 2, strategy: "whole" },
        // Ensure all required properties are present
        projectContext: {
          memoryBank: { summary: "Test context" },
          clinerules: "Test rules",
          filesProcessed: 1,
        },
      };
      mockContextGatherer.getCachedContext.mockResolvedValue(
        fullMockContext as any,
      );
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 1,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });

      await guardianInstance.processPR({
        ...mockOptions,
        operations: ["review"],
      });

      expect(mockContextGatherer.getCachedContext).toHaveBeenCalled();
      expect(mockContextGatherer.gatherContext).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith("✓ Using cached context");
    });

    it("should handle operation failures gracefully", async () => {
      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockRejectedValue(
        new Error("Review failed"),
      );

      const result = await guardianInstance.processPR({
        ...mockOptions,
        operations: ["review"],
      });

      expect(result.operations[0]).toEqual({
        operation: "review",
        status: "error",
        error: "Review failed",
        duration: expect.any(Number),
        timestamp: expect.any(String),
      });
      expect(result.summary.errorCount).toBe(1);
    });

    it("should handle uninitialized Guardian", async () => {
      const uninitializedGuardian = new Guardian();
      mockBitbucketProvider.initialize.mockResolvedValue();

      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 1,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });

      await uninitializedGuardian.processPR({
        ...mockOptions,
        operations: ["review"],
      });

      expect(configManager.loadConfig).toHaveBeenCalled();
    });

    it("should handle dry run mode", async () => {
      const dryRunOptions = { ...mockOptions, dryRun: true };

      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 1,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });

      await guardianInstance.processPR(dryRunOptions);

      expect(logger.info).toHaveBeenCalledWith("Mode: DRY RUN");
    });
  });

  describe("processPRStream", () => {
    const mockOptions: OperationOptions = {
      workspace: "test-workspace",
      repository: "test-repo",
      branch: "feature/test",
      pullRequestId: 12345,
      operations: ["review"],
      dryRun: false,
    };

    const mockContext = {
      pr: globalThis.testUtils.createMockPR({ id: 12345, title: "Test PR" }),
      identifier: {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
      },
    };

    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should stream PR processing updates", async () => {
      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 1,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });

      const updates: any[] = [];
      for await (const update of guardianInstance.processPRStream(
        mockOptions,
      )) {
        updates.push(update);
      }

      expect(updates).toHaveLength(6);
      expect(updates[0]).toEqual({
        operation: "all",
        status: "started",
        message: "Yama processing initiated",
        timestamp: expect.any(String),
      });
      expect(updates[1]).toMatchObject({
        operation: "all",
        status: "progress",
        progress: 10,
        message: "Gathering unified context...",
      });
      expect(updates[2]).toMatchObject({
        operation: "all",
        status: "progress",
        progress: 30,
        message: "Context ready: PR #12345",
      });
      expect(updates[3]).toMatchObject({
        operation: "review",
        status: "started",
        message: "Starting review...",
      });
      expect(updates[4]).toMatchObject({
        operation: "review",
        status: "completed",
        progress: 90,
        message: "review completed",
      });
      expect(updates[5]).toMatchObject({
        operation: "all",
        status: "completed",
        progress: 100,
        message: expect.stringContaining("Processing completed"),
      });
    });

    it("should handle streaming operation failures", async () => {
      // Initialize Guardian properly like the working test
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();

      const fullMockContext = {
        ...mockContext,
        pr: globalThis.testUtils.createMockPR({ id: 12345, title: "Test PR" }),
        identifier: {
          workspace: "test-workspace",
          repository: "test-repo",
          pullRequestId: 12345,
        },
        diffStrategy: { fileCount: 2, strategy: "whole" },
      };
      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue(
        fullMockContext as any,
      );
      mockCodeReviewer.reviewCodeWithContext.mockRejectedValue(
        new Error("Review failed"),
      );

      const updates: any[] = [];
      for await (const update of guardianInstance.processPRStream(
        mockOptions,
      )) {
        updates.push(update);
      }

      const errorUpdate = updates.find(
        (u) => u.status === "error" && u.operation === "review",
      );
      expect(errorUpdate).toMatchObject({
        operation: "review",
        status: "error",
        message: "review failed: Review failed",
      });
    });

    it("should handle streaming processing failures", async () => {
      mockContextGatherer.getCachedContext.mockRejectedValue(
        new Error("Context failed"),
      );

      const updates: any[] = [];
      for await (const update of guardianInstance.processPRStream(
        mockOptions,
      )) {
        updates.push(update);
      }

      const finalUpdate = updates[updates.length - 1];
      expect(finalUpdate).toMatchObject({
        operation: "all",
        status: "error",
        message: "Processing failed: Context failed",
      });
    });
  });

  describe("Individual Operations", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    describe("reviewCode", () => {
      const mockReviewOptions: ReviewOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
        dryRun: false,
        verbose: false,
      };

      it("should execute code review successfully", async () => {
        const mockContext = { pr: globalThis.testUtils.createMockPR() };
        const mockReviewResult = {
          violations: [],
          summary: "No issues found",
          positiveObservations: ["Good code structure"],
          statistics: {
            filesReviewed: 2,
            totalIssues: 0,
            criticalCount: 0,
            majorCount: 0,
            minorCount: 0,
            suggestionCount: 0,
          },
        };

        mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
        mockCodeReviewer.reviewCodeWithContext.mockResolvedValue(
          mockReviewResult,
        );

        const result = await guardianInstance.reviewCode(mockReviewOptions);

        expect(result).toEqual(mockReviewResult);
        expect(mockContextGatherer.gatherContext).toHaveBeenCalledWith(
          {
            workspace: "test-workspace",
            repository: "test-repo",
            branch: undefined,
            pullRequestId: 12345,
          },
          {
            excludePatterns: undefined,
            contextLines: undefined,
            includeDiff: true,
          },
        );
        expect(logger.operation).toHaveBeenCalledWith("Code Review", "started");
        expect(logger.operation).toHaveBeenCalledWith(
          "Code Review",
          "completed",
        );
      });

      it("should handle review failures", async () => {
        mockContextGatherer.gatherContext.mockRejectedValue(
          new Error("Context failed"),
        );

        await expect(
          guardianInstance.reviewCode(mockReviewOptions),
        ).rejects.toThrow("Context failed");
        expect(logger.operation).toHaveBeenCalledWith("Code Review", "failed");
      });
    });

    describe("enhanceDescription", () => {
      const mockEnhancementOptions: EnhancementOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
        dryRun: false,
        verbose: false,
      };

      it("should execute description enhancement successfully", async () => {
        const mockContext = { pr: globalThis.testUtils.createMockPR() };
        const mockEnhancementResult = {
          originalDescription: "Original",
          enhancedDescription: "Enhanced",
          sectionsAdded: ["Changelog"],
          sectionsEnhanced: [],
          preservedItems: { media: 0, files: 0, links: 0 },
          statistics: {
            originalLength: 8,
            enhancedLength: 8,
            completedSections: 1,
            totalSections: 1,
          },
        };

        mockContextGatherer.gatherContext.mockResolvedValue(mockContext as any);
        mockDescriptionEnhancer.enhanceWithContext.mockResolvedValue(
          mockEnhancementResult,
        );

        const result = await guardianInstance.enhanceDescription(
          mockEnhancementOptions,
        );

        expect(result).toEqual(mockEnhancementResult);
        expect(logger.operation).toHaveBeenCalledWith(
          "Description Enhancement",
          "started",
        );
        expect(logger.operation).toHaveBeenCalledWith(
          "Description Enhancement",
          "completed",
        );
      });

      it("should handle enhancement failures", async () => {
        mockContextGatherer.gatherContext.mockRejectedValue(
          new Error("Context failed"),
        );

        await expect(
          guardianInstance.enhanceDescription(mockEnhancementOptions),
        ).rejects.toThrow("Context failed");
        expect(logger.operation).toHaveBeenCalledWith(
          "Description Enhancement",
          "failed",
        );
      });
    });
  });

  describe("Feature Disabled Handling", () => {
    beforeEach(async () => {
      const disabledConfig = {
        ...mockConfig,
        features: {
          codeReview: {
            enabled: false,
            severityLevels: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
            categories: [
              "security",
              "performance",
              "maintainability",
              "functionality",
              "error_handling",
              "testing",
            ],
            excludePatterns: ["*.lock", "*.min.js"],
            contextLines: 3,
            systemPrompt: "Test system prompt",
            focusAreas: ["🔒 Security Analysis", "⚡ Performance Review"],
          },
          descriptionEnhancement: {
            enabled: false,
            preserveContent: true,
            requiredSections: [
              {
                key: "changelog",
                name: "Changelog (Modules Modified)",
                required: true,
              },
            ],
            autoFormat: true,
            systemPrompt: "Test enhancement system prompt",
            outputTemplate: "# Test Template",
            enhancementInstructions: "Test instructions",
          },
        },
      };
      (configManager.loadConfig as jest.Mock).mockResolvedValue(disabledConfig);
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should skip disabled code review", async () => {
      const mockContext = { identifier: { pullRequestId: 12345 } };

      const result = await (guardianInstance as any).executeCodeReview(
        mockContext,
        {},
      );

      expect(result).toEqual({ skipped: true, reason: "disabled in config" });
      expect(logger.info).toHaveBeenCalledWith(
        "Code review is disabled in configuration",
      );
    });

    it("should skip disabled description enhancement", async () => {
      const mockContext = { identifier: { pullRequestId: 12345 } };

      const result = await (
        guardianInstance as any
      ).executeDescriptionEnhancement(mockContext, {});

      expect(result).toEqual({ skipped: true, reason: "disabled in config" });
      expect(logger.info).toHaveBeenCalledWith(
        "Description enhancement is disabled in configuration",
      );
    });
  });

  describe("Unknown Operations", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should handle security-scan operation (not implemented)", async () => {
      const mockContext = { identifier: { pullRequestId: 12345 } };

      const result = await (guardianInstance as any).executeOperation(
        "security-scan",
        mockContext,
        {},
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Security scan not implemented in Phase 1");
    });

    it("should handle analytics operation (not implemented)", async () => {
      const mockContext = { identifier: { pullRequestId: 12345 } };

      const result = await (guardianInstance as any).executeOperation(
        "analytics",
        mockContext,
        {},
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Analytics not implemented in Phase 1");
    });

    it("should handle unknown operation", async () => {
      const mockContext = { identifier: { pullRequestId: 12345 } };

      const result = await (guardianInstance as any).executeOperation(
        "unknown-op",
        mockContext,
        {},
      );

      expect(result.status).toBe("error");
      expect(result.error).toBe("Unknown operation: unknown-op");
    });
  });

  describe("healthCheck", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should return healthy status when all components are healthy", async () => {
      mockBitbucketProvider.healthCheck.mockResolvedValue({
        healthy: true,
        details: { status: "ok" },
      });

      const result = await guardianInstance.healthCheck();

      expect(result).toEqual({
        healthy: true,
        components: {
          bitbucket: { healthy: true, details: { status: "ok" } },
          cache: {
            healthy: true,
            stats: { keys: 0, hits: 0, misses: 0 },
          },
          neurolink: {
            healthy: true,
            initialized: true,
          },
        },
      });
    });

    it("should return unhealthy status when component fails", async () => {
      mockBitbucketProvider.healthCheck.mockResolvedValue({
        healthy: false,
        details: { error: "Connection failed" },
      });

      const result = await guardianInstance.healthCheck();

      expect(result.healthy).toBe(false);
    });

    it("should handle health check errors", async () => {
      mockBitbucketProvider.healthCheck.mockRejectedValue(
        new Error("Health check failed"),
      );

      const result = await guardianInstance.healthCheck();

      expect(result).toEqual({
        healthy: false,
        components: {
          error: "Health check failed",
        },
      });
    });
  });

  describe("getStats", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      mockBitbucketProvider.getStats.mockReturnValue({ provider: "bitbucket" });
      mockContextGatherer.getStats.mockReturnValue({ gatherer: "stats" });
      await guardianInstance.initialize();
    });

    it("should return comprehensive statistics", () => {
      const stats = guardianInstance.getStats();

      expect(stats).toEqual({
        initialized: true,
        config: {
          features: ["codeReview", "descriptionEnhancement"],
          cacheEnabled: true,
        },
        providers: {
          bitbucket: { provider: "bitbucket" },
          context: { gatherer: "stats" },
        },
        cache: { keys: 0, hits: 0, misses: 0 },
      });
    });

    it("should handle uninitialized state", () => {
      const uninitializedGuardian = new Guardian();
      const stats = uninitializedGuardian.getStats();

      expect(stats.initialized).toBe(false);
      expect(stats.providers.bitbucket).toBeUndefined();
    });
  });

  describe("clearCache", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should clear all caches", () => {
      guardianInstance.clearCache();

      expect(cache.clear).toHaveBeenCalled();
      expect(mockBitbucketProvider.clearCache).toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("All caches cleared");
    });
  });

  describe("shutdown", () => {
    beforeEach(async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();
    });

    it("should shutdown gracefully", async () => {
      await guardianInstance.shutdown();

      expect(logger.info).toHaveBeenCalledWith("Shutting down Yama...");
      expect(cache.clear).toHaveBeenCalled();
      expect(logger.success).toHaveBeenCalledWith("Yama shutdown complete");
    });

    it("should reset initialization state after shutdown", async () => {
      await guardianInstance.shutdown();

      const stats = guardianInstance.getStats();
      expect(stats.initialized).toBe(false);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle missing pullRequestId in context identifier", async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();

      const mockContext = {
        identifier: {
          workspace: "test",
          repository: "test",
          pullRequestId: 123,
        },
        pr: globalThis.testUtils.createMockPR(),
      };

      // Mock the code reviewer to return a result
      mockCodeReviewer.reviewCodeWithContext.mockResolvedValue({
        violations: [],
        summary: "No issues found",
        positiveObservations: [],
        statistics: {
          filesReviewed: 1,
          totalIssues: 0,
          criticalCount: 0,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      });

      const result = await (guardianInstance as any).executeCodeReview(
        mockContext,
        {},
      );

      expect(typeof result).toBe("object");
      expect(result.violations).toBeDefined();
    });

    it("should handle context gathering with diff requirements", async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();

      const options: OperationOptions = {
        workspace: "test",
        repository: "test",
        operations: ["review", "enhance-description"],
        dryRun: false,
      };

      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue({
        pr: globalThis.testUtils.createMockPR(),
        identifier: { pullRequestId: 12345 },
      } as any);

      // Mock the private method call
      const context = await (guardianInstance as any).gatherUnifiedContext(
        options,
      );

      expect(mockContextGatherer.gatherContext).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          includeDiff: true, // Should be true because review is included
        }),
      );
    });

    it("should handle context gathering without diff requirements", async () => {
      mockBitbucketProvider.initialize.mockResolvedValue();
      await guardianInstance.initialize();

      const options: OperationOptions = {
        workspace: "test",
        repository: "test",
        operations: ["analytics"], // Operation that doesn't need diff
        dryRun: false,
      };

      mockContextGatherer.getCachedContext.mockResolvedValue(null);
      mockContextGatherer.gatherContext.mockResolvedValue({
        pr: globalThis.testUtils.createMockPR(),
        identifier: { pullRequestId: 12345 },
      } as any);

      const context = await (guardianInstance as any).gatherUnifiedContext(
        options,
      );

      expect(mockContextGatherer.gatherContext).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          includeDiff: false, // Should be false for analytics
        }),
      );
    });
  });
});
