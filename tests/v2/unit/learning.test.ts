/**
 * Unit tests for V2 Learning System
 * Tests knowledge base extraction and feedback processing
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  LEARNING_EXTRACTION_PROMPT,
  LEARNING_SUMMARIZATION_PROMPT,
} from "../../../src/v2/prompts/LearningSystemPrompt.js";
import { FeedbackExtractor } from "../../../src/v2/learning/FeedbackExtractor.js";
import { KnowledgeBaseConfig } from "../../../src/v2/types/config.types.js";
import { PRComment, CommentPair } from "../../../src/v2/learning/types.js";

describe("Learning Extraction Prompt", () => {
  it("should export a non-empty string", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toBeDefined();
    expect(typeof LEARNING_EXTRACTION_PROMPT).toBe("string");
    expect(LEARNING_EXTRACTION_PROMPT.length).toBeGreaterThan(100);
  });

  it("should contain core XML structure", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<yama-learning-system>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("</yama-learning-system>");
  });

  it("should contain role and task definition", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<role>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain(
      "Knowledge Extraction Analyst",
    );
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<task>");
  });

  it("should contain learning categories", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<categories>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain('name="false_positive"');
    expect(LEARNING_EXTRACTION_PROMPT).toContain('name="missed_issue"');
    expect(LEARNING_EXTRACTION_PROMPT).toContain('name="style_preference"');
    expect(LEARNING_EXTRACTION_PROMPT).toContain('name="domain_context"');
    expect(LEARNING_EXTRACTION_PROMPT).toContain(
      'name="enhancement_guideline"',
    );
  });

  it("should contain output format specification", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<output-format>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("JSON array");
    expect(LEARNING_EXTRACTION_PROMPT).toContain('"category"');
    expect(LEARNING_EXTRACTION_PROMPT).toContain('"learning"');
  });

  it("should contain examples", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<examples>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<ai-comment>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<developer-reply>");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("<extracted-learning>");
  });

  it("should emphasize project-level abstraction", () => {
    expect(LEARNING_EXTRACTION_PROMPT).toContain("GENERIC, PROJECT-LEVEL");
    expect(LEARNING_EXTRACTION_PROMPT).toContain("Remove PR-specific details");
  });
});

describe("Learning Summarization Prompt", () => {
  it("should export a non-empty string", () => {
    expect(LEARNING_SUMMARIZATION_PROMPT).toBeDefined();
    expect(typeof LEARNING_SUMMARIZATION_PROMPT).toBe("string");
    expect(LEARNING_SUMMARIZATION_PROMPT.length).toBeGreaterThan(100);
  });

  it("should contain core XML structure", () => {
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain(
      "<yama-summarization-task>",
    );
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain(
      "</yama-summarization-task>",
    );
  });

  it("should contain consolidation instructions", () => {
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain("<instructions>");
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain("Consolidate");
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain("duplicate");
  });

  it("should contain rules for summarization", () => {
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain("<rules>");
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain("Combine learnings");
    expect(LEARNING_SUMMARIZATION_PROMPT).toContain(
      "Preserve all unique learnings",
    );
  });
});

describe("FeedbackExtractor", () => {
  let extractor: FeedbackExtractor;
  let mockConfig: KnowledgeBaseConfig;

  beforeEach(() => {
    mockConfig = {
      enabled: true,
      path: ".yama/knowledge-base.md",
      aiAuthorPatterns: ["Yama", "yama-bot"],
      maxEntriesBeforeSummarization: 50,
      summaryRetentionCount: 20,
      autoCommit: false,
    };
    extractor = new FeedbackExtractor(mockConfig);
  });

  describe("isAIComment", () => {
    it("should identify AI comments by author pattern", () => {
      const comment: PRComment = {
        id: 1,
        text: "Some regular comment",
        author: { name: "Yama" },
        createdAt: new Date().toISOString(),
      };

      expect(extractor.isAIComment(comment)).toBe(true);
    });

    it("should identify AI comments by text patterns", () => {
      const comment: PRComment = {
        id: 1,
        text: "🔒 CRITICAL: Security vulnerability found",
        author: { name: "developer123" },
        createdAt: new Date().toISOString(),
      };

      expect(extractor.isAIComment(comment)).toBe(true);
    });

    it("should identify AI comments with severity markers", () => {
      const severityPatterns = [
        "⚠️ MAJOR: Performance issue",
        "💡 MINOR: Consider refactoring",
        "💬 SUGGESTION: You might want to",
      ];

      for (const text of severityPatterns) {
        const comment: PRComment = {
          id: 1,
          text,
          author: { name: "human-dev" },
          createdAt: new Date().toISOString(),
        };
        expect(extractor.isAIComment(comment)).toBe(true);
      }
    });

    it("should NOT identify regular developer comments as AI", () => {
      const comment: PRComment = {
        id: 1,
        text: "Looks good to me, approved!",
        author: { name: "developer123" },
        createdAt: new Date().toISOString(),
      };

      expect(extractor.isAIComment(comment)).toBe(false);
    });
  });

  describe("isDeveloperComment", () => {
    it("should return true for non-AI comments", () => {
      const comment: PRComment = {
        id: 1,
        text: "This is intentional, we prefer it this way",
        author: { name: "developer123" },
        createdAt: new Date().toISOString(),
      };

      expect(extractor.isDeveloperComment(comment)).toBe(true);
    });

    it("should return false for AI comments", () => {
      const comment: PRComment = {
        id: 1,
        text: "🔒 CRITICAL: SQL injection vulnerability",
        author: { name: "yama-bot" },
        createdAt: new Date().toISOString(),
      };

      expect(extractor.isDeveloperComment(comment)).toBe(false);
    });
  });

  describe("extractCommentPairs", () => {
    it("should extract pairs from threaded comments", () => {
      const comments: PRComment[] = [
        {
          id: 1,
          text: "🔒 CRITICAL: Security issue here",
          author: { name: "Yama" },
          createdAt: "2024-01-01T10:00:00Z",
        },
        {
          id: 2,
          text: "This is intentional for internal APIs",
          author: { name: "developer" },
          createdAt: "2024-01-01T10:05:00Z",
          parentId: 1,
        },
      ];

      const pairs = extractor.extractCommentPairs(comments);

      expect(pairs.length).toBeGreaterThanOrEqual(1);
      expect(pairs[0].aiComment.id).toBe(1);
      expect(pairs[0].developerReply.id).toBe(2);
    });

    it("should return empty array for no AI comments", () => {
      const comments: PRComment[] = [
        {
          id: 1,
          text: "Regular comment",
          author: { name: "dev1" },
          createdAt: new Date().toISOString(),
        },
        {
          id: 2,
          text: "Another regular comment",
          author: { name: "dev2" },
          createdAt: new Date().toISOString(),
        },
      ];

      const pairs = extractor.extractCommentPairs(comments);
      expect(pairs.length).toBe(0);
    });

    it("should handle inline comment pairs at same location", () => {
      const comments: PRComment[] = [
        {
          id: 1,
          text: "⚠️ MAJOR: Consider caching here",
          author: { name: "Yama" },
          createdAt: "2024-01-01T10:00:00Z",
          filePath: "src/service.ts",
          lineNumber: 42,
        },
        {
          id: 2,
          text: "Actually this is a hot path, we already have caching upstream",
          author: { name: "developer" },
          createdAt: "2024-01-01T10:05:00Z",
          filePath: "src/service.ts",
          lineNumber: 42,
        },
      ];

      const pairs = extractor.extractCommentPairs(comments);

      expect(pairs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("hasActionableFeedback", () => {
    it("should return true for substantive feedback", () => {
      const pair: CommentPair = {
        aiComment: {
          id: 1,
          text: "🔒 CRITICAL: Security issue",
          author: { name: "Yama" },
          createdAt: new Date().toISOString(),
        },
        developerReply: {
          id: 2,
          text: "This is intentional because we validate at the API gateway level",
          author: { name: "dev" },
          createdAt: new Date().toISOString(),
        },
      };

      expect(extractor.hasActionableFeedback(pair)).toBe(true);
    });

    it("should return false for simple acknowledgments", () => {
      const pair: CommentPair = {
        aiComment: {
          id: 1,
          text: "💡 MINOR: Consider adding docs",
          author: { name: "Yama" },
          createdAt: new Date().toISOString(),
        },
        developerReply: {
          id: 2,
          text: "done",
          author: { name: "dev" },
          createdAt: new Date().toISOString(),
        },
      };

      expect(extractor.hasActionableFeedback(pair)).toBe(false);
    });

    it("should return false for short replies", () => {
      const pair: CommentPair = {
        aiComment: {
          id: 1,
          text: "⚠️ MAJOR: Bug found",
          author: { name: "Yama" },
          createdAt: new Date().toISOString(),
        },
        developerReply: {
          id: 2,
          text: "ok",
          author: { name: "dev" },
          createdAt: new Date().toISOString(),
        },
      };

      expect(extractor.hasActionableFeedback(pair)).toBe(false);
    });

    it("should detect feedback indicators", () => {
      const feedbackPhrases = [
        "Actually, this is by design for our use case",
        "However, we prefer using type over interface",
        "Not necessary because we handle this elsewhere",
        "This is intentional for performance reasons",
        "Our convention is to use snake_case here",
        "You missed checking the error boundary",
      ];

      for (const phrase of feedbackPhrases) {
        const pair: CommentPair = {
          aiComment: {
            id: 1,
            text: "💡 MINOR: Suggestion",
            author: { name: "Yama" },
            createdAt: new Date().toISOString(),
          },
          developerReply: {
            id: 2,
            text: phrase,
            author: { name: "dev" },
            createdAt: new Date().toISOString(),
          },
        };

        expect(extractor.hasActionableFeedback(pair)).toBe(true);
      }
    });
  });

  describe("convertBitbucketComment", () => {
    it("should convert Bitbucket Server format", () => {
      const rawComment = {
        id: 123,
        text: "Test comment",
        author: {
          name: "testuser",
          displayName: "Test User",
          emailAddress: "test@example.com",
        },
        createdDate: "2024-01-01T10:00:00Z",
        path: "src/file.ts",
        line: 42,
      };

      const result = extractor.convertBitbucketComment(rawComment);

      expect(result.id).toBe(123);
      expect(result.text).toBe("Test comment");
      expect(result.author.name).toBe("testuser");
      expect(result.author.displayName).toBe("Test User");
      expect(result.filePath).toBe("src/file.ts");
      expect(result.lineNumber).toBe(42);
    });

    it("should convert Bitbucket Cloud format", () => {
      const rawComment = {
        id: 456,
        content: { raw: "Cloud comment content" },
        user: {
          username: "clouduser",
          display_name: "Cloud User",
        },
        created_on: "2024-01-01T12:00:00Z",
        inline: {
          path: "src/other.ts",
          to: 55,
        },
      };

      const result = extractor.convertBitbucketComment(rawComment);

      expect(result.id).toBe(456);
      expect(result.text).toBe("Cloud comment content");
      expect(result.author.name).toBe("clouduser");
      expect(result.filePath).toBe("src/other.ts");
      expect(result.lineNumber).toBe(55);
    });

    it("should handle missing optional fields", () => {
      const rawComment = {
        id: 789,
        text: "Minimal comment",
        author: { name: "minuser" },
      };

      const result = extractor.convertBitbucketComment(rawComment);

      expect(result.id).toBe(789);
      expect(result.text).toBe("Minimal comment");
      expect(result.filePath).toBeUndefined();
      expect(result.lineNumber).toBeUndefined();
      expect(result.parentId).toBeUndefined();
    });
  });

  describe("getCommentStats", () => {
    it("should return correct statistics", () => {
      const comments: PRComment[] = [
        {
          id: 1,
          text: "🔒 CRITICAL: Issue 1",
          author: { name: "Yama" },
          createdAt: new Date().toISOString(),
        },
        {
          id: 2,
          text: "⚠️ MAJOR: Issue 2",
          author: { name: "Yama" },
          createdAt: new Date().toISOString(),
        },
        {
          id: 3,
          text: "This is intentional",
          author: { name: "developer" },
          createdAt: new Date().toISOString(),
          parentId: 1,
        },
        {
          id: 4,
          text: "Regular developer comment",
          author: { name: "developer" },
          createdAt: new Date().toISOString(),
        },
      ];

      const stats = extractor.getCommentStats(comments);

      expect(stats.total).toBe(4);
      expect(stats.aiComments).toBe(2);
      expect(stats.developerComments).toBe(2);
      expect(stats.pairs).toBeGreaterThanOrEqual(1);
    });
  });
});
