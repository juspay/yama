/**
 * Tests for ContentSimilarityService
 */

import { ContentSimilarityService } from "../../src/utils/ContentSimilarityService.js";
import {
  Violation,
  PRComment,
  AIProviderConfig,
} from "../../src/types/index.js";

// Mock NeuroLink
const mockNeuroLink = {
  generate: jest.fn(),
};

jest.mock("@juspay/neurolink", () => ({
  NeuroLink: jest.fn(() => mockNeuroLink),
}));

describe("ContentSimilarityService", () => {
  let service: ContentSimilarityService;
  let aiConfig: AIProviderConfig;

  beforeEach(() => {
    aiConfig = {
      provider: "auto",
      model: "best",
      temperature: 0.1,
      maxTokens: 4000,
      enableAnalytics: false,
    };
    service = new ContentSimilarityService(aiConfig);
    jest.clearAllMocks();
  });

  describe("batchCalculateSimilarity", () => {
    it("should return empty array when no violations or comments", async () => {
      const result = await service.batchCalculateSimilarity([], []);
      expect(result).toEqual([]);
    });

    it("should process violations and comments for similarity", async () => {
      const violations: Violation[] = [
        {
          type: "inline",
          file: "src/test.js",
          code_snippet: "const password = 'hardcoded123';",
          severity: "CRITICAL",
          category: "security",
          issue: "Hardcoded password detected",
          message: "Password should not be hardcoded",
          impact: "Security vulnerability",
        },
      ];

      const comments: PRComment[] = [
        {
          id: 123,
          text: "🛡️ Automated review by **Yama** **🔒 Hardcoded password detected** This is a security issue",
          author: { name: "yama", displayName: "Yama Bot" },
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
          anchor: {
            filePath: "src/test.js",
            lineFrom: 10,
            lineTo: 10,
            lineType: "ADDED",
          },
        },
      ];

      // Mock AI response indicating high similarity
      mockNeuroLink.generate.mockResolvedValue({
        content: JSON.stringify([
          {
            violation: 1,
            comment: 1,
            score: 95,
            reasoning:
              "Both discuss the same hardcoded password security issue",
          },
        ]),
      });

      const result = await service.batchCalculateSimilarity(
        violations,
        comments,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        violationIndex: 0,
        commentIndex: 0,
        violationId: "violation_0",
        commentId: 123,
        similarityScore: 95,
        reasoning: "Both discuss the same hardcoded password security issue",
      });

      expect(mockNeuroLink.generate).toHaveBeenCalledWith({
        input: {
          text: expect.stringContaining("Analyze the semantic similarity"),
        },
        systemPrompt: expect.stringContaining("expert code reviewer"),
        provider: "auto",
        model: "best",
        temperature: 0.1,
        maxTokens: 4000,
        timeout: "5m",
        enableAnalytics: false,
        enableEvaluation: false,
      });
    });

    it("should handle AI service errors gracefully", async () => {
      const violations: Violation[] = [
        {
          type: "inline",
          file: "src/test.js",
          code_snippet: "const x = 1;",
          severity: "MINOR",
          category: "general",
          issue: "Test issue",
          message: "Test message",
          impact: "Test impact",
        },
      ];

      const comments: PRComment[] = [
        {
          id: 456,
          text: "Some comment",
          author: { name: "user", displayName: "User" },
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
        },
      ];

      // Mock AI service failure
      mockNeuroLink.generate.mockRejectedValue(
        new Error("AI service unavailable"),
      );

      const result = await service.batchCalculateSimilarity(
        violations,
        comments,
      );

      expect(result).toEqual([]);
    });

    it("should process batches correctly", async () => {
      const violations: Violation[] = Array.from({ length: 25 }, (_, i) => ({
        type: "inline" as const,
        file: `src/test${i}.js`,
        code_snippet: `const x${i} = 1;`,
        severity: "MINOR" as const,
        category: "general" as const,
        issue: `Test issue ${i}`,
        message: `Test message ${i}`,
        impact: `Test impact ${i}`,
      }));

      const comments: PRComment[] = [
        {
          id: 789,
          text: "Some comment",
          author: { name: "user", displayName: "User" },
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
        },
      ];

      // Mock AI response for each batch
      mockNeuroLink.generate.mockResolvedValue({
        content: "[]", // No similarities
      });

      const result = await service.batchCalculateSimilarity(
        violations,
        comments,
        10,
      );

      expect(result).toEqual([]);
      // Should be called 3 times (25 violations / 10 batch size = 3 batches)
      expect(mockNeuroLink.generate).toHaveBeenCalledTimes(3);
    });

    it("should extract violation content correctly", async () => {
      const violations: Violation[] = [
        {
          type: "inline",
          file: "src/auth.js",
          code_snippet: "const token = 'secret123';",
          severity: "CRITICAL",
          category: "security",
          issue: "Hardcoded token",
          message: "Token should be from environment",
          impact: "Security risk",
          suggestion: "Use process.env.TOKEN",
        },
      ];

      const comments: PRComment[] = [
        {
          id: 999,
          text: "Test comment",
          author: { name: "user", displayName: "User" },
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
        },
      ];

      mockNeuroLink.generate.mockResolvedValue({
        content: "[]",
      });

      await service.batchCalculateSimilarity(violations, comments);

      const callArgs = mockNeuroLink.generate.mock.calls[0][0];
      const prompt = callArgs.input.text;

      expect(prompt).toContain("Issue: Hardcoded token");
      expect(prompt).toContain("Message: Token should be from environment");
      expect(prompt).toContain("File: src/auth.js");
      expect(prompt).toContain("Code: const token = 'secret123';");
      expect(prompt).toContain("Severity: CRITICAL");
      expect(prompt).toContain("Category: security");
    });

    it("should extract comment content correctly", async () => {
      const violations: Violation[] = [
        {
          type: "inline",
          file: "src/test.js",
          code_snippet: "const x = 1;",
          severity: "MINOR",
          category: "general",
          issue: "Test issue",
          message: "Test message",
          impact: "Test impact",
        },
      ];

      const comments: PRComment[] = [
        {
          id: 111,
          text: "This is a security issue with hardcoded values",
          author: { name: "reviewer", displayName: "Code Reviewer" },
          createdDate: "2023-01-01",
          updatedDate: "2023-01-01",
          anchor: {
            filePath: "src/auth.js",
            lineFrom: 15,
            lineTo: 15,
            lineType: "ADDED",
          },
        },
      ];

      mockNeuroLink.generate.mockResolvedValue({
        content: "[]",
      });

      await service.batchCalculateSimilarity(violations, comments);

      const callArgs = mockNeuroLink.generate.mock.calls[0][0];
      const prompt = callArgs.input.text;

      expect(prompt).toContain(
        "Comment: This is a security issue with hardcoded values",
      );
      expect(prompt).toContain("File: src/auth.js");
      expect(prompt).toContain("Author: Code Reviewer");
    });
  });
});
