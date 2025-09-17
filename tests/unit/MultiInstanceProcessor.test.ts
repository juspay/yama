/**
 * Tests for Multi-Instance Processor
 */

import { MultiInstanceProcessor } from "../../src/features/MultiInstanceProcessor.js";
import { ExactDuplicateRemover } from "../../src/utils/ExactDuplicateRemover.js";
import { BitbucketProvider } from "../../src/core/providers/BitbucketProvider.js";
import { UnifiedContext } from "../../src/core/ContextGatherer.js";
import {
  MultiInstanceConfig,
  CodeReviewConfig,
  ReviewOptions,
  InstanceResult,
  Violation,
} from "../../src/types/index.js";

// Mock dependencies
jest.mock("../../src/core/providers/BitbucketProvider.js");
jest.mock("../../src/utils/ExactDuplicateRemover.js");
jest.mock("../../src/features/CodeReviewer.js");

describe("MultiInstanceProcessor", () => {
  let processor: MultiInstanceProcessor;
  let mockBitbucketProvider: jest.Mocked<BitbucketProvider>;
  let mockCodeReviewConfig: CodeReviewConfig;
  let mockContext: UnifiedContext;
  let mockOptions: ReviewOptions;

  beforeEach(() => {
    // Setup mocks
    mockBitbucketProvider = new BitbucketProvider({
      username: "test",
      token: "test",
    }) as jest.Mocked<BitbucketProvider>;

    mockCodeReviewConfig = {
      enabled: true,
      severityLevels: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
      categories: ["security", "performance", "maintainability"],
      excludePatterns: [],
      contextLines: 3,
    };

    mockContext = {
      identifier: {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: "123",
      },
      pr: {
        id: "123",
        title: "Test PR",
        description: "Test description",
        author: "test-author",
        state: "OPEN",
        sourceRef: "feature/test",
        targetRef: "main",
        createdDate: "2023-01-01",
        updatedDate: "2023-01-01",
        fileChanges: ["file1.ts", "file2.ts"],
      },
      diffStrategy: {
        strategy: "whole",
        fileCount: 2,
        reason: "Small PR",
        estimatedSize: "Small",
      },
      projectContext: {
        memoryBank: {
          summary: "Test project",
        },
        clinerules: "Test rules",
      },
    } as UnifiedContext;

    mockOptions = {
      workspace: "test-workspace",
      repository: "test-repo",
      pullRequestId: "123",
      dryRun: true,
    };

    processor = new MultiInstanceProcessor(
      mockBitbucketProvider,
      mockCodeReviewConfig,
    );
  });

  describe("processWithMultipleInstances", () => {
    it("should process with multiple instances successfully", async () => {
      const multiInstanceConfig: MultiInstanceConfig = {
        enabled: true,
        instanceCount: 2,
        instances: [
          {
            name: "primary",
            provider: "vertex",
            model: "gemini-2.5-pro",
            temperature: 0.3,
          },
          {
            name: "secondary",
            provider: "vertex",
            model: "gemini-2.5-pro",
            temperature: 0.1,
          },
        ],
        deduplication: {
          enabled: true,
          similarityThreshold: 40,
          maxCommentsToPost: 30,
          prioritizeBy: "severity",
        },
      };

      // Mock instance results
      const mockInstanceResults: InstanceResult[] = [
        {
          instanceName: "primary",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "CRITICAL",
              category: "security",
              issue: "Hardcoded password",
              message: "Password should not be hardcoded",
              impact: "Security vulnerability",
            } as Violation,
          ],
          processingTime: 5000,
          success: true,
        },
        {
          instanceName: "secondary",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "CRITICAL",
              category: "security",
              issue: "Hardcoded password",
              message: "Password should not be hardcoded",
              impact: "Security vulnerability",
            } as Violation,
            {
              type: "inline",
              file: "file2.ts",
              code_snippet: "+  console.log('debug');",
              severity: "MINOR",
              category: "maintainability",
              issue: "Debug statement",
              message: "Remove debug statement",
              impact: "Code cleanliness",
            } as Violation,
          ],
          processingTime: 4500,
          success: true,
        },
      ];

      // Mock the executeInstancesInParallel method
      jest
        .spyOn(processor as any, "executeInstancesInParallel")
        .mockResolvedValue(mockInstanceResults);

      // Mock the duplicate remover
      const mockDeduplicationResult = {
        uniqueViolations: [
          mockInstanceResults[0].violations[0],
          mockInstanceResults[1].violations[1],
        ],
        duplicatesRemoved: {
          exactDuplicates: 1,
          normalizedDuplicates: 0,
          sameLineDuplicates: 0,
        },
        instanceContributions: new Map([
          ["primary", 1],
          ["secondary", 1],
        ]),
        processingMetrics: {
          totalViolationsInput: 3,
          exactDuplicatesRemoved: 1,
          normalizedDuplicatesRemoved: 0,
          sameLineDuplicatesRemoved: 0,
          finalUniqueViolations: 2,
          deduplicationRate: 33.33,
          instanceContributions: { primary: 1, secondary: 1 },
          processingTimeMs: 100,
        },
      };

      const mockDuplicateRemover =
        new ExactDuplicateRemover() as jest.Mocked<ExactDuplicateRemover>;
      mockDuplicateRemover.removeDuplicates.mockReturnValue(
        mockDeduplicationResult,
      );
      (processor as any).duplicateRemover = mockDuplicateRemover;

      const result = await processor.processWithMultipleInstances(
        mockContext,
        mockOptions,
        multiInstanceConfig,
      );

      expect(result).toBeDefined();
      expect(result.instances).toHaveLength(2);
      expect(result.finalViolations).toHaveLength(2);
      expect(result.summary.totalInstances).toBe(2);
      expect(result.summary.successfulInstances).toBe(2);
      expect(result.summary.failedInstances).toBe(0);
      expect(result.summary.deduplicationRate).toBeCloseTo(33.33, 1);
    });

    it("should handle instance failures gracefully", async () => {
      const multiInstanceConfig: MultiInstanceConfig = {
        enabled: true,
        instanceCount: 2,
        instances: [
          {
            name: "primary",
            provider: "vertex",
            model: "gemini-2.5-pro",
            temperature: 0.3,
          },
          {
            name: "secondary",
            provider: "vertex",
            model: "gemini-2.5-pro",
            temperature: 0.1,
          },
        ],
        deduplication: {
          enabled: true,
          similarityThreshold: 40,
          maxCommentsToPost: 30,
          prioritizeBy: "severity",
        },
      };

      // Mock instance results with one failure
      const mockInstanceResults: InstanceResult[] = [
        {
          instanceName: "primary",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "CRITICAL",
              category: "security",
              issue: "Hardcoded password",
              message: "Password should not be hardcoded",
              impact: "Security vulnerability",
            } as Violation,
          ],
          processingTime: 5000,
          success: true,
        },
        {
          instanceName: "secondary",
          violations: [],
          processingTime: 0,
          error: "AI provider timeout",
          success: false,
        },
      ];

      jest
        .spyOn(processor as any, "executeInstancesInParallel")
        .mockResolvedValue(mockInstanceResults);

      const mockDeduplicationResult = {
        uniqueViolations: [mockInstanceResults[0].violations[0]],
        duplicatesRemoved: {
          exactDuplicates: 0,
          normalizedDuplicates: 0,
          sameLineDuplicates: 0,
        },
        instanceContributions: new Map([["primary", 1]]),
        processingMetrics: {
          totalViolationsInput: 1,
          exactDuplicatesRemoved: 0,
          normalizedDuplicatesRemoved: 0,
          sameLineDuplicatesRemoved: 0,
          finalUniqueViolations: 1,
          deduplicationRate: 0,
          instanceContributions: { primary: 1 },
          processingTimeMs: 50,
        },
      };

      const mockDuplicateRemover =
        new ExactDuplicateRemover() as jest.Mocked<ExactDuplicateRemover>;
      mockDuplicateRemover.removeDuplicates.mockReturnValue(
        mockDeduplicationResult,
      );
      (processor as any).duplicateRemover = mockDuplicateRemover;

      const result = await processor.processWithMultipleInstances(
        mockContext,
        mockOptions,
        multiInstanceConfig,
      );

      expect(result.summary.successfulInstances).toBe(1);
      expect(result.summary.failedInstances).toBe(1);
      expect(result.finalViolations).toHaveLength(1);
    });

    it("should validate configuration correctly", async () => {
      const invalidConfig: MultiInstanceConfig = {
        enabled: false,
        instanceCount: 0,
        instances: [],
        deduplication: {
          enabled: true,
          similarityThreshold: 40,
          maxCommentsToPost: 30,
          prioritizeBy: "severity",
        },
      };

      await expect(
        processor.processWithMultipleInstances(
          mockContext,
          mockOptions,
          invalidConfig,
        ),
      ).rejects.toThrow("Multi-instance processing is not enabled");
    });

    it("should apply final filtering when maxCommentsToPost is exceeded", async () => {
      const multiInstanceConfig: MultiInstanceConfig = {
        enabled: true,
        instanceCount: 1,
        instances: [
          {
            name: "primary",
            provider: "vertex",
            model: "gemini-2.5-pro",
            temperature: 0.3,
          },
        ],
        deduplication: {
          enabled: true,
          similarityThreshold: 40,
          maxCommentsToPost: 1, // Limit to 1 comment
          prioritizeBy: "severity",
        },
      };

      const mockInstanceResults: InstanceResult[] = [
        {
          instanceName: "primary",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "CRITICAL",
              category: "security",
              issue: "Hardcoded password",
              message: "Password should not be hardcoded",
              impact: "Security vulnerability",
            } as Violation,
            {
              type: "inline",
              file: "file2.ts",
              code_snippet: "+  console.log('debug');",
              severity: "MINOR",
              category: "maintainability",
              issue: "Debug statement",
              message: "Remove debug statement",
              impact: "Code cleanliness",
            } as Violation,
          ],
          processingTime: 5000,
          success: true,
        },
      ];

      jest
        .spyOn(processor as any, "executeInstancesInParallel")
        .mockResolvedValue(mockInstanceResults);

      const mockDeduplicationResult = {
        uniqueViolations: mockInstanceResults[0].violations,
        duplicatesRemoved: {
          exactDuplicates: 0,
          normalizedDuplicates: 0,
          sameLineDuplicates: 0,
        },
        instanceContributions: new Map([["primary", 2]]),
        processingMetrics: {
          totalViolationsInput: 2,
          exactDuplicatesRemoved: 0,
          normalizedDuplicatesRemoved: 0,
          sameLineDuplicatesRemoved: 0,
          finalUniqueViolations: 2,
          deduplicationRate: 0,
          instanceContributions: { primary: 2 },
          processingTimeMs: 50,
        },
      };

      const mockDuplicateRemover =
        new ExactDuplicateRemover() as jest.Mocked<ExactDuplicateRemover>;
      mockDuplicateRemover.removeDuplicates.mockReturnValue(
        mockDeduplicationResult,
      );
      (processor as any).duplicateRemover = mockDuplicateRemover;

      const result = await processor.processWithMultipleInstances(
        mockContext,
        mockOptions,
        multiInstanceConfig,
      );

      // Should filter to only 1 violation (the CRITICAL one due to severity prioritization)
      expect(result.finalViolations).toHaveLength(1);
      expect(result.finalViolations[0].severity).toBe("CRITICAL");
    });
  });

  describe("configuration validation", () => {
    it("should validate instance configuration", () => {
      const invalidConfig: MultiInstanceConfig = {
        enabled: true,
        instanceCount: 1,
        instances: [
          {
            name: "",
            provider: "",
          },
        ],
        deduplication: {
          enabled: true,
          similarityThreshold: 40,
          maxCommentsToPost: 30,
          prioritizeBy: "severity",
        },
      };

      expect(() => {
        (processor as any).validateMultiInstanceConfig(invalidConfig);
      }).toThrow(
        "Invalid instance configuration: name and provider are required",
      );
    });

    it("should validate deduplication configuration", () => {
      const invalidConfig: MultiInstanceConfig = {
        enabled: true,
        instanceCount: 1,
        instances: [
          {
            name: "test",
            provider: "vertex",
          },
        ],
        deduplication: {
          enabled: true,
          similarityThreshold: 150, // Invalid threshold (> 100)
          maxCommentsToPost: 30,
          prioritizeBy: "severity",
        },
      };

      expect(() => {
        (processor as any).validateMultiInstanceConfig(invalidConfig);
      }).toThrow("Similarity threshold must be between 0 and 100");
    });
  });

  describe("token budget calculation", () => {
    it("should calculate total token budget correctly", () => {
      const instances = [
        { name: "instance1", provider: "vertex", maxTokens: 10000 },
        { name: "instance2", provider: "vertex", maxTokens: 15000 },
      ];

      const totalBudget = (processor as any).calculateTotalTokenBudget(
        instances,
      );

      // Should use the minimum limit (10000) * 2 instances * 0.8 safety margin
      expect(totalBudget).toBe(16000);
    });

    it("should estimate tokens per instance", () => {
      const estimatedTokens = (processor as any).estimateTokensPerInstance(
        mockContext,
      );

      expect(estimatedTokens).toBeGreaterThan(5000); // Should include overhead
    });
  });
});
