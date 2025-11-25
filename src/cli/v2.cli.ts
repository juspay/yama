#!/usr/bin/env node

/**
 * Yama V2 CLI - AI-Native Code Review Interface
 * Command-line interface for autonomous AI-powered code review
 */

import { Command } from "commander";
import dotenv from "dotenv";
import { createYamaV2 } from "../v2/core/YamaV2Orchestrator.js";
import { ReviewRequest } from "../v2/types/v2.types.js";

// Load environment variables
dotenv.config();

const program = new Command();

/**
 * Setup V2 CLI
 */
export function setupV2CLI(): Command {
  program
    .name("yama")
    .description("Yama - AI-Native Autonomous Code Review")
    .version("2.0.0");

  // Global options
  program
    .option("-v, --verbose", "Enable verbose output")
    .option("-c, --config <path>", "Path to configuration file")
    .option("--dry-run", "Dry run mode - no actual changes")
    .option("--no-banner", "Hide Yama banner");

  // Review command
  setupReviewCommand();

  // Enhance description command
  setupEnhanceCommand();

  // Init command
  setupInitCommand();

  // Migrate config command
  setupMigrateCommand();

  return program;
}

/**
 * Main review command
 * Reviews code and enhances description in one session
 */
function setupReviewCommand(): void {
  program
    .command("review")
    .description(
      "Review code and enhance PR description (uses same AI session)",
    )
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .option("-p, --pr <id>", "Pull request ID")
    .option("-b, --branch <branch>", "Branch name (finds PR automatically)")
    .option("--review-only", "Skip description enhancement, only review code")
    .action(async (options) => {
      try {
        const globalOpts = program.opts();

        // Validate required options
        if (!options.pr && !options.branch) {
          console.error("❌ Error: Either --pr or --branch must be specified");
          process.exit(1);
        }

        // Parse PR ID with validation
        let pullRequestId: number | undefined;
        if (options.pr) {
          pullRequestId = parseInt(options.pr, 10);
          if (isNaN(pullRequestId)) {
            console.error(
              `❌ Error: Invalid PR ID "${options.pr}" (must be a number)`,
            );
            process.exit(1);
          }
        }

        const request: ReviewRequest = {
          workspace: options.workspace,
          repository: options.repository,
          pullRequestId,
          branch: options.branch,
          dryRun: globalOpts.dryRun || false,
          verbose: globalOpts.verbose || false,
          configPath: globalOpts.config,
        };

        // Create orchestrator
        const yama = createYamaV2();

        // Initialize
        await yama.initialize(request.configPath);

        // Start review (with or without description enhancement)
        console.log("🚀 Starting autonomous AI review...\n");

        const result = options.reviewOnly
          ? await yama.startReview(request)
          : await yama.startReviewAndEnhance(request);

        // Show results
        console.log("\n📊 Review Results:");
        console.log(`   Decision: ${result.decision}`);
        console.log(`   Files Reviewed: ${result.statistics.filesReviewed}`);
        console.log(
          `   Total Comments: ${result.totalComments || result.statistics.totalComments || 0}`,
        );
        if (result.descriptionEnhanced !== undefined) {
          console.log(
            `   Description Enhanced: ${result.descriptionEnhanced ? "✅ Yes" : "⏭️  Skipped"}`,
          );
        }
        console.log(`   Duration: ${Math.round(result.duration / 1000)}s`);
        console.log(
          `   Token Usage: ${result.tokenUsage.total.toLocaleString()} tokens`,
        );

        if (globalOpts.verbose) {
          console.log("\n📄 Full Results:");
          console.log(JSON.stringify(result, null, 2));
        }

        // Exit with appropriate code
        if (result.decision === "BLOCKED") {
          process.exit(1);
        } else {
          process.exit(0);
        }
      } catch (error) {
        console.error("\n❌ Review failed:", (error as Error).message);
        if ((error as Error).stack && program.opts().verbose) {
          console.error("\nStack trace:");
          console.error((error as Error).stack);
        }
        process.exit(1);
      }
    });
}

/**
 * Enhance description command
 */
function setupEnhanceCommand(): void {
  program
    .command("enhance")
    .description("Enhance PR description using AI (without full review)")
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .option("-p, --pr <id>", "Pull request ID")
    .option("-b, --branch <branch>", "Branch name")
    .action(async (options) => {
      try {
        const globalOpts = program.opts();

        if (!options.pr && !options.branch) {
          console.error("❌ Error: Either --pr or --branch must be specified");
          process.exit(1);
        }

        // Parse PR ID with validation
        let pullRequestId: number | undefined;
        if (options.pr) {
          pullRequestId = parseInt(options.pr, 10);
          if (isNaN(pullRequestId)) {
            console.error(
              `❌ Error: Invalid PR ID "${options.pr}" (must be a number)`,
            );
            process.exit(1);
          }
        }

        const request: ReviewRequest = {
          workspace: options.workspace,
          repository: options.repository,
          pullRequestId,
          branch: options.branch,
          dryRun: globalOpts.dryRun || false,
          verbose: globalOpts.verbose || false,
          configPath: globalOpts.config,
        };

        const yama = createYamaV2();
        await yama.initialize(request.configPath);

        const result = await yama.enhanceDescription(request);

        console.log("\n✅ Description enhanced successfully");
        console.log(JSON.stringify(result, null, 2));

        process.exit(0);
      } catch (error) {
        console.error("\n❌ Enhancement failed:", (error as Error).message);
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
    .option("--interactive", "Interactive configuration setup")
    .action(async (options) => {
      try {
        console.log("\n⚔️  Yama Configuration Setup\n");

        if (options.interactive) {
          console.log("Interactive setup not yet implemented.");
          console.log(
            "Please copy yama.config.example.yaml to yama.config.yaml",
          );
          console.log("and edit it manually.\n");
        } else {
          console.log("Creating default configuration file...\n");

          const fs = await import("fs/promises");
          const path = await import("path");

          // Check if config already exists
          if (
            await fs
              .access("yama.config.yaml")
              .then(() => true)
              .catch(() => false)
          ) {
            console.log("❌ yama.config.yaml already exists");
            console.log("   Remove it first or use a different location\n");
            process.exit(1);
          }

          // Copy example config
          const examplePath = path.join(
            process.cwd(),
            "yama.config.example.yaml",
          );
          const targetPath = path.join(process.cwd(), "yama.config.yaml");

          if (
            await fs
              .access(examplePath)
              .then(() => true)
              .catch(() => false)
          ) {
            await fs.copyFile(examplePath, targetPath);
            console.log("✅ Created yama.config.yaml from example");
          } else {
            console.log(
              "⚠️  Example config not found, creating minimal config...",
            );
            await fs.writeFile(
              targetPath,
              `version: 2
configType: "yama-v2"

ai:
  provider: "auto"
  model: "gemini-2.5-pro"

mcpServers:
  jira:
    enabled: false

review:
  enabled: true

descriptionEnhancement:
  enabled: true
`,
            );
            console.log("✅ Created minimal yama.config.yaml");
          }

          console.log("\n📝 Next steps:");
          console.log("   1. Edit yama.config.yaml with your settings");
          console.log("   2. Set environment variables (BITBUCKET_*, JIRA_*)");
          console.log("   3. Run: yama review --help\n");
        }

        process.exit(0);
      } catch (error) {
        console.error("\n❌ Initialization failed:", (error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Migrate V1 config to V2 format
 */
function setupMigrateCommand(): void {
  program
    .command("migrate-config")
    .description("Migrate V1 configuration to V2 format")
    .option("-i, --input <file>", "Input V1 config file", "yama.v1.config.yaml")
    .option("-o, --output <file>", "Output V2 config file", "yama.config.yaml")
    .option("--force", "Overwrite existing output file")
    .action(async (options) => {
      try {
        const globalOpts = program.opts();

        console.log("\n🔄 Yama V1 → V2 Configuration Migration\n");

        // Use child_process to run the migration script
        const { spawn } = await import("child_process");
        const path = await import("path");
        const { fileURLToPath } = await import("url");

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const scriptPath = path.resolve(
          __dirname,
          "../../scripts/migrate-config.cjs",
        );

        const args = ["--input", options.input, "--output", options.output];

        if (options.force) {
          args.push("--force");
        }

        if (globalOpts.dryRun) {
          args.push("--dry-run");
        }

        const child = spawn("node", [scriptPath, ...args], {
          stdio: "inherit",
          cwd: process.cwd(),
        });

        child.on("close", (code) => {
          process.exit(code || 0);
        });

        child.on("error", (err) => {
          console.error("❌ Failed to run migration script:", err.message);
          process.exit(1);
        });
      } catch (error) {
        console.error("\n❌ Migration failed:", (error as Error).message);
        process.exit(1);
      }
    });
}

// Only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = setupV2CLI();
  cli.parse(process.argv);
}

export default program;
