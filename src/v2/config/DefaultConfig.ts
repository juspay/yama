/**
 * Default Configuration for Yama V2
 * Provides sensible defaults when no config file is present
 */

import { YamaV2Config } from "../types/config.types.js";

export class DefaultConfig {
  static get(): YamaV2Config {
    return {
      version: 2,
      configType: "yama-v2",

      display: {
        showBanner: true,
        streamingMode: false,
        verboseToolCalls: false,
        showAIThinking: false,
      },

      ai: {
        provider: "auto",
        model: "gemini-2.5-pro",
        temperature: 0.2,
        maxTokens: 128000,
        enableAnalytics: true,
        enableEvaluation: false,
        timeout: "15m",
        retryAttempts: 3,
        conversationMemory: {
          enabled: true,
          store: "memory",
          maxSessions: 50,
          maxTurnsPerSession: 300,
          enableSummarization: false,
        },
      },

      mcpServers: {
        bitbucket: {
          blockedTools: [],
        },
        jira: {
          enabled: false, // Opt-in: users must explicitly enable Jira integration
          blockedTools: [],
        },
      },

      review: {
        enabled: true,
        workflowInstructions: `Follow the autonomous review workflow defined in the base system prompt.`,
        focusAreas: [
          {
            name: "Security Analysis",
            priority: "CRITICAL",
            description: `
- SQL/NoSQL injection vulnerabilities
- Cross-Site Scripting (XSS)
- Authentication/Authorization flaws
- Hardcoded secrets, API keys, passwords
- Input validation and sanitization
- Data exposure and privacy violations
- Insecure dependencies
            `.trim(),
          },
          {
            name: "Performance Review",
            priority: "MAJOR",
            description: `
- N+1 database query patterns
- Missing indexes on queries
- Memory leaks and resource management
- Algorithm complexity (O(n²) or worse)
- Inefficient loops and iterations
- Missing caching opportunities
- Blocking I/O in async contexts
            `.trim(),
          },
          {
            name: "Code Quality",
            priority: "MAJOR",
            description: `
- SOLID principle violations
- Poor error handling
- Missing edge case handling
- Code duplication (DRY violations)
- Poor naming conventions
- Lack of modularity
- Insufficient logging
            `.trim(),
          },
        ],
        blockingCriteria: [], // Empty by default - no auto-blocking. Users can add custom criteria in their config.
        excludePatterns: [
          "*.lock",
          "*.svg",
          "*.min.js",
          "*.map",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
        ],
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
        instructions: `Enhance the PR description using Jira requirements and diff analysis.`,
        requiredSections: [
          {
            key: "summary",
            name: "📋 Summary",
            required: true,
            description: "Clear overview of what this PR accomplishes",
          },
          {
            key: "changes",
            name: "🔧 Changes Made",
            required: true,
            description: "Specific technical changes with file references",
          },
          {
            key: "jira",
            name: "🎫 Jira Reference",
            required: false,
            description: "Link to Jira ticket and requirement coverage",
          },
          {
            key: "testing",
            name: "🧪 Testing Strategy",
            required: true,
            description: "How changes were tested and validation approach",
          },
        ],
        preserveContent: true,
        autoFormat: true,
      },

      memoryBank: {
        enabled: true,
        path: "memory-bank",
        fallbackPaths: ["docs/memory-bank", ".memory-bank"],
        standardFiles: [
          "project-overview.md",
          "architecture.md",
          "coding-standards.md",
          "security-guidelines.md",
        ],
      },

      knowledgeBase: {
        enabled: true,
        path: ".yama/knowledge-base.md",
        aiAuthorPatterns: ["Yama", "yama-bot", "yama-review"],
        maxEntriesBeforeSummarization: 50,
        summaryRetentionCount: 20,
        autoCommit: false,
      },

      projectStandards: {
        customPromptsPath: "config/prompts/",
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
        exportPath: ".yama/analytics/",
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
  }
}
