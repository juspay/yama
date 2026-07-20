/**
 * Unit tests for V2 Learning System
 * Tests the learning extraction and summarization prompts.
 */

import { describe, it, expect } from "@jest/globals";
import {
  LEARNING_EXTRACTION_PROMPT,
  LEARNING_SUMMARIZATION_PROMPT,
} from "../../../src/v2/prompts/LearningSystemPrompt.js";

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
