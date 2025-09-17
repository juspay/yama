/**
 * Tests for Exact Duplicate Remover
 */

import { ExactDuplicateRemover } from "../../src/utils/ExactDuplicateRemover.js";
import {
  InstanceResult,
  Violation,
  PRComment,
  AIProviderConfig,
} from "../../src/types/index.js";

// Mock ContentSimilarityService
const mockContentSimilarityService = {
  batchCalculateSimilarity: jest.fn(),
};

jest.mock("../../src/utils/ContentSimilarityService.js", () => ({
  ContentSimilarityService: jest.fn(() => mockContentSimilarityService),
}));

describe("ExactDuplicateRemover", () => {
  let remover: ExactDuplicateRemover;
  let mockAIConfig: AIProviderConfig;

  beforeEach(() => {
    remover = new ExactDuplicateRemover();
    mockAIConfig = {
      provider: "auto",
      model: "best",
      temperature: 0.1,
      maxTokens: 4000,
      enableAnalytics: false,
    };
    jest.clearAllMocks();
  });

  describe("removeDuplicates", () => {
    it("should remove exact duplicates", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
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
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved.exactDuplicates).toBe(1);
      expect(result.processingMetrics.deduplicationRate).toBe(50);
    });

    it("should remove normalized duplicates", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "FILE1.TS", // Different case
              code_snippet: "+  const password = 'hardcoded';",
              severity: "CRITICAL",
              category: "security",
              issue: "hardcoded password", // Different case
              message: "password should not be hardcoded", // Different case
              impact: "security vulnerability", // Different case
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved.normalizedDuplicates).toBe(1);
    });

    it("should remove same file+line duplicates", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Same line
              severity: "MAJOR", // Different severity
              category: "security",
              issue: "Security issue", // Different issue description
              message: "Avoid hardcoded values", // Different message
              impact: "Potential security risk", // Different impact
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.uniqueViolations[0].severity).toBe("CRITICAL"); // Should keep higher severity
      expect(result.duplicatesRemoved.sameLineDuplicates).toBe(1);
    });

    it("should handle violations without file or code_snippet", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
          violations: [
            {
              type: "general",
              severity: "MINOR",
              category: "maintainability",
              issue: "General issue",
              message: "General message",
              impact: "General impact",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "general",
              severity: "MINOR",
              category: "maintainability",
              issue: "General issue",
              message: "General message",
              impact: "General impact",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved.exactDuplicates).toBe(1);
    });

    it("should track instance contributions correctly", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file3.ts",
              code_snippet: "+  var x = 1;",
              severity: "SUGGESTION",
              category: "maintainability",
              issue: "Use const instead of var",
              message: "Prefer const over var",
              impact: "Better code quality",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(3);
      expect(result.instanceContributions.get("instance1")).toBe(2);
      expect(result.instanceContributions.get("instance2")).toBe(1);
    });

    it("should skip failed instances", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [],
          processingTime: 0,
          error: "AI provider timeout",
          success: false,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.instanceContributions.get("instance1")).toBe(1);
      expect(result.instanceContributions.has("instance2")).toBe(false);
    });

    it("should provide detailed statistics", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
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
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Exact duplicate
              severity: "CRITICAL",
              category: "security",
              issue: "Hardcoded password",
              message: "Password should not be hardcoded",
              impact: "Security vulnerability",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.processingMetrics.totalViolationsInput).toBe(2);
      expect(result.processingMetrics.exactDuplicatesRemoved).toBe(1);
      expect(result.processingMetrics.finalUniqueViolations).toBe(1);
      expect(result.processingMetrics.deduplicationRate).toBe(50);
      expect(result.processingMetrics.processingTimeMs).toBeGreaterThanOrEqual(
        0,
      );
    });
  });

  describe("getDeduplicationStats", () => {
    it("should format statistics correctly", () => {
      const mockResult = {
        uniqueViolations: [],
        duplicatesRemoved: {
          exactDuplicates: 5,
          normalizedDuplicates: 3,
          sameLineDuplicates: 2,
        },
        instanceContributions: new Map([
          ["instance1", 10],
          ["instance2", 8],
        ]),
        processingMetrics: {
          totalViolationsInput: 20,
          exactDuplicatesRemoved: 5,
          normalizedDuplicatesRemoved: 3,
          sameLineDuplicatesRemoved: 2,
          finalUniqueViolations: 10,
          deduplicationRate: 50.0,
          instanceContributions: { instance1: 10, instance2: 8 },
          processingTimeMs: 150,
        },
      };

      const stats = remover.getDeduplicationStats(mockResult);

      expect(stats).toContain("Input violations: 20");
      expect(stats).toContain("Exact duplicates removed: 5");
      expect(stats).toContain("Normalized duplicates removed: 3");
      expect(stats).toContain("Same-line duplicates removed: 2");
      expect(stats).toContain("Final unique violations: 10");
      expect(stats).toContain("Deduplication rate: 50.0%");
      expect(stats).toContain("Processing time: 150ms");
      expect(stats).toContain("instance1: 10, instance2: 8");
    });
  });

  describe("code snippet normalization", () => {
    it("should normalize code snippets correctly", () => {
      // Test the private normalizeCodeSnippet method through public interface
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "MINOR",
              category: "maintainability",
              issue: "Test issue",
              message: "Test message",
              impact: "Test impact",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Same normalized content
              severity: "MINOR",
              category: "maintainability",
              issue: "Test issue",
              message: "Test message",
              impact: "Test impact",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      // Should be treated as exact duplicates since they're identical
      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved.exactDuplicates).toBe(1);
    });
  });

  describe("severity resolution", () => {
    it("should keep higher severity when resolving duplicates", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "MINOR",
              category: "security",
              issue: "Hardcoded value",
              message: "Avoid hardcoded values",
              impact: "Maintainability issue",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Same line
              severity: "CRITICAL", // Higher severity
              category: "security",
              issue: "Security vulnerability",
              message: "Hardcoded password is a security risk",
              impact: "Security vulnerability",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.uniqueViolations[0].severity).toBe("CRITICAL");
      expect(result.uniqueViolations[0].issue).toBe("Security vulnerability");
    });

    it("should handle multiple severity upgrades correctly", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "SUGGESTION",
              category: "security",
              issue: "Consider using environment variables",
              message: "Hardcoded values are not ideal",
              impact: "Code quality",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Same line
              severity: "MINOR", // Higher than SUGGESTION
              category: "security",
              issue: "Hardcoded value detected",
              message: "Avoid hardcoded values",
              impact: "Maintainability issue",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
        {
          instanceName: "instance3",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Same line
              severity: "CRITICAL", // Highest severity
              category: "security",
              issue: "Security vulnerability",
              message: "Hardcoded password is a security risk",
              impact: "Security vulnerability",
            } as Violation,
          ],
          processingTime: 1300,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.uniqueViolations[0].severity).toBe("CRITICAL");
      expect(result.uniqueViolations[0].issue).toBe("Security vulnerability");
      expect(result.duplicatesRemoved.sameLineDuplicates).toBe(2);
    });

    it("should handle complex duplicate resolution with Map-based approach", () => {
      const instanceResults: InstanceResult[] = [
        {
          instanceName: "instance1",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';",
              severity: "MINOR",
              category: "security",
              issue: "Hardcoded value A",
              message: "Message A",
              impact: "Impact A",
            } as Violation,
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const apiKey = 'secret';",
              severity: "MAJOR",
              category: "security",
              issue: "API key issue",
              message: "API key message",
              impact: "API impact",
            } as Violation,
          ],
          processingTime: 1000,
          success: true,
        },
        {
          instanceName: "instance2",
          violations: [
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const password = 'hardcoded';", // Duplicate of first violation
              severity: "CRITICAL", // Higher severity
              category: "security",
              issue: "Hardcoded value B",
              message: "Message B",
              impact: "Impact B",
            } as Violation,
            {
              type: "inline",
              file: "file1.ts",
              code_snippet: "+  const apiKey = 'secret';", // Duplicate of second violation
              severity: "MINOR", // Lower severity
              category: "security",
              issue: "API key issue lower",
              message: "API key message lower",
              impact: "API impact lower",
            } as Violation,
          ],
          processingTime: 1200,
          success: true,
        },
      ];

      const result = remover.removeDuplicates(instanceResults);

      expect(result.uniqueViolations).toHaveLength(2);

      // Find the password violation
      const passwordViolation = result.uniqueViolations.find((v) =>
        v.code_snippet?.includes("password"),
      );
      expect(passwordViolation?.severity).toBe("CRITICAL");
      expect(passwordViolation?.issue).toBe("Hardcoded value B");

      // Find the API key violation
      const apiKeyViolation = result.uniqueViolations.find((v) =>
        v.code_snippet?.includes("apiKey"),
      );
      expect(apiKeyViolation?.severity).toBe("MAJOR");
      expect(apiKeyViolation?.issue).toBe("API key issue");

      expect(result.duplicatesRemoved.sameLineDuplicates).toBe(2);
    });
  });

  describe("removeAgainstExistingComments", () => {
    it("should use semantic similarity to detect duplicates", async () => {
      const newViolations: Violation[] = [
        {
          type: "inline",
          file: "src/components/Auth.tsx",
          code_snippet: "+const password = 'hardcoded123';",
          severity: "CRITICAL",
          category: "security",
          issue: "Hardcoded password detected",
          message: "This hardcoded password poses a security risk",
          impact: "Potential security breach",
          suggestion: "Use environment variables",
        },
      ];

      const existingComments: PRComment[] = [
        {
          id: 12345,
          text: "🛡️ Automated review by **Yama** **🔒 Hardcoded password detected** This is a security issue",
          author: { name: "yama-bot", displayName: "Yama Bot" },
          createdDate: "2025-01-15T10:30:00Z",
          updatedDate: "2025-01-15T10:30:00Z",
          anchor: {
            filePath: "src/components/Auth.tsx",
            lineFrom: 25,
            lineTo: 25,
            lineType: "ADDED",
          },
        },
      ];

      // Mock high similarity score
      mockContentSimilarityService.batchCalculateSimilarity.mockResolvedValue([
        {
          violationIndex: 0,
          commentIndex: 0,
          violationId: "violation_0",
          commentId: 12345,
          similarityScore: 95,
          reasoning: "Both discuss the same hardcoded password security issue",
        },
      ]);

      const result = await remover.removeAgainstExistingComments(
        newViolations,
        existingComments,
        mockAIConfig,
        85,
      );

      expect(result.uniqueViolations).toHaveLength(0);
      expect(result.duplicatesRemoved).toBe(1);
      expect(result.semanticMatches).toHaveLength(1);
      expect(result.semanticMatches[0].similarityScore).toBe(95);
    });

    it("should keep violations with low similarity scores", async () => {
      const newViolations: Violation[] = [
        {
          type: "inline",
          file: "src/components/Payment.tsx",
          code_snippet: "+const apiKey = 'secret123';",
          severity: "CRITICAL",
          category: "security",
          issue: "Hardcoded API key",
          message: "API key should not be hardcoded",
          impact: "Security vulnerability",
          suggestion: "Use environment variables",
        },
      ];

      const existingComments: PRComment[] = [
        {
          id: 12345,
          text: "This component needs better error handling",
          author: { name: "reviewer", displayName: "Code Reviewer" },
          createdDate: "2025-01-15T10:30:00Z",
          updatedDate: "2025-01-15T10:30:00Z",
        },
      ];

      // Mock low similarity score
      mockContentSimilarityService.batchCalculateSimilarity.mockResolvedValue([
        {
          violationIndex: 0,
          commentIndex: 0,
          violationId: "violation_0",
          commentId: 12345,
          similarityScore: 30,
          reasoning: "Different topics - security vs error handling",
        },
      ]);

      const result = await remover.removeAgainstExistingComments(
        newViolations,
        existingComments,
        mockAIConfig,
        85,
      );

      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved).toBe(0);
      expect(result.semanticMatches).toHaveLength(0);
    });

    it("should handle empty inputs gracefully", async () => {
      const result1 = await remover.removeAgainstExistingComments(
        [],
        [],
        mockAIConfig,
      );
      expect(result1.uniqueViolations).toHaveLength(0);
      expect(result1.duplicatesRemoved).toBe(0);
      expect(result1.semanticMatches).toHaveLength(0);

      const newViolations: Violation[] = [
        {
          type: "inline",
          file: "src/test.ts",
          code_snippet: "+const x = 1;",
          severity: "MINOR",
          category: "maintainability",
          issue: "Test issue",
          message: "Test message",
          impact: "Test impact",
        },
      ];

      const result2 = await remover.removeAgainstExistingComments(
        newViolations,
        [],
        mockAIConfig,
      );
      expect(result2.uniqueViolations).toHaveLength(1);
      expect(result2.duplicatesRemoved).toBe(0);
    });

    it("should handle AI service failures gracefully", async () => {
      const newViolations: Violation[] = [
        {
          type: "inline",
          file: "src/test.ts",
          code_snippet: "+const x = 1;",
          severity: "MINOR",
          category: "maintainability",
          issue: "Test issue",
          message: "Test message",
          impact: "Test impact",
        },
      ];

      const existingComments: PRComment[] = [
        {
          id: 123,
          text: "Some comment",
          author: { name: "user", displayName: "User" },
          createdDate: "2025-01-15T10:30:00Z",
          updatedDate: "2025-01-15T10:30:00Z",
        },
      ];

      // Mock AI service failure
      mockContentSimilarityService.batchCalculateSimilarity.mockRejectedValue(
        new Error("AI service unavailable"),
      );

      const result = await remover.removeAgainstExistingComments(
        newViolations,
        existingComments,
        mockAIConfig,
      );

      // Should gracefully fall back to returning all violations
      expect(result.uniqueViolations).toHaveLength(1);
      expect(result.duplicatesRemoved).toBe(0);
      expect(result.semanticMatches).toHaveLength(0);
    });
  });

  describe("getCommentDeduplicationStats", () => {
    it("should format comment deduplication statistics correctly", () => {
      const mockResult = {
        uniqueViolations: [
          {
            type: "inline" as const,
            severity: "MINOR" as const,
            category: "maintainability" as const,
            issue: "Test",
            message: "Test",
            impact: "Test",
          },
        ],
        duplicatesRemoved: 3,
        semanticMatches: [
          {
            violation: "Hardcoded password detected",
            comment: "Comment 123",
            similarityScore: 95,
            reasoning: "Both discuss security issues",
          },
          {
            violation: "Debug statement found",
            comment: "Comment 456",
            similarityScore: 88,
          },
          {
            violation: "Missing error handling",
            comment: "Comment 789",
            similarityScore: 92,
            reasoning: "Both about error handling",
          },
        ],
      };

      const stats = remover.getCommentDeduplicationStats(mockResult);

      expect(stats).toContain("Input violations: 4"); // 1 unique + 3 duplicates
      expect(stats).toContain("Unique violations: 1");
      expect(stats).toContain("Duplicates removed: 3");
      expect(stats).toContain("Deduplication rate: 75.0%");
      expect(stats).toContain("Semantic matches: 3");
      expect(stats).toContain("Average similarity score: 91.7%"); // (95+88+92)/3
    });
  });
});
