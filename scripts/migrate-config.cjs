#!/usr/bin/env node
/**
 * Yama V1 → V2 Configuration Migration Script
 *
 * Migrates old yama.config.yaml (V1) to new V2 format.
 *
 * Usage:
 *   node scripts/migrate-config.cjs [options]
 *
 * Options:
 *   --input, -i    Input V1 config file (default: yama.v1.config.yaml)
 *   --output, -o   Output V2 config file (default: yama.config.yaml)
 *   --dry-run      Show migration without writing file
 *   --force        Overwrite existing output file
 *   --help, -h     Show help
 */

const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: "yama.v1.config.yaml",
    output: "yama.config.yaml",
    dryRun: false,
    force: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--input":
      case "-i":
        options.input = args[++i];
        break;
      case "--output":
      case "-o":
        options.output = args[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        // Treat first positional arg as input
        if (!arg.startsWith("-") && i === 0) {
          options.input = arg;
        }
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Yama V1 → V2 Configuration Migration Script

Usage:
  node scripts/migrate-config.cjs [options]
  npx yama migrate-config [options]

Options:
  --input, -i <file>   Input V1 config file (default: yama.v1.config.yaml)
  --output, -o <file>  Output V2 config file (default: yama.config.yaml)
  --dry-run            Show migration without writing file
  --force              Overwrite existing output file
  --help, -h           Show this help message

Examples:
  node scripts/migrate-config.cjs
  node scripts/migrate-config.cjs --input old-config.yaml --output new-config.yaml
  node scripts/migrate-config.cjs --dry-run
`);
}

// ============================================================================
// Migration Report
// ============================================================================

class MigrationReport {
  constructor() {
    this.migrated = [];
    this.transformed = [];
    this.dropped = [];
    this.warnings = [];
    this.newDefaults = [];
  }

  addMigrated(v1Path, v2Path) {
    this.migrated.push({ v1Path, v2Path });
  }

  addTransformed(v1Path, v2Path, reason) {
    this.transformed.push({ v1Path, v2Path, reason });
  }

  addDropped(v1Path, reason) {
    this.dropped.push({ v1Path, reason });
  }

  addWarning(message) {
    this.warnings.push(message);
  }

  addNewDefault(v2Path, value) {
    this.newDefaults.push({ v2Path, value });
  }

  print() {
    console.log("\n" + "═".repeat(60));
    console.log("📋 MIGRATION REPORT");
    console.log("═".repeat(60));

    if (this.migrated.length > 0) {
      console.log("\n✅ MIGRATED FIELDS (" + this.migrated.length + "):");
      this.migrated.forEach(({ v1Path, v2Path }) => {
        console.log(`   ${v1Path} → ${v2Path}`);
      });
    }

    if (this.transformed.length > 0) {
      console.log("\n⚠️  TRANSFORMED FIELDS (" + this.transformed.length + "):");
      this.transformed.forEach(({ v1Path, v2Path, reason }) => {
        console.log(`   ${v1Path} → ${v2Path}`);
        console.log(`      └─ ${reason}`);
      });
    }

    if (this.dropped.length > 0) {
      console.log("\n❌ DROPPED FIELDS (" + this.dropped.length + "):");
      this.dropped.forEach(({ v1Path, reason }) => {
        console.log(`   ${v1Path}`);
        console.log(`      └─ ${reason}`);
      });
    }

    if (this.newDefaults.length > 0) {
      console.log("\n🆕 NEW FIELDS (V2 defaults applied):");
      this.newDefaults.forEach(({ v2Path }) => {
        console.log(`   ${v2Path}`);
      });
    }

    if (this.warnings.length > 0) {
      console.log("\n⚡ WARNINGS:");
      this.warnings.forEach((msg) => {
        console.log(`   ${msg}`);
      });
    }

    console.log("\n" + "═".repeat(60));
  }
}

// ============================================================================
// V1 Config Parsing
// ============================================================================

function parseV1Config(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`V1 config file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const config = yaml.parse(content);

  return config;
}

function validateV1Structure(config) {
  const issues = [];

  // Check for V1 indicators
  if (config.version === 2 || config.configType === "yama-v2") {
    throw new Error("This config appears to already be V2 format");
  }

  // V1 should have providers or features
  if (!config.providers && !config.features) {
    issues.push("Missing 'providers' or 'features' section (V1 indicators)");
  }

  if (issues.length > 0) {
    console.warn("⚠️  V1 validation warnings:");
    issues.forEach((issue) => console.warn(`   - ${issue}`));
  }

  return issues.length === 0;
}

// ============================================================================
// Migration Functions
// ============================================================================

function migrateAIConfig(v1Config, report) {
  const v1AI = v1Config.providers?.ai || {};
  const v2AI = {
    provider: mapProvider(v1AI.provider || "auto"),
    model: v1AI.model || "gemini-2.5-pro",
    temperature: v1AI.temperature ?? 0.2,
    maxTokens: v1AI.maxTokens || 128000,
    enableAnalytics: v1AI.enableAnalytics ?? true,
    enableEvaluation: v1AI.enableEvaluation ?? false,
    timeout: v1AI.timeout || "15m",
    retryAttempts: v1AI.retryAttempts || 3,
    conversationMemory: {
      enabled: true,
      store: "memory",
      maxSessions: 50,
      maxTurnsPerSession: 300,
      enableSummarization: false,
    },
  };

  // Report migrations
  if (v1AI.provider) report.addMigrated("providers.ai.provider", "ai.provider");
  if (v1AI.model) report.addMigrated("providers.ai.model", "ai.model");
  if (v1AI.temperature !== undefined)
    report.addMigrated("providers.ai.temperature", "ai.temperature");
  if (v1AI.maxTokens) report.addMigrated("providers.ai.maxTokens", "ai.maxTokens");
  if (v1AI.timeout) report.addMigrated("providers.ai.timeout", "ai.timeout");
  if (v1AI.retryAttempts)
    report.addMigrated("providers.ai.retryAttempts", "ai.retryAttempts");
  if (v1AI.enableAnalytics !== undefined)
    report.addMigrated("providers.ai.enableAnalytics", "ai.enableAnalytics");
  if (v1AI.enableEvaluation !== undefined)
    report.addMigrated("providers.ai.enableEvaluation", "ai.enableEvaluation");

  // Report new defaults
  report.addNewDefault("ai.conversationMemory", "(V2 feature)");

  // Report dropped
  if (v1AI.enableFallback !== undefined) {
    report.addDropped("providers.ai.enableFallback", "V2 uses automatic retry instead");
  }

  return v2AI;
}

function mapProvider(v1Provider) {
  const providerMap = {
    "google-ai": "google-ai",
    anthropic: "anthropic",
    openai: "openai",
    bedrock: "bedrock",
    azure: "azure",
  };
  return providerMap[v1Provider] || "auto";
}

function migrateReviewConfig(v1Config, report) {
  const v1Review = v1Config.features?.codeReview || {};

  const v2Review = {
    enabled: v1Review.enabled ?? true,
    workflowInstructions: extractWorkflowInstructions(v1Review.systemPrompt, report),
    focusAreas: extractFocusAreas(v1Review, report),
    blockingCriteria: getDefaultBlockingCriteria(),
    excludePatterns: v1Review.excludePatterns || [
      "*.lock",
      "*.svg",
      "*.min.js",
      "*.map",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ],
    contextLines: v1Review.contextLines || 3,
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
  };

  // Report migrations
  if (v1Review.enabled !== undefined)
    report.addMigrated("features.codeReview.enabled", "review.enabled");
  if (v1Review.excludePatterns)
    report.addMigrated("features.codeReview.excludePatterns", "review.excludePatterns");
  if (v1Review.contextLines)
    report.addMigrated("features.codeReview.contextLines", "review.contextLines");

  // Report new defaults
  report.addNewDefault("review.blockingCriteria", "(V2 feature)");
  report.addNewDefault("review.toolPreferences", "(V2 feature)");
  report.addNewDefault("review.maxFilesPerReview", "100");
  report.addNewDefault("review.fileAnalysisTimeout", "2m");

  // Report dropped V1 features
  if (v1Review.batchProcessing) {
    report.addDropped(
      "features.codeReview.batchProcessing",
      "V2 AI handles batching autonomously"
    );
  }
  if (v1Review.multiInstance) {
    report.addDropped(
      "features.codeReview.multiInstance",
      "V2 uses single autonomous agent model"
    );
  }
  if (v1Review.semanticDeduplication) {
    report.addDropped(
      "features.codeReview.semanticDeduplication",
      "V2 AI deduplicates naturally"
    );
  }
  if (v1Review.severityLevels) {
    report.addDropped(
      "features.codeReview.severityLevels",
      "Hardcoded in V2 (CRITICAL, MAJOR, MINOR, SUGGESTION)"
    );
  }
  if (v1Review.categories) {
    report.addTransformed(
      "features.codeReview.categories",
      "review.focusAreas",
      "Merged into focusAreas descriptions"
    );
  }

  return v2Review;
}

function extractWorkflowInstructions(systemPrompt, report) {
  if (!systemPrompt) {
    return "Follow the autonomous review workflow defined in the base system prompt.";
  }

  report.addTransformed(
    "features.codeReview.systemPrompt",
    "review.workflowInstructions",
    "Long system prompt converted to workflow instructions"
  );

  // Extract a shorter workflow instruction from the long system prompt
  // Keep just the key workflow parts, not the detailed rules
  return `Follow the autonomous review workflow defined in the base system prompt.

Project-specific focus from V1 config:
- Security vulnerabilities and data protection (CRITICAL)
- Performance bottlenecks and optimization opportunities
- Maintainable, readable, and robust code
- Comprehensive error handling and edge cases`;
}

function extractFocusAreas(v1Review, report) {
  const focusAreas = [];

  // Check if V1 has focusAreas as string array (emoji format)
  if (v1Review.focusAreas && Array.isArray(v1Review.focusAreas)) {
    v1Review.focusAreas.forEach((area) => {
      if (typeof area === "string") {
        // Parse emoji-prefixed strings like "🔒 Security Analysis (CRITICAL PRIORITY)"
        const parsed = parseEmojiArea(area);
        if (parsed) {
          focusAreas.push(parsed);
        }
      } else if (typeof area === "object" && area.name) {
        // Already structured
        focusAreas.push({
          name: area.name,
          priority: area.priority || "MAJOR",
          description: area.description || "",
        });
      }
    });

    report.addTransformed(
      "features.codeReview.focusAreas",
      "review.focusAreas",
      "Converted to structured format with priority and description"
    );
  }

  // If no focus areas extracted, use defaults
  if (focusAreas.length === 0) {
    return getDefaultFocusAreas();
  }

  return focusAreas;
}

function parseEmojiArea(areaString) {
  // Parse strings like "🔒 Security Analysis (CRITICAL PRIORITY)"
  // Remove leading emoji (any character that's not a letter, number, or space at start)
  const withoutEmoji = areaString.replace(/^[^\w\s]+\s*/, "").trim();

  // Extract name and priority hint
  const match = withoutEmoji.match(/^(.+?)(?:\s*\((.+?)\s*(?:PRIORITY)?\))?$/);
  if (match) {
    const name = match[1].trim();
    const priorityHint = match[2]?.toUpperCase() || "";
    const priority = priorityHint.includes("CRITICAL") ? "CRITICAL" : "MAJOR";

    return {
      name,
      priority,
      description: getDescriptionForArea(name),
    };
  }
  return null;
}

function getDescriptionForArea(name) {
  const descriptions = {
    "Security Analysis": `- SQL/NoSQL injection vulnerabilities
- Cross-Site Scripting (XSS)
- Authentication/Authorization flaws
- Hardcoded secrets, API keys, passwords
- Input validation and sanitization`,
    "Performance Review": `- N+1 database query patterns
- Memory leaks and resource management
- Algorithm complexity issues
- Missing caching opportunities`,
    "Code Quality": `- SOLID principle violations
- Poor error handling
- Code duplication (DRY violations)
- Poor naming conventions`,
    "Testing & Error Handling": `- Missing test coverage
- Unhandled edge cases
- Poor error messages
- Missing validation`,
  };

  return descriptions[name] || "";
}

function getDefaultFocusAreas() {
  return [
    {
      name: "Security Analysis",
      priority: "CRITICAL",
      description: `- SQL/NoSQL injection vulnerabilities
- Cross-Site Scripting (XSS)
- Authentication/Authorization flaws
- Hardcoded secrets, API keys, passwords
- Input validation and sanitization
- Data exposure and privacy violations`,
    },
    {
      name: "Performance Review",
      priority: "MAJOR",
      description: `- N+1 database query patterns
- Memory leaks and resource management
- Algorithm complexity issues
- Missing caching opportunities
- Blocking I/O in async contexts`,
    },
    {
      name: "Code Quality",
      priority: "MAJOR",
      description: `- SOLID principle violations
- Poor error handling
- Code duplication (DRY violations)
- Poor naming conventions
- Missing edge case handling`,
    },
  ];
}

function getDefaultBlockingCriteria() {
  return [
    {
      condition: "ANY CRITICAL severity issue",
      action: "BLOCK",
      reason: "Security or data loss risk",
    },
    {
      condition: "3 or more MAJOR severity issues",
      action: "BLOCK",
      reason: "Too many significant bugs/performance issues",
    },
    {
      condition: "Jira requirement coverage < 70% (only when Jira is enabled)",
      action: "BLOCK",
      reason: "Incomplete implementation of requirements",
    },
  ];
}

function migrateEnhancementConfig(v1Config, report) {
  const v1Enh = v1Config.features?.descriptionEnhancement || {};

  const v2Enh = {
    enabled: v1Enh.enabled ?? true,
    instructions: extractEnhancementInstructions(v1Enh, report),
    requiredSections: migrateRequiredSections(v1Enh.requiredSections, report),
    preserveContent: v1Enh.preserveContent ?? true,
    autoFormat: v1Enh.autoFormat ?? true,
  };

  // Report migrations
  if (v1Enh.enabled !== undefined)
    report.addMigrated(
      "features.descriptionEnhancement.enabled",
      "descriptionEnhancement.enabled"
    );
  if (v1Enh.preserveContent !== undefined)
    report.addMigrated(
      "features.descriptionEnhancement.preserveContent",
      "descriptionEnhancement.preserveContent"
    );
  if (v1Enh.autoFormat !== undefined)
    report.addMigrated(
      "features.descriptionEnhancement.autoFormat",
      "descriptionEnhancement.autoFormat"
    );

  // Report dropped
  if (v1Enh.outputTemplate) {
    report.addDropped(
      "features.descriptionEnhancement.outputTemplate",
      "V2 generates structure from requiredSections"
    );
  }

  return v2Enh;
}

function extractEnhancementInstructions(v1Enh, report) {
  if (v1Enh.systemPrompt || v1Enh.enhancementInstructions) {
    report.addTransformed(
      "features.descriptionEnhancement.systemPrompt",
      "descriptionEnhancement.instructions",
      "Simplified to workflow instructions"
    );
  }

  return `Enhance the PR description using Jira requirements and diff analysis.
Generate comprehensive, well-structured description with all required sections.`;
}

function migrateRequiredSections(v1Sections, report) {
  if (!v1Sections || v1Sections.length === 0) {
    return getDefaultRequiredSections();
  }

  report.addTransformed(
    "features.descriptionEnhancement.requiredSections",
    "descriptionEnhancement.requiredSections",
    "Added description field to each section"
  );

  return v1Sections.map((section) => ({
    key: section.key || section.name?.toLowerCase().replace(/\s+/g, "_"),
    name: addEmojiToSection(section.name || section.key),
    required: section.required ?? true,
    description: section.description || getDefaultSectionDescription(section.key),
  }));
}

function addEmojiToSection(name) {
  const emojiMap = {
    summary: "📋 Summary",
    changelog: "📝 Changelog",
    changes: "🔧 Changes Made",
    testcases: "🧪 Test Cases",
    testing: "🧪 Testing Strategy",
    config_changes: "⚙️ Config Changes",
    jira: "🎫 Jira Reference",
    impact: "⚡ Impact & Considerations",
  };

  const key = name.toLowerCase().replace(/\s+/g, "_");
  return emojiMap[key] || name;
}

function getDefaultSectionDescription(key) {
  const descriptions = {
    summary: "Clear overview of what this PR accomplishes",
    changelog: "Modules and components modified",
    changes: "Specific technical changes with file references",
    testcases: "Test cases and scenarios to validate",
    testing: "How changes were tested and validation approach",
    config_changes: "CAC or service configuration changes",
    jira: "Link to Jira ticket and requirement coverage",
    impact: "Business impact, performance implications, breaking changes",
  };

  return descriptions[key] || "";
}

function getDefaultRequiredSections() {
  return [
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
  ];
}

function migrateMonitoringConfig(v1Config, report) {
  const v1Mon = v1Config.monitoring || {};
  const v1Rep = v1Config.reporting || {};

  const v2Mon = {
    enabled: v1Mon.enabled ?? true,
    logToolCalls: true,
    logAIDecisions: true,
    logTokenUsage: true,
    exportFormat: v1Mon.exportFormat || v1Rep.formats?.[0] || "json",
    exportPath: ".yama/analytics/",
  };

  // Report migrations
  if (v1Mon.enabled !== undefined)
    report.addMigrated("monitoring.enabled", "monitoring.enabled");
  if (v1Mon.exportFormat)
    report.addMigrated("monitoring.exportFormat", "monitoring.exportFormat");

  // Report merged
  if (v1Rep.formats) {
    report.addTransformed(
      "reporting.formats",
      "monitoring.exportFormat",
      "Only first format used in V2"
    );
  }

  // Report dropped
  if (v1Mon.metrics) {
    report.addDropped("monitoring.metrics", "V2 logs all metrics by default");
  }
  if (v1Mon.interval) {
    report.addDropped("monitoring.interval", "V2 logs in real-time");
  }
  if (v1Rep.includeAnalytics !== undefined) {
    report.addDropped("reporting.includeAnalytics", "Always included in V2");
  }

  // Report new defaults
  report.addNewDefault("monitoring.logToolCalls", "true");
  report.addNewDefault("monitoring.logAIDecisions", "true");
  report.addNewDefault("monitoring.logTokenUsage", "true");

  return v2Mon;
}

function migratePerformanceConfig(v1Config, report) {
  const v1Perf = v1Config.performance || {};

  const v2Perf = {
    maxReviewDuration: "15m",
    tokenBudget: {
      maxTokensPerReview: 500000,
      warningThreshold: 400000,
    },
    costControls: {
      maxCostPerReview: 2.0,
      warningThreshold: 1.5,
    },
  };

  // Report dropped V1 performance settings
  if (v1Perf.batch) {
    report.addDropped("performance.batch", "V2 AI handles batching autonomously");
  }
  if (v1Perf.optimization) {
    report.addDropped("performance.optimization", "V2 uses MCP optimizations");
  }

  // Report new defaults
  report.addNewDefault("performance.maxReviewDuration", "15m");
  report.addNewDefault("performance.tokenBudget", "(V2 feature)");
  report.addNewDefault("performance.costControls", "(V2 feature)");

  return v2Perf;
}

function migrateGitConfig(v1Config, report) {
  const v1Git = v1Config.providers?.git || {};

  if (v1Git.platform || v1Git.credentials) {
    report.addDropped(
      "providers.git",
      "V2 uses MCP servers (configured via environment variables)"
    );
    report.addWarning(
      "Git credentials should be set via BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD env vars"
    );
  }
}

function migrateRulesConfig(v1Config, report) {
  const v1Rules = v1Config.rules || {};

  if (v1Rules.security || v1Rules.performance) {
    report.addTransformed(
      "rules",
      "projectStandards.additionalFocusAreas",
      "Custom rules can be added as focus areas in V2"
    );
  }
}

function migrateCacheConfig(v1Config, report) {
  if (v1Config.cache) {
    report.addDropped("cache", "V2 MCP tools handle caching internally");
  }
}

function migrateSecurityScanConfig(v1Config, report) {
  if (v1Config.features?.securityScan) {
    report.addDropped(
      "features.securityScan",
      "V2 AI performs security analysis as part of review"
    );
  }
}

function migrateAnalyticsConfig(v1Config, report) {
  if (v1Config.features?.analytics) {
    report.addTransformed(
      "features.analytics",
      "monitoring",
      "Analytics merged into monitoring in V2"
    );
  }
}

// ============================================================================
// V2 Config Generation
// ============================================================================

function generateV2Config(v1Config) {
  const report = new MigrationReport();

  // Migrate each section
  const v2Config = {
    version: 2,
    configType: "yama-v2",

    display: {
      showBanner: true,
      streamingMode: false,
      verboseToolCalls: false,
      showAIThinking: false,
    },

    ai: migrateAIConfig(v1Config, report),

    mcpServers: {
      jira: {
        enabled: false,
      },
    },

    review: migrateReviewConfig(v1Config, report),

    descriptionEnhancement: migrateEnhancementConfig(v1Config, report),

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

    projectStandards: {
      customPromptsPath: "config/prompts/",
      additionalFocusAreas: [],
      customBlockingRules: [],
      severityOverrides: {},
    },

    monitoring: migrateMonitoringConfig(v1Config, report),

    performance: migratePerformanceConfig(v1Config, report),
  };

  // Handle other V1 sections that get dropped/transformed
  migrateGitConfig(v1Config, report);
  migrateRulesConfig(v1Config, report);
  migrateCacheConfig(v1Config, report);
  migrateSecurityScanConfig(v1Config, report);
  migrateAnalyticsConfig(v1Config, report);

  // Report new V2-only sections
  report.addNewDefault("display", "(V2 streaming/verbosity controls)");
  report.addNewDefault("mcpServers", "(V2 MCP integration)");
  report.addNewDefault("memoryBank", "(V2 project context feature)");
  report.addNewDefault("projectStandards", "(V2 customization)");

  return { config: v2Config, report };
}

// ============================================================================
// Output
// ============================================================================

function writeV2Config(v2Config, outputPath, dryRun) {
  const yamlContent = generateYamlWithComments(v2Config);

  if (dryRun) {
    console.log("\n📄 Generated V2 Config (dry-run):\n");
    console.log(yamlContent);
    return;
  }

  fs.writeFileSync(outputPath, yamlContent, "utf8");
  console.log(`\n✅ V2 config written to: ${outputPath}`);
}

function generateYamlWithComments(config) {
  const header = `# Yama V2 Configuration
# Migrated from V1 format
# Documentation: https://github.com/juspay/yama/blob/main/docs/v2/README.md

`;

  const doc = new yaml.Document(config);

  // Add comments to sections
  const visit = (node, path = []) => {
    if (yaml.isMap(node)) {
      for (const pair of node.items) {
        const key = pair.key?.value;
        const comment = getSectionComment(key);
        if (comment && path.length === 0) {
          pair.key.commentBefore = `\n${comment}`;
        }
      }
    }
  };

  yaml.visit(doc, { Map: visit });

  return header + doc.toString();
}

function getSectionComment(key) {
  const comments = {
    display: "============================================================================\nDisplay & Streaming Configuration\n============================================================================",
    ai: "============================================================================\nAI Configuration\n============================================================================",
    mcpServers: "============================================================================\nMCP Servers Configuration\n============================================================================",
    review: "============================================================================\nReview Configuration\n============================================================================",
    descriptionEnhancement: "============================================================================\nPR Description Enhancement\n============================================================================",
    memoryBank: "============================================================================\nMemory Bank & Project Context\n============================================================================",
    projectStandards: "============================================================================\nProject-Specific Standards\n============================================================================",
    monitoring: "============================================================================\nMonitoring & Analytics\n============================================================================",
    performance: "============================================================================\nPerformance & Cost Controls\n============================================================================",
  };

  return comments[key] || null;
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  console.log("🔄 Yama V1 → V2 Configuration Migration");
  console.log("─".repeat(40));

  // Check input file
  const inputPath = path.resolve(process.cwd(), options.input);
  console.log(`📥 Input:  ${inputPath}`);

  if (!fs.existsSync(inputPath)) {
    console.error(`\n❌ Error: Input file not found: ${inputPath}`);
    console.log("\nLooking for V1 config files...");

    // Try to find V1 config
    const candidates = [
      "yama.v1.config.yaml",
      "yama.config.yaml",
      ".yama.config.yaml",
      "yama.config.yml",
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        console.log(`   Found: ${candidate}`);
      }
    }

    console.log("\nUsage: node scripts/migrate-config.cjs --input <v1-config-file>");
    process.exit(1);
  }

  // Check output file
  const outputPath = path.resolve(process.cwd(), options.output);
  console.log(`📤 Output: ${outputPath}`);

  if (fs.existsSync(outputPath) && !options.force && !options.dryRun) {
    console.error(`\n❌ Error: Output file already exists: ${outputPath}`);
    console.log("   Use --force to overwrite or --dry-run to preview");
    process.exit(1);
  }

  // Parse V1 config
  console.log("\n📖 Reading V1 config...");
  const v1Config = parseV1Config(inputPath);

  // Validate V1 structure
  validateV1Structure(v1Config);

  // Generate V2 config
  console.log("🔧 Migrating to V2 format...");
  const { config: v2Config, report } = generateV2Config(v1Config);

  // Print migration report
  report.print();

  // Write output
  writeV2Config(v2Config, outputPath, options.dryRun);

  if (!options.dryRun) {
    console.log("\n🎉 Migration complete!");
    console.log("\nNext steps:");
    console.log("   1. Review the generated config");
    console.log("   2. Set environment variables for MCP servers:");
    console.log("      - BITBUCKET_USERNAME, BITBUCKET_APP_PASSWORD, BITBUCKET_BASE_URL");
    console.log("      - JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL (if using Jira)");
    console.log("   3. Test with: npx yama review --dry-run");
  }
}

main();
