#!/usr/bin/env node
import { resolve } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { ConfigError } from "../config/index.js";
import {
  newRunId,
  renderDoctorReport,
  renderInitResult,
  renderLearnResult,
  renderRunSummary,
  runDoctor,
  runLearn,
  runReview,
  scaffold,
} from "../core/index.js";
import { exitCodeFor } from "../gates/index.js";
import { resolveStorePaths, writeJson } from "../store/index.js";
import type { InitPlatform, RunTarget } from "../types/index.js";
import { EXIT_CODES } from "./exitCodes.js";

const say = (...lines: readonly string[]): void => {
  process.stdout.write(`${lines.join("\n")}\n`);
};

const complain = (...lines: readonly string[]): void => {
  process.stderr.write(`${lines.join("\n")}\n`);
};

/**
 * Exit as soon as the command is finished, once its output has actually left this
 * process (TASKS:Y6.1).
 *
 * Setting `process.exitCode` and letting the event loop drain is the usual shape, and it
 * is wrong here: an MCP server Yama connected to is a live child process, and nothing in
 * a review's path disconnects it. So a `review` or a `learn` against a real forge printed
 * its whole answer and then held the CI job open until the job's own timeout killed it —
 * with the exit code lost, which is the one thing CI reads.
 *
 * The exit is therefore explicit. The nested drain callbacks are what keep it honest: on a
 * pipe, `write` is asynchronous, and exiting before it has flushed would cut the answer
 * short. Every handler above awaits its file writes before returning, so by the time this
 * runs there is nothing else outstanding.
 */
const finish = (): void => {
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.stdout.write("", () => {
    process.stderr.write("", () => {
      process.exit(code);
    });
  });
};

const targetOf = (
  pr: number | undefined,
  branch: string | undefined,
  base: string | undefined,
): RunTarget => {
  if (pr !== undefined) {
    return { mode: "pr", pr, ...(base !== undefined ? { base } : {}) };
  }
  if (branch !== undefined) {
    return { mode: "branch", branch, ...(base !== undefined ? { base } : {}) };
  }
  return { mode: "local" };
};

const targetLabel = (target: RunTarget): string => {
  switch (target.mode) {
    case "pr":
      return `PR #${target.pr}`;
    case "branch":
      return `branch ${target.branch}`;
    default:
      return "the local diff";
  }
};

await yargs(hideBin(process.argv))
  .scriptName("yama")
  .usage("$0 <command> [options]")
  .command(
    "review",
    "Review a pull request, a branch, or the local diff",
    (y) =>
      y
        .option("pr", { type: "number", describe: "Pull request number" })
        .option("branch", {
          type: "string",
          describe: "Branch to review against its base",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe: "Analyse only; deliver nothing to the platform",
        })
        .option("base", {
          type: "string",
          describe:
            "Ref the change is going into; the diff is merge-base(base, head)..head",
        })
        .option("json", {
          type: "string",
          describe: "Write the review result JSON to this path",
        })
        .conflicts("pr", "branch"),
    async (argv) => {
      const target = targetOf(argv.pr, argv.branch, argv.base);
      const root = process.cwd();
      const storeDir = resolveStorePaths(root, target).dir;
      say(
        `yama review — ${targetLabel(target)}${argv.dryRun ? " (dry run: nothing will be delivered)" : ""}`,
        `  repository: ${root}`,
        `  run store:  ${storeDir}`,
        "",
      );

      try {
        const result = await runReview({
          runId: newRunId(),
          target,
          root,
          storeDir,
          dryRun: argv.dryRun,
        });
        say(renderRunSummary(result.report, storeDir));
        if (argv.json !== undefined) {
          const file = await writeJson(resolve(argv.json), result);
          say("", `findings and run report written to ${file}`);
        }
        // A verdict that failed to DELIVER is a failed run, not a delivered verdict:
        // exit 1 is a pure function of the decision, and a workflow that reads 1 as
        // "BLOCK was posted as a review" needs that to be TRUE. Skipped delivery (a
        // dry run, no actions) records no failure and is not one.
        const deliveryFailure = result.report.delivery?.failure;
        if (deliveryFailure !== undefined && deliveryFailure.length > 0) {
          complain(
            "yama review: the verdict was decided but delivery did not land as intended:",
            deliveryFailure,
            `The run store keeps what did happen: ${storeDir}`,
          );
          process.exitCode = EXIT_CODES.runError;
        } else if (
          !argv.dryRun &&
          result.verdict.decision === "block" &&
          result.report.delivery?.verdictProofRequired === true &&
          result.report.delivery?.verdictSet !== true
        ) {
          // The exit-code contract a CI gates on: 1 means a DELIVERED block. A repo
          // that maps verdict.set is promising the block arrives as the review state;
          // exiting 1 without that proof would let a workflow green an invisible block.
          complain(
            "yama review: verdict BLOCK was decided but never proven as the pull request's review state",
            `The run store keeps what did happen: ${storeDir}`,
          );
          process.exitCode = EXIT_CODES.runError;
        } else {
          process.exitCode = exitCodeFor(result.verdict);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        complain(
          error instanceof ConfigError
            ? `yama review: ${message}`
            : `yama review failed: ${message}`,
          `The run store keeps what did happen: ${storeDir}`,
        );
        process.exitCode =
          error instanceof ConfigError
            ? EXIT_CODES.configError
            : EXIT_CODES.runError;
      }
    },
  )
  .command(
    "init",
    "Scaffold .yama/ config and CI examples",
    (y) =>
      y
        .option("platform", {
          type: "string",
          choices: ["github", "bitbucket", "none"] as const,
          default: "github" as const,
          describe: "Which capability map to scaffold into .yama/mcp.yaml",
        })
        .option("force", {
          type: "boolean",
          default: false,
          describe: "Replace files that already exist",
        }),
    async (argv) => {
      try {
        const result = await scaffold({
          root: process.cwd(),
          platform: argv.platform as InitPlatform,
          force: argv.force,
        });
        say(renderInitResult(result));
        process.exitCode = EXIT_CODES.ok;
      } catch (error) {
        complain(
          `yama init failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = EXIT_CODES.runError;
      }
    },
  )
  .command(
    "doctor",
    "Probe config, MCP servers and capabilities",
    (y) =>
      y
        .option("pr", {
          type: "number",
          describe: "Probe as if reviewing this pull request",
        })
        .option("branch", {
          type: "string",
          describe: "Probe as if reviewing this branch",
        })
        .option("base", {
          type: "string",
          describe: "Base ref the change would go into",
        })
        .conflicts("pr", "branch"),
    async (argv) => {
      const report = await runDoctor({
        root: process.cwd(),
        target: targetOf(argv.pr, argv.branch, argv.base),
      });
      say(renderDoctorReport(report));
      process.exitCode = report.ok ? EXIT_CODES.ok : EXIT_CODES.configError;
    },
  )
  .command(
    "learn",
    "Post-merge memory and knowledge update",
    (y) =>
      y
        .option("pr", {
          type: "number",
          demandOption: true,
          describe: "Merged PR number",
        })
        .option("dry-run", {
          type: "boolean",
          default: false,
          describe:
            "Read and triage, then print the commit that would be made. Writes nothing",
        })
        .option("json", {
          type: "string",
          describe: "Write the learn result JSON to this path",
        }),
    async (argv) => {
      const root = process.cwd();
      try {
        const result = await runLearn({
          root,
          pr: argv.pr,
          dryRun: argv.dryRun,
        });
        say(renderLearnResult(result));
        if (argv.json !== undefined) {
          const file = await writeJson(resolve(argv.json), result);
          say("", `learn result written to ${file}`);
        }
        // A refused or failed write is not a successful learn: CI has to see it.
        process.exitCode =
          result.write.skipped !== undefined && !argv.dryRun
            ? EXIT_CODES.runError
            : EXIT_CODES.ok;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        complain(
          error instanceof ConfigError
            ? `yama learn: ${message}`
            : `yama learn failed: ${message}`,
          "Nothing was committed or pushed.",
        );
        process.exitCode =
          error instanceof ConfigError
            ? EXIT_CODES.configError
            : EXIT_CODES.runError;
      }
    },
  )
  .demandCommand(1, "Pick a command: review, learn, init or doctor")
  .strict()
  .fail((msg, err) => {
    if (err) {
      throw err;
    }
    process.stderr.write(`${msg}\nRun \`yama --help\` for usage.\n`);
    process.exit(EXIT_CODES.configError);
  })
  .help()
  .parseAsync();

finish();
