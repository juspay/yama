/**
 * Default Configuration for Yama
 * Provides sensible defaults when no config file is present
 */

import { YamaConfig } from "../types/index.js";

export class DefaultConfig {
  static get(): YamaConfig {
    return {
      version: 2,
      configType: "yama",

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
        // Sane output ceiling (NeuroLink clamps further per-model server-side).
        maxTokens: 32000,
        enableAnalytics: true,
        enableEvaluation: false,
        timeout: "15m",
        retryAttempts: 3,
        // Oversized MCP tool results (huge diffs) are externalized and paged
        // on demand instead of flooding the context window.
        mcpOutputLimits: {
          strategy: "externalize",
          maxBytes: 100_000,
          warnBytes: 50_000,
        },
        conversationMemory: {
          enabled: true,
          store: "memory",
          maxSessions: 50,
          maxTurnsPerSession: 300,
          enableSummarization: false,
          // Auto-compaction keeps long file-by-file reviews inside the model
          // context window (prune → dedup → summarize → sliding window).
          contextCompaction: {
            enabled: true,
            threshold: 0.8,
          },
        },
        explore: {
          enabled: true,
          provider: "auto",
          model: "gemini-2.5-flash",
          temperature: 0.1,
          // Lighter sub-task: sane output ceiling (NeuroLink clamps further per-model server-side).
          maxTokens: 16000,
          timeout: "5m",
          cacheResults: true,
        },
      },

      // MCP servers are defined ENTIRELY in config (`.yama/config.yaml` /
      // `.yama/mcp.json`) — never in code. No server commands, URLs, or tool
      // names are hardcoded here. Copy `.yama/mcp.example.json` (or the servers
      // block in `yama.config.example.yaml`) to configure bitbucket / github /
      // serena / local-git and their per-server blockedTools / allowedTools.
      mcpServers: {
        servers: {},
      },

      review: {
        enabled: true,
        verification: "basic",
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
        instructions: `Enhance the PR description using diff analysis.`,
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
        // `.yama/standards` is the consolidated location; the legacy roots stay
        // as fallbacks so existing repos keep working during migration.
        path: ".yama/standards",
        fallbackPaths: ["memory-bank", "docs/memory-bank", ".memory-bank"],
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

      memory: {
        enabled: false,
        storagePath: ".yama/memory",
        maxWords: 200,
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
        loop: {
          maxSteps: 100,
          toolTimeoutMs: 300_000,
        },
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
