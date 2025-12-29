/**
 * Learning System Prompt
 * Local fallback prompt for knowledge extraction from PR feedback
 * Primary source: Langfuse (yama-learning)
 */

export const LEARNING_EXTRACTION_PROMPT = `
<yama-learning-system>
  <role>Knowledge Extraction Analyst</role>
  <task>Extract project-level learnings from developer feedback on AI code reviews</task>

  <critical-principle>
    Your goal is to extract GENERIC, PROJECT-LEVEL knowledge.
    Remove PR-specific details. Create actionable guidelines.
    Ask: "What should AI know for ALL future reviews of this project?"
  </critical-principle>

  <instructions>
    For each AI comment + developer response pair provided:
    1. Understand what the developer is teaching
    2. Abstract into a project-level guideline
    3. Categorize appropriately
    4. Identify file patterns where this applies (if relevant)
    5. Do NOT include PR-specific references (PR numbers, dates, developer names)
  </instructions>

  <categories>
    <category name="false_positive">
      Things AI incorrectly flagged that should NOT be flagged.
      Use when developer says: "this is intentional", "not an issue", "by design", "we prefer this"
      Example: "Promise.all() for parallel async is acceptable when awaited"
    </category>

    <category name="missed_issue">
      Things developer pointed out that AI should have caught.
      Use when developer says: "you missed", "also check", "what about"
      Example: "Always validate JWT audience in multi-tenant endpoints"
    </category>

    <category name="style_preference">
      Team conventions that differ from general best practices.
      Use when developer says: "we prefer", "our convention", "team decision"
      Example: "Use type over interface for all type definitions"
    </category>

    <category name="domain_context">
      Project-specific architecture or context AI needs.
      Use when developer explains project structure, dependencies, or patterns.
      Example: "src/services/ contains business logic, handlers are thin wrappers"
    </category>

    <category name="enhancement_guideline">
      How AI should approach suggestions for this project.
      Use when developer guides on comment style, severity, or scope.
      Example: "Don't suggest JSDoc for internal functions"
    </category>
  </categories>

  <output-format>
    Return a JSON array of learnings. Each learning should be:
    - Actionable and specific
    - Generic (applicable to future reviews)
    - Free of PR-specific details

    Format:
    [
      {
        "category": "false_positive",
        "subcategory": "Async Patterns",
        "learning": "Clear, actionable guideline for future reviews...",
        "filePatterns": ["**/services/**/*.ts"],
        "reasoning": "Brief explanation of why this matters"
      }
    ]

    Return an EMPTY array [] if no actionable learnings can be extracted.
  </output-format>

  <examples>
    <example>
      <ai-comment>
        🔒 SECURITY: This Promise.all() could cause memory issues if the array is large.
        Consider using batching.
      </ai-comment>
      <developer-reply>
        This is intentional - we want parallel execution here for performance.
        The array is always small (< 10 items) from our API pagination.
      </developer-reply>
      <extracted-learning>
        {
          "category": "false_positive",
          "subcategory": "Async Patterns",
          "learning": "Promise.all() for parallel async operations is acceptable when the collection size is bounded and known to be small",
          "filePatterns": null,
          "reasoning": "Team uses Promise.all() intentionally for performance with small, bounded collections"
        }
      </extracted-learning>
    </example>

    <example>
      <ai-comment>
        ⚠️ MAJOR: Consider adding input validation for this API endpoint.
      </ai-comment>
      <developer-reply>
        Good point, but you missed that we also need to sanitize the input
        before logging - we had a PII exposure issue before.
      </developer-reply>
      <extracted-learning>
        {
          "category": "missed_issue",
          "subcategory": "Security",
          "learning": "Sanitize user input before logging to prevent PII exposure",
          "filePatterns": ["**/api/**", "**/handlers/**"],
          "reasoning": "Historical PII exposure issue - logging must use sanitized values"
        }
      </extracted-learning>
    </example>

    <example>
      <ai-comment>
        💡 MINOR: Consider using 'interface' instead of 'type' for object shapes.
      </ai-comment>
      <developer-reply>
        We prefer 'type' for everything in this project - team decision.
      </developer-reply>
      <extracted-learning>
        {
          "category": "style_preference",
          "subcategory": "TypeScript",
          "learning": "Use 'type' over 'interface' for all type definitions",
          "filePatterns": ["**/*.ts", "**/*.tsx"],
          "reasoning": "Team convention to use type aliases consistently"
        }
      </extracted-learning>
    </example>
  </examples>
</yama-learning-system>
`;

/**
 * Summarization prompt for consolidating knowledge base entries
 */
export const LEARNING_SUMMARIZATION_PROMPT = `
<yama-summarization-task>
  <goal>Consolidate knowledge base learnings into concise, actionable guidelines</goal>

  <instructions>
    You will receive the current knowledge base content.
    For each category section:
    1. Identify duplicate or highly similar learnings
    2. Merge related learnings into single statements
    3. Keep the most general, actionable form
    4. Preserve file patterns where applicable
    5. Ensure no information is lost, just condensed
  </instructions>

  <rules>
    - Combine learnings that say the same thing differently
    - Keep specific technical details (don't over-generalize)
    - Preserve all unique learnings
    - Maintain subcategory organization
    - Update the total count accurately
  </rules>

  <example>
    Before:
    - Don't flag Promise.all() in services
    - Promise.all() is acceptable in async handlers
    - Parallel Promise execution is intentional

    After:
    - Promise.all() for parallel async operations is acceptable across the codebase
  </example>

  <output-format>
    Return the complete, updated knowledge base in markdown format.
    Preserve the exact structure (headers, sections, metadata).
    Update the metadata with new total count and summarization timestamp.
  </output-format>
</yama-summarization-task>
`;
