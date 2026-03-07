#!/usr/bin/env node

/**
 * Yama CLI - AI-Native Code Review Interface
 */

import { Command } from "commander";
import dotenv from "dotenv";
import { VERSION, createYama } from "../index.js";
import { createLearningOrchestrator } from "../v2/core/LearningOrchestrator.js";
import type { LocalReviewRequest, ReviewRequest } from "../index.js";
import type { LearnRequest } from "../v2/learning/types.js";

// Load environment variables
dotenv.config();

const program = new Command();

/**
 * Setup CLI
 */
export function setupCLI(): Command {
  program
    .name("yama")
    .description("Yama - AI-Native Autonomous Code Review")
    .version(VERSION);

  // Global options
  program
    .option("-v, --verbose", "Enable verbose output")
    .option("-c, --config <path>", "Path to configuration file")
    .option("--dry-run", "Dry run mode - no actual changes")
    .option("--no-banner", "Hide Yama banner");

  // Commands
  setupReviewCommand();
  setupEnhanceCommand();
  setupLearnCommand();
  setupInitCommand();

  return program;
}

// Backward-compatible alias.
export const setupV2CLI = setupCLI;

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
    .option("--mode <mode>", "Review mode (pr|local)", "pr")
    .option("-w, --workspace <workspace>", "Bitbucket workspace")
    .option("-r, --repository <repository>", "Repository name")
    .option("-p, --pr <id>", "Pull request ID")
    .option("-b, --branch <branch>", "Branch name (finds PR automatically)")
    .option("--repo-path <path>", "Local repository path (local mode)")
    .option(
      "--diff-source <source>",
      "Diff source: staged | uncommitted | range (local mode)",
      "uncommitted",
    )
    .option("--base <ref>", "Base git ref for range diff (local mode)")
    .option("--head <ref>", "Head git ref for range diff (local mode)")
    .option(
      "--focus <areas>",
      "Comma-separated review focus areas (both modes)",
    )
    .option(
      "--output-schema-version <version>",
      "Output schema version for local mode JSON",
      "1.0",
    )
    .option(
      "--prompt <text>",
      "Additional review instruction prompt (both modes)",
    )
    .option("--review-only", "Skip description enhancement, only review code")
    .action(async (options) => {
      try {
        const globalOpts = program.opts();
        const mode = (options.mode || "pr").toLowerCase();
        const focus = options.focus
          ? String(options.focus)
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined;

        const yama = createYama({ configPath: globalOpts.config });

        if (mode === "local") {
          const request: LocalReviewRequest = {
            mode: "local",
            repoPath: options.repoPath,
            diffSource: options.diffSource,
            baseRef: options.base,
            headRef: options.head,
            dryRun: globalOpts.dryRun || false,
            verbose: globalOpts.verbose || false,
            configPath: globalOpts.config,
            prompt: options.prompt,
            focus,
            outputSchemaVersion: options.outputSchemaVersion,
          };

          console.log("🚀 Starting local SDK diff review...\n");
          const result = await yama.reviewLocalDiff(request);
          console.log("\n📊 Local Review Results:");
          console.log(`   Decision: ${result.decision}`);
          console.log(`   Files Changed: ${result.statistics.filesChanged}`);
          console.log(`   Issues: ${result.statistics.issuesFound}`);
          console.log(
            `   Enhancements: ${result.statistics.enhancementsFound}`,
          );
          console.log(`   Duration: ${result.duration}s`);
          console.log(
            `   Token Usage: ${result.tokenUsage.total.toLocaleString()} tokens`,
          );
          if (globalOpts.verbose) {
            console.log("\n📄 Full Results:");
            console.log(JSON.stringify(result, null, 2));
          }
          process.exit(result.decision === "BLOCKED" ? 1 : 0);
        }

        if (!options.workspace || !options.repository) {
          console.error(
            "❌ Error: --workspace and --repository are required in pr mode",
          );
          process.exit(1);
        }

        if (!options.pr && !options.branch) {
          console.error("❌ Error: Either --pr or --branch must be specified");
          process.exit(1);
        }

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
          mode: "pr",
          workspace: options.workspace,
          repository: options.repository,
          pullRequestId,
          branch: options.branch,
          dryRun: globalOpts.dryRun || false,
          verbose: globalOpts.verbose || false,
          configPath: globalOpts.config,
          prompt: options.prompt,
          focus,
          outputSchemaVersion: options.outputSchemaVersion,
        };

        await yama.initialize(request.configPath);

        console.log("🚀 Starting autonomous AI review...\n");

        const result = options.reviewOnly
          ? await yama.startReview(request)
          : await yama.startReviewAndEnhance(request);

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
        console.log(`   Duration: ${result.duration}s`);
        console.log(
          `   Token Usage: ${result.tokenUsage.total.toLocaleString()} tokens`,
        );

        if (globalOpts.verbose) {
          console.log("\n📄 Full Results:");
          console.log(JSON.stringify(result, null, 2));
        }

        process.exit(result.decision === "BLOCKED" ? 1 : 0);
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
          mode: "pr",
          workspace: options.workspace,
          repository: options.repository,
          pullRequestId,
          branch: options.branch,
          dryRun: globalOpts.dryRun || false,
          verbose: globalOpts.verbose || false,
          configPath: globalOpts.config,
        };

        const yama = createYama({ configPath: globalOpts.config });
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
 * Learn from PR feedback command
 * Extracts learnings from merged PRs to improve future reviews
 */
function setupLearnCommand(): void {
  program
    .command("learn")
    .description("Extract learnings from merged PR to improve future reviews")
    .requiredOption("-w, --workspace <workspace>", "Bitbucket workspace")
    .requiredOption("-r, --repository <repository>", "Repository name")
    .requiredOption("-p, --pr <id>", "Merged pull request ID")
    .option("--commit", "Auto-commit knowledge base changes to git")
    .option("--summarize", "Force summarization of knowledge base")
    .option("--output <path>", "Override knowledge base output path")
    .option(
      "--format <format>",
      "Output format for dry-run preview (md|json)",
      "md",
    )
    .action(async (options) => {
      try {
        const globalOpts = program.opts();

        const pullRequestId = parseInt(options.pr, 10);
        if (isNaN(pullRequestId)) {
          console.error(
            `❌ Error: Invalid PR ID "${options.pr}" (must be a number)`,
          );
          process.exit(1);
        }

        if (options.format && !["md", "json"].includes(options.format)) {
          console.error(
            `❌ Error: Invalid format "${options.format}" (must be md or json)`,
          );
          process.exit(1);
        }

        const request: LearnRequest = {
          workspace: options.workspace,
          repository: options.repository,
          pullRequestId,
          dryRun: globalOpts.dryRun || false,
          commit: options.commit || false,
          summarize: options.summarize || false,
          outputPath: options.output,
          outputFormat: options.format || "md",
        };

        const orchestrator = createLearningOrchestrator();
        await orchestrator.initialize(globalOpts.config);

        const result = await orchestrator.extractLearnings(request);

        if (!result.success) {
          console.error(`\n❌ Learning extraction failed: ${result.error}`);
          process.exit(1);
        }

        if (!globalOpts.dryRun && result.learningsAdded > 0) {
          console.log("\n🎉 Knowledge base updated successfully!");
          console.log(
            "   Use 'yama review' to apply these learnings to future reviews.",
          );
        }

        process.exit(0);
      } catch (error) {
        console.error(
          "\n❌ Learning extraction failed:",
          (error as Error).message,
        );
        if ((error as Error).stack && program.opts().verbose) {
          console.error("\nStack trace:");
          console.error((error as Error).stack);
        }
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
configType: "yama"

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

// Only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = setupCLI();
  cli.parse(process.argv);
}

export default program;
