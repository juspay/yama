#!/usr/bin/env node

/**
 * Yama CLI - Enhanced command line interface
 * Provides backward compatibility with pr-police.js and pr-describe.js
 * Plus new unified commands for the enhanced functionality
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

import { Guardian } from "../core/Guardian.js";
import { logger } from "../utils/Logger.js";
import { configManager } from "../utils/ConfigManager.js";
import { cache } from "../utils/Cache.js";
import {
  OperationType,
  OperationOptions,
  ReviewOptions,
  EnhancementOptions,
} from "../types/index.js";

// Load environment variables
dotenv.config();

const program = new Command();

// Package info
const packageInfo = {
  name: "@juspay/yama",
  version: "1.2.0",
  description: "Enterprise-grade Pull Request automation toolkit",
};

/**
 * Main CLI setup
 */
function setupCLI(): void {
  program
    .name("yama")
    .description(packageInfo.description)
    .version(packageInfo.version);

  // Global options
  program
    .option("-v, --verbose", "Enable verbose logging")
    .option("-c, --config <path>", "Path to configuration file")
    .option("--dry-run", "Preview mode - no changes made")
    .option("--no-cache", "Disable caching");

  // Configure help options (removed custom formatter to fix recursion)
  program.configureHelp({
    sortSubcommands: true,
  });

  // Setup commands
  setupProcessCommand();
  setupReviewCommand();
  setupEnhanceCommand();
  setupInitCommand();
  setupStatusCommand();
  setupCacheCommand();
  setupConfigCommand();

  // Backward compatibility aliases
  setupBackwardCompatibility();
}

/**
 * Main unified processing command
 */
function setupProcessCommand(): void {
  program
    .command("process")
    .description(
      "Process PR with multiple operations using unified context (NEW)",
    )
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .option("-b, --branch <branch>", "Branch name")
    .option("-p, --pr <id>", "Pull request ID")
    .option(
      "-o, --operations <operations>",
      "Operations to perform (review,enhance-description,all)",
      "all",
    )
    .option(
      "--exclude <patterns>",
      "Comma-separated exclude patterns",
      "*.lock,*.svg",
    )
    .option("--context-lines <number>", "Context lines for diff", "3")
    .action(async (options) => {
      try {
        await handleGlobalOptions(options);

        const operations = parseOperations(options.operations);
        const operationOptions: OperationOptions = {
          workspace: options.workspace,
          repository: options.repository,
          branch: options.branch,
          pullRequestId: options.pr,
          operations,
          dryRun: options.dryRun,
          verbose: options.verbose,
        };

        const guardian = new Guardian();
        await guardian.initialize(options.config);

        if (options.verbose) {
          // Use streaming for verbose mode
          console.log(chalk.blue("\n📡 Starting streaming processing...\n"));

          for await (const update of guardian.processPRStream(
            operationOptions,
          )) {
            logStreamUpdate(update);
          }
        } else {
          // Use regular processing
          const spinner = ora("Processing PR...").start();

          try {
            const result = await guardian.processPR(operationOptions);
            spinner.succeed("Processing completed");

            printProcessResult(result);
          } catch (error) {
            spinner.fail("Processing failed");
            throw error;
          }
        }
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Code review command (backward compatible with pr-police.js)
 */
function setupReviewCommand(): void {
  program
    .command("review")
    .alias("police") // Backward compatibility
    .description("AI-powered code review (equivalent to pr-police.js)")
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .option("-b, --branch <branch>", "Branch name")
    .option("-p, --pr <id>", "Pull request ID")
    .option(
      "--exclude <patterns>",
      "Comma-separated exclude patterns",
      "*.lock,*.svg",
    )
    .option("--context-lines <number>", "Context lines for diff", "3")
    .action(async (options) => {
      try {
        await handleGlobalOptions(options);

        const reviewOptions: ReviewOptions = {
          workspace: options.workspace,
          repository: options.repository,
          branch: options.branch,
          pullRequestId: options.pr,
          dryRun: options.dryRun,
          verbose: options.verbose,
          excludePatterns: options.exclude
            ?.split(",")
            .map((p: string) => p.trim()),
          contextLines: parseInt(options.contextLines),
        };

        const guardian = new Guardian();
        await guardian.initialize(options.config);

        const spinner = ora("Conducting code review...").start();

        try {
          const result = await guardian.reviewCode(reviewOptions);
          spinner.succeed("Code review completed");

          printReviewResult(result);
        } catch (error) {
          spinner.fail("Code review failed");
          throw error;
        }
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Description enhancement command (backward compatible with pr-describe.js)
 */
function setupEnhanceCommand(): void {
  program
    .command("enhance")
    .alias("scribe") // Backward compatibility
    .description(
      "AI-powered description enhancement (equivalent to pr-describe.js)",
    )
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .option("-b, --branch <branch>", "Branch name")
    .option("-p, --pr <id>", "Pull request ID")
    .option("--no-preserve", "Disable content preservation")
    .action(async (options) => {
      try {
        await handleGlobalOptions(options);

        const enhancementOptions: EnhancementOptions = {
          workspace: options.workspace,
          repository: options.repository,
          branch: options.branch,
          pullRequestId: options.pr,
          dryRun: options.dryRun,
          verbose: options.verbose,
          preserveContent: options.preserve !== false,
          ensureRequiredSections: true,
        };

        const guardian = new Guardian();
        await guardian.initialize(options.config);

        const spinner = ora("Enhancing PR description...").start();

        try {
          const result = await guardian.enhanceDescription(enhancementOptions);
          spinner.succeed("Description enhancement completed");

          printEnhancementResult(result);
        } catch (error) {
          spinner.fail("Description enhancement failed");
          throw error;
        }
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Initialize configuration command
 */
function setupInitCommand(): void {
  program
    .command("init")
    .description("Initialize Yama configuration")
    .option("-o, --output <path>", "Output configuration file path")
    .option("-i, --interactive", "Interactive configuration setup")
    .action(async (options) => {
      try {
        if (options.interactive) {
          await interactiveInit();
        } else {
          const configPath = await configManager.createDefaultConfig(
            options.output,
          );
          console.log(
            chalk.green(`✅ Configuration file created: ${configPath}`),
          );
          console.log(
            chalk.yellow(
              "💡 Edit the configuration file to customize settings",
            ),
          );
          console.log(
            chalk.blue(
              "📖 Visit https://github.com/juspay/yama for documentation",
            ),
          );
        }
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Status and health check command
 */
function setupStatusCommand(): void {
  program
    .command("status")
    .description("Check Yama status and health")
    .option("-d, --detailed", "Show detailed status information")
    .action(async (options) => {
      try {
        await handleGlobalOptions(options);

        const guardian = new Guardian();
        await guardian.initialize(options.config);

        const health = await guardian.healthCheck();
        const stats = guardian.getStats();

        console.log(chalk.cyan("\n🛡️ Yama Status\n"));

        // Health status
        const healthEmoji = health.healthy ? "✅" : "❌";
        console.log(
          `${healthEmoji} Overall Health: ${health.healthy ? "Healthy" : "Issues Detected"}`,
        );

        // Component status
        console.log("\n📊 Component Status:");
        Object.entries(health.components).forEach(
          ([component, status]: [string, any]) => {
            const emoji = status.healthy ? "✅" : "❌";
            console.log(
              `  ${emoji} ${component}: ${status.healthy ? "OK" : "Error"}`,
            );
          },
        );

        // Statistics
        if (options.detailed) {
          console.log("\n📈 Statistics:");
          console.log(JSON.stringify(stats, null, 2));
        }

        // Cache status
        const cacheStats = cache.stats();
        console.log(
          `\n💾 Cache: ${cacheStats.keys} keys, ${cacheStats.hits} hits, ${Math.round(cache.getHitRatio() * 100)}% hit ratio`,
        );
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Cache management command
 */
function setupCacheCommand(): void {
  const cacheCommand = program
    .command("cache")
    .description("Cache management operations");

  cacheCommand
    .command("clear")
    .description("Clear all caches")
    .action(() => {
      cache.clear();
      console.log(chalk.green("✅ All caches cleared"));
    });

  cacheCommand
    .command("stats")
    .description("Show cache statistics")
    .action(() => {
      const stats = cache.stats();
      const detailed = cache.debug();

      console.log(chalk.cyan("\n💾 Cache Statistics\n"));
      console.log(`Keys: ${stats.keys}`);
      console.log(`Hits: ${stats.hits}`);
      console.log(`Misses: ${stats.misses}`);
      console.log(`Hit Ratio: ${Math.round(cache.getHitRatio() * 100)}%`);

      console.log("\n📊 Detailed Stats:");
      console.log(JSON.stringify(detailed, null, 2));
    });
}

/**
 * Configuration management command
 */
function setupConfigCommand(): void {
  const configCommand = program
    .command("config")
    .description("Configuration management");

  configCommand
    .command("validate")
    .description("Validate configuration file")
    .option("-c, --config <path>", "Configuration file path")
    .action(async (options) => {
      try {
        await configManager.loadConfig(options.config);
        console.log(chalk.green("✅ Configuration is valid"));
      } catch (error) {
        console.error(
          chalk.red(`❌ Configuration error: ${(error as Error).message}`),
        );
        process.exit(1);
      }
    });

  configCommand
    .command("show")
    .description("Show current configuration")
    .option("-c, --config <path>", "Configuration file path")
    .action(async (options) => {
      try {
        const config = await configManager.loadConfig(options.config);
        console.log(chalk.cyan("\n⚙️ Current Configuration\n"));

        // Mask sensitive information
        const sanitizedConfig = { ...config };
        if (sanitizedConfig.providers?.git?.credentials?.token) {
          sanitizedConfig.providers.git.credentials.token = "***MASKED***";
        }

        console.log(JSON.stringify(sanitizedConfig, null, 2));
      } catch (error) {
        console.error(chalk.red(`❌ Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });
}

/**
 * Backward compatibility with original scripts
 */
function setupBackwardCompatibility(): void {
  // pr-police.js compatibility
  if (process.argv[1]?.includes("pr-police")) {
    // Redirect to review command
    const args = process.argv.slice(2);
    process.argv = ["node", "yama", "review", ...args];
  }

  // pr-describe.js / pr-scribe.js compatibility
  if (
    process.argv[1]?.includes("pr-scribe") ||
    process.argv[1]?.includes("pr-describe")
  ) {
    // Redirect to enhance command
    const args = process.argv.slice(2);
    process.argv = ["node", "yama", "enhance", ...args];
  }
}

/**
 * Utility functions
 */

async function handleGlobalOptions(options: any): Promise<void> {
  // Set up logging
  if (options.verbose) {
    logger.setVerbose(true);
    logger.setLevel("debug");
  }

  // Handle cache disabling
  if (options.cache === false) {
    cache.clear();
  }
}

function parseOperations(operationsStr: string): OperationType[] {
  const operationMap: Record<string, OperationType> = {
    review: "review",
    enhance: "enhance-description",
    "enhance-description": "enhance-description",
    security: "security-scan",
    "security-scan": "security-scan",
    analytics: "analytics",
    all: "all",
  };

  return operationsStr
    .split(",")
    .map((op) => op.trim())
    .map((op) => operationMap[op] || (op as OperationType))
    .filter((op) => op);
}

function logStreamUpdate(update: any): void {
  const timestamp = new Date(update.timestamp).toLocaleTimeString();
  const progressStr = update.progress ? ` (${update.progress}%)` : "";

  switch (update.status) {
    case "started":
      console.log(
        chalk.blue(`🚀 [${timestamp}] ${update.operation}: ${update.message}`),
      );
      break;
    case "progress":
      console.log(
        chalk.yellow(
          `🔄 [${timestamp}] ${update.operation}: ${update.message}${progressStr}`,
        ),
      );
      break;
    case "completed":
      console.log(
        chalk.green(
          `✅ [${timestamp}] ${update.operation}: ${update.message}${progressStr}`,
        ),
      );
      break;
    case "error":
      console.log(
        chalk.red(`❌ [${timestamp}] ${update.operation}: ${update.message}`),
      );
      break;
  }
}

function printProcessResult(result: any): void {
  console.log(chalk.cyan("\n🛡️ Yama Process Result\n"));

  console.log(`PR: #${result.pullRequest.id} - ${result.pullRequest.title}`);
  console.log(`Author: ${result.pullRequest.author}`);
  console.log(`Operations: ${result.operations.length}`);

  console.log("\n📊 Summary:");
  console.log(`✅ Success: ${result.summary.successCount}`);
  console.log(`❌ Errors: ${result.summary.errorCount}`);
  console.log(`⏭️ Skipped: ${result.summary.skippedCount}`);
  console.log(
    `⏱️ Total Duration: ${Math.round(result.summary.totalDuration / 1000)}s`,
  );

  // Show individual operation results
  console.log("\n📋 Operations:");
  result.operations.forEach((op: any) => {
    const emoji =
      op.status === "success" ? "✅" : op.status === "error" ? "❌" : "⏭️";
    console.log(
      `  ${emoji} ${op.operation}: ${op.status} (${Math.round(op.duration / 1000)}s)`,
    );

    if (op.error) {
      console.log(chalk.red(`    Error: ${op.error}`));
    }
  });
}

function printReviewResult(result: any): void {
  const stats = result.statistics;

  console.log(chalk.cyan("\n🛡️ Code Review Results\n"));
  console.log(`📊 Total Issues: ${stats.totalIssues}`);
  console.log(`🚨 Critical: ${stats.criticalCount}`);
  console.log(`⚠️ Major: ${stats.majorCount}`);
  console.log(`📝 Minor: ${stats.minorCount}`);
  console.log(`💡 Suggestions: ${stats.suggestionCount}`);
  console.log(`📁 Files Reviewed: ${stats.filesReviewed}`);

  if (stats.criticalCount > 0) {
    console.log(
      chalk.red("\n⛔ CRITICAL issues found - must fix before merge!"),
    );
  } else if (stats.majorCount > 0) {
    console.log(
      chalk.yellow("\n⚠️ Major issues found - should fix before merge"),
    );
  } else if (stats.minorCount > 0) {
    console.log(chalk.blue("\n📝 Minor improvements suggested"));
  } else {
    console.log(chalk.green("\n✅ Code quality approved!"));
  }
}

function printEnhancementResult(result: any): void {
  console.log(chalk.cyan("\n📝 Description Enhancement Results\n"));
  console.log(
    `📏 Original Length: ${result.statistics.originalLength} characters`,
  );
  console.log(
    `📏 Enhanced Length: ${result.statistics.enhancedLength} characters`,
  );
  console.log(
    `📋 Sections Completed: ${result.statistics.completedSections}/${result.statistics.totalSections}`,
  );

  if (result.sectionsAdded.length > 0) {
    console.log(`➕ Sections Added: ${result.sectionsAdded.join(", ")}`);
  }

  if (result.sectionsEnhanced.length > 0) {
    console.log(`✨ Sections Enhanced: ${result.sectionsEnhanced.join(", ")}`);
  }

  console.log(
    `📎 Content Preserved: ${result.preservedItems.media} media, ${result.preservedItems.files} files, ${result.preservedItems.links} links`,
  );

  if (result.statistics.completedSections === result.statistics.totalSections) {
    console.log(chalk.green("\n✅ All required sections completed!"));
  } else {
    console.log(
      chalk.yellow("\n⚠️ Some required sections may still need attention"),
    );
  }
}

async function interactiveInit(): Promise<void> {
  console.log(chalk.cyan("\n🛡️ Yama Interactive Setup\n"));

  await inquirer.prompt([
    {
      type: "input",
      name: "workspace",
      message: "Default Bitbucket workspace:",
      default: "YOUR_WORKSPACE",
    },
    {
      type: "input",
      name: "baseUrl",
      message: "Bitbucket server URL:",
      default: "https://your-bitbucket-server.com",
    },
    {
      type: "list",
      name: "aiProvider",
      message: "AI provider:",
      choices: ["auto", "google-ai", "openai", "anthropic"],
      default: "auto",
    },
    {
      type: "confirm",
      name: "enableAnalytics",
      message: "Enable AI analytics:",
      default: true,
    },
    {
      type: "confirm",
      name: "enableCache",
      message: "Enable caching:",
      default: true,
    },
  ]);

  const configPath = await configManager.createDefaultConfig();
  console.log(chalk.green(`\n✅ Configuration created: ${configPath}`));
  console.log(
    chalk.yellow("💡 Don't forget to set your environment variables:"),
  );
  console.log(chalk.blue("   BITBUCKET_USERNAME=your-username"));
  console.log(chalk.blue("   BITBUCKET_TOKEN=your-token"));
  console.log(chalk.blue("   GOOGLE_AI_API_KEY=your-api-key"));
}

/**
 * Main execution
 */
function main(): void {
  setupCLI();

  // Parse command line arguments
  program.parse();

  // Show help if no command provided
  if (!process.argv.slice(2).length) {
    program.outputHelp();
  }
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error(chalk.red(`\n💥 Uncaught Exception: ${error.message}`));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(chalk.red(`\n💥 Unhandled Rejection: ${reason}`));
  process.exit(1);
});

// Run if this is the main module
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}

export { main };
