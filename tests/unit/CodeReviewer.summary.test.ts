/**
 * Test for CodeReviewer summary comment behavior with 0 violations
 */

import { CodeReviewer } from "../../src/features/CodeReviewer.js";
import { BitbucketProvider } from "../../src/core/providers/BitbucketProvider.js";
import { UnifiedContext } from "../../src/core/ContextGatherer.js";
import {
  AIProviderConfig,
  CodeReviewConfig,
  ReviewOptions,
} from "../../src/types/index.js";
import * as ExactDuplicateRemoverModule from "../../src/utils/ExactDuplicateRemover.js";

// Mock the dependencies
jest.mock("../../src/core/providers/BitbucketProvider.js");
jest.mock("../../src/utils/Logger.js");
jest.mock("../../src/utils/ExactDuplicateRemover.js");

describe("CodeReviewer Summary Comment Behavior", () => {
  let codeReviewer: CodeReviewer;
  let mockBitbucketProvider: jest.Mocked<BitbucketProvider>;
  let mockAiConfig: AIProviderConfig;
  let mockReviewConfig: CodeReviewConfig;

  beforeEach(() => {
    // Setup mocks
    mockBitbucketProvider = {
      addComment: jest.fn(),
    } as any;

    mockAiConfig = {
      provider: "auto",
      model: "best",
      temperature: 0.3,
      maxTokens: 60000,
      enableAnalytics: true,
    };

    mockReviewConfig = {
      enabled: true,
      systemPrompt: "Test prompt",
      focusAreas: ["security", "performance"],
      severityLevels: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
      categories: [
        "security",
        "performance",
        "maintainability",
        "functionality",
      ],
      excludePatterns: [],
      contextLines: 3,
      batchProcessing: {
        enabled: false,
        maxFilesPerBatch: 3,
        prioritizeSecurityFiles: true,
        parallelBatches: false,
        batchDelayMs: 1000,
        singleRequestThreshold: 5,
      },
    };

    codeReviewer = new CodeReviewer(
      mockBitbucketProvider,
      mockAiConfig,
      mockReviewConfig,
    );
  });

  describe("Summary comment posting logic", () => {
    it("should not post summary comment when uniqueViolations is empty after deduplication", async () => {
      // Mock the ExactDuplicateRemover to return 0 unique violations
      const createExactDuplicateRemoverSpy = jest.spyOn(
        ExactDuplicateRemoverModule,
        "createExactDuplicateRemover",
      );
      createExactDuplicateRemoverSpy.mockReturnValue({
        removeAgainstExistingComments: jest.fn().mockResolvedValue({
          uniqueViolations: [], // No unique violations after deduplication
          duplicatesRemoved: 2,
          semanticMatches: [],
        }),
        getCommentDeduplicationStats: jest
          .fn()
          .mockReturnValue("Deduplication stats"),
        removeDuplicates: jest.fn(),
      } as any);

      const mockContext: UnifiedContext = {
        identifier: {
          workspace: "test-workspace",
          repository: "test-repo",
          branch: "test-branch",
          pullRequestId: "123",
        },
        pr: {
          id: "123",
          title: "Test PR",
          author: "test-author",
          description: "Test description",
          state: "OPEN",
          sourceRef: "feature-branch",
          targetRef: "main",
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
          fileChanges: ["file1.ts"],
          comments: [],
        },
        diffStrategy: {
          strategy: "whole",
          fileCount: 1,
          reason: "Small PR",
          estimatedSize: "Small",
        },
        projectContext: {
          memoryBank: {
            summary: "Test project",
            projectContext: "Test context",
            patterns: "Test patterns",
            standards: "Test standards",
          },
          clinerules: "Test rules",
          filesProcessed: 1,
        },
        prDiff: {
          diff: "test diff content",
          fileChanges: [
            {
              path: "file1.ts",
              changeType: "MODIFIED",
              additions: 10,
              deletions: 5,
              hunks: [],
            },
          ],
          totalAdditions: 10,
          totalDeletions: 5,
        },
        contextId: "test-context-id",
        gatheredAt: "2023-01-01T00:00:00.000Z",
        cacheHits: [],
        gatheringDuration: 1000,
      };

      const mockOptions: ReviewOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        dryRun: false,
      };

      // Mock the private postComments method by calling it through reviewCodeWithContext
      // but first mock the AI analysis to return some violations
      const originalViolations = [
        {
          type: "inline" as const,
          file: "file1.ts",
          code_snippet: '+  const test = "value";',
          severity: "MINOR" as const,
          category: "maintainability" as const,
          issue: "Test issue",
          message: "Test message",
        },
      ];

      // Mock the analyzeWithAI method to return violations
      jest
        .spyOn(codeReviewer as any, "analyzeWithAI")
        .mockResolvedValue(originalViolations);

      // Call the method
      await codeReviewer.reviewCodeWithContext(mockContext, mockOptions);

      // Verify that addComment was called only for inline comments, not for summary
      expect(mockBitbucketProvider.addComment).toHaveBeenCalledTimes(0); // No comments should be posted since uniqueViolations is empty
    });

    it("should post summary comment when uniqueViolations has violations after deduplication", async () => {
      // Mock the ExactDuplicateRemover to return some unique violations
      const uniqueViolations = [
        {
          type: "inline" as const,
          file: "file1.ts",
          code_snippet: '+  const test = "value";',
          severity: "MINOR" as const,
          category: "maintainability" as const,
          issue: "Test issue",
          message: "Test message",
        },
      ];

      const createExactDuplicateRemoverSpy = jest.spyOn(
        ExactDuplicateRemoverModule,
        "createExactDuplicateRemover",
      );
      createExactDuplicateRemoverSpy.mockReturnValue({
        removeAgainstExistingComments: jest.fn().mockResolvedValue({
          uniqueViolations,
          duplicatesRemoved: 0,
          semanticMatches: [],
        }),
        getCommentDeduplicationStats: jest
          .fn()
          .mockReturnValue("Deduplication stats"),
        removeDuplicates: jest.fn(),
      } as any);

      const mockContext: UnifiedContext = {
        identifier: {
          workspace: "test-workspace",
          repository: "test-repo",
          branch: "test-branch",
          pullRequestId: "123",
        },
        pr: {
          id: "123",
          title: "Test PR",
          author: "test-author",
          description: "Test description",
          state: "OPEN",
          sourceRef: "feature-branch",
          targetRef: "main",
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
          fileChanges: ["file1.ts"],
          comments: [],
        },
        diffStrategy: {
          strategy: "whole",
          fileCount: 1,
          reason: "Small PR",
          estimatedSize: "Small",
        },
        projectContext: {
          memoryBank: {
            summary: "Test project",
            projectContext: "Test context",
            patterns: "Test patterns",
            standards: "Test standards",
          },
          clinerules: "Test rules",
          filesProcessed: 1,
        },
        prDiff: {
          diff: "test diff content",
          fileChanges: [
            {
              path: "file1.ts",
              changeType: "MODIFIED",
              additions: 10,
              deletions: 5,
              hunks: [],
            },
          ],
          totalAdditions: 10,
          totalDeletions: 5,
        },
        contextId: "test-context-id-2",
        gatheredAt: "2023-01-01T00:00:00.000Z",
        cacheHits: [],
        gatheringDuration: 1000,
      };

      const mockOptions: ReviewOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        dryRun: false,
      };

      // Mock the analyzeWithAI method to return violations
      jest
        .spyOn(codeReviewer as any, "analyzeWithAI")
        .mockResolvedValue(uniqueViolations);

      // Call the method
      await codeReviewer.reviewCodeWithContext(mockContext, mockOptions);

      // Verify that addComment was called for both inline comment and summary comment
      expect(mockBitbucketProvider.addComment).toHaveBeenCalledTimes(2);

      // Check that one call was for inline comment and one for summary
      const calls = mockBitbucketProvider.addComment.mock.calls;
      expect(calls[0][2]).toBeDefined(); // First call should have inline comment options
      expect(calls[1][2]).toBeUndefined(); // Second call should be summary comment (no options)
    });

    it("should not post any comments when dryRun is true", async () => {
      const uniqueViolations = [
        {
          type: "inline" as const,
          file: "file1.ts",
          code_snippet: '+  const test = "value";',
          severity: "MINOR" as const,
          category: "maintainability" as const,
          issue: "Test issue",
          message: "Test message",
        },
      ];

      const createExactDuplicateRemoverSpy = jest.spyOn(
        ExactDuplicateRemoverModule,
        "createExactDuplicateRemover",
      );
      createExactDuplicateRemoverSpy.mockReturnValue({
        removeAgainstExistingComments: jest.fn().mockResolvedValue({
          uniqueViolations,
          duplicatesRemoved: 0,
          semanticMatches: [],
        }),
        getCommentDeduplicationStats: jest
          .fn()
          .mockReturnValue("Deduplication stats"),
        removeDuplicates: jest.fn(),
      } as any);

      const mockContext: UnifiedContext = {
        identifier: {
          workspace: "test-workspace",
          repository: "test-repo",
          branch: "test-branch",
          pullRequestId: "123",
        },
        pr: {
          id: "123",
          title: "Test PR",
          author: "test-author",
          description: "Test description",
          state: "OPEN",
          sourceRef: "feature-branch",
          targetRef: "main",
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
          fileChanges: ["file1.ts"],
          comments: [],
        },
        diffStrategy: {
          strategy: "whole",
          fileCount: 1,
          reason: "Small PR",
          estimatedSize: "Small",
        },
        projectContext: {
          memoryBank: {
            summary: "Test project",
            projectContext: "Test context",
            patterns: "Test patterns",
            standards: "Test standards",
          },
          clinerules: "Test rules",
          filesProcessed: 1,
        },
        prDiff: {
          diff: "test diff content",
          fileChanges: [
            {
              path: "file1.ts",
              changeType: "MODIFIED",
              additions: 10,
              deletions: 5,
              hunks: [],
            },
          ],
          totalAdditions: 10,
          totalDeletions: 5,
        },
        contextId: "test-context-id-3",
        gatheredAt: "2023-01-01T00:00:00.000Z",
        cacheHits: [],
        gatheringDuration: 1000,
      };

      const mockOptions: ReviewOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        dryRun: true, // Dry run should not post any comments
      };

      // Mock the analyzeWithAI method to return violations
      jest
        .spyOn(codeReviewer as any, "analyzeWithAI")
        .mockResolvedValue(uniqueViolations);

      // Call the method
      await codeReviewer.reviewCodeWithContext(mockContext, mockOptions);

      // Verify that no comments were posted due to dry run
      expect(mockBitbucketProvider.addComment).not.toHaveBeenCalled();
    });
  });
});
