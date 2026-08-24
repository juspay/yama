#!/usr/bin/env node

/**
 * The v4 CLI.
 *
 * Thin on purpose: every command resolves config, builds a plan or a report from
 * the pure layers, and renders it. Nothing here decides anything a test cannot
 * reach without a terminal.
 */

import { Command } from "commander";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isMainEntry } from "./entry.js";
import { loadConfig, ConfigError } from "../config/Loader.js";
import { findV3ConfigPath } from "../config/v3Compat.js";
import { buildMigrationPlan, renderMigrationPlan } from "../config/migrate.js";
import { formatDoctorReport, runDoctor } from "../core/Doctor.js";
import { resolvePrompts } from "../prompts/PromptStore.js";
import { probeLive } from "../core/DoctorProbe.js";
import {
  buildInitPlan,
  buildLearnWorkflow,
  detectProject,
  renderInitPlan,
} from "./init.js";
import {
  detectMergeStrategy,
  validateLearnTrigger,
} from "../learn/MergeResolver.js";
import { DiffError, readLocalChangeSet } from "../core/LocalDiff.js";
import { runReview } from "../core/ReviewRunner.js";
import { isForkPullRequest } from "../config/defaults.js";
import { renderRunReport, writeRunReport } from "../core/RunReport.js";
import { createRunContext } from "../core/RunContext.js";
import { resolveModelChains } from "../core/NeurolinkFactory.js";
import { describeChain } from "../config/ModelChain.js";
import { loadLocalEnv } from "./env.js";
import { DEFAULT_PROVIDER, identityProvider } from "../config/defaults.js";
import { describeWindow, resolveWindow } from "../learn/Window.js";
import { loadWatermark } from "../learn/WatermarkStore.js";
import { runLearn } from "../learn/LearnRunner.js";
import { BOOTSTRAP_WINDOW } from "../learn/Bootstrap.js";
import { renderBootstrapPlan, runBootstrap } from "../learn/BootstrapRunner.js";
import type {
  CommitInfo,
  GitCommand,
  GitRunner,
  RunMode,
  WindowCommit,
} from "../types/index.js";

const run = promisify(execFile);

/**
 * Git for the learn writer, which passes whole command strings.
 *
 * A shell IS used: the writer composes commands with credential helpers that
 * only make sense as shell strings. Its inputs are Yama's own — never a model's
 * and never a pull request's — and `assertScopedPaths` bounds what can be
 * staged.
 */
const gitRunner: GitRunner = async (command, options) => {
  try {
    const { stdout, stderr } = await run(
      process.env.SHELL || "/bin/sh",
      ["-c", command],
      { cwd: options.cwd, env: options.env, maxBuffer: 16 * 1024 * 1024 },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
      exitCode: failure.code ?? 1,
    };
  }
};

/** Run git, surfacing a non-zero exit rather than throwing. */
const git: GitCommand = async (args, options) => {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd: options.cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
      exitCode: failure.code ?? 1,
    };
  }
};

/** Read the git remote, or nothing. A repo without one still onboards. */
async function gitRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], {
      cwd,
    });
    return stdout.trim() || undefined;
  } catch {
    // No remote configured, or not a git repository. Onboarding still works —
    // the provider is simply not pre-detected.
    return undefined;
  }
}

/**
 * Commits since a watermark, oldest first.
 *
 * `%x00` separators rather than a printable delimiter: commit subjects contain
 * every printable character somebody could pick as one.
 */
async function commitsSince(
  cwd: string,
  since: string | undefined,
  head = "HEAD",
): Promise<WindowCommit[]> {
  // Without a watermark, read from the beginning rather than a fixed offset:
  // `HEAD~50` does not resolve in a repository younger than fifty commits, and
  // git fails the whole command rather than returning what it can. The window
  // narrows a first run itself, so reading more here costs nothing.
  const args = [
    "log",
    "--reverse",
    "--pretty=format:%H%x00%s%x00%P%x00%cI%x00%b%x1e",
  ];
  if (since) {
    args.push(`${since}..${head}`);
  } else {
    args.push("-n", "50", head);
  }
  const result = await git(args, { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, parents, committedAt, body] = entry.split("\0");
      return {
        sha,
        subject: subject ?? "",
        body: body ?? "",
        parentCount: (parents ?? "").trim().split(/\s+/).filter(Boolean).length,
        committedAt: committedAt ?? "",
      };
    });
}

/** Sample recent default-branch history for merge-strategy detection. */
async function recentCommits(cwd: string, count = 40): Promise<CommitInfo[]> {
  try {
    const { stdout } = await run(
      "git",
      ["log", `-${count}`, "--pretty=format:%H%x00%s%x00%P"],
      { cwd },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, parents] = line.split("\0");
        return {
          sha,
          subject: subject ?? "",
          parentCount: (parents ?? "").trim().split(/\s+/).filter(Boolean)
            .length,
        };
      });
  } catch {
    // No history in range — a fresh repository, or a range git cannot resolve.
    // The window narrows itself; an empty commit list is a valid answer.
    return [];
  }
}

function writeFiles(
  projectRoot: string,
  files: Array<{ path: string; content: string }>,
): string[] {
  const written: string[] = [];
  for (const file of files) {
    const absolute = join(projectRoot, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf-8");
    written.push(file.path);
  }
  return written;
}

export function buildProgram(): Command {
  const program = new Command();

  // Local convenience only — never in CI, where the checkout is the pull
  // request. See ./env.ts for why that distinction matters.
  program.hook("preAction", () => {
    loadLocalEnv(resolve(program.opts().cwd));
  });

  program
    .name("yama")
    .description("Yama — pull request review")
    .option("-C, --cwd <path>", "repository root", process.cwd())
    // A trusted config, passed from outside the checkout. The reviewed pull
    // request can edit `.yama/` in its own head, so CI that reviews untrusted
    // code points this at a directory the pull request cannot touch.
    .option(
      "--config <path>",
      "config directory, or a v3 config file (default: .yama)",
    );

  /** Options every config load shares. */
  const loadOptions = (): { projectRoot: string; configPath?: string } => {
    const opts = program.opts();
    return {
      projectRoot: resolve(opts.cwd),
      ...(opts.config ? { configPath: String(opts.config) } : {}),
    };
  };

  program
    .command("doctor")
    .description("Prove the setup works before anything depends on it")
    .option("--live", "check what a live run needs, not just a dry run", false)
    .option("--learn", "also check the write path learning needs", false)
    .option(
      "--pr <number>",
      "read this pull request, to prove the credential end to end",
    )
    .action(async (options) => {
      try {
        const config = await loadConfig(loadOptions());
        const mode: RunMode = options.live ? "live" : "dry-run";

        // --live means connect. A doctor that passes without connecting turns
        // "we do not know" into "we checked", which is the failure it exists to
        // prevent.
        const probe = options.live
          ? await probeLive({
              config,
              chains: resolveModelChains(config),
              context: createRunContext({
                config,
                identity: {
                  provider: identityProvider(process.env),
                  owner: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[0],
                  repo: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[1],
                  ...(options.pr ? { pullRequestId: Number(options.pr) } : {}),
                },
                mode: "dry-run",
              }),
              mode,
              ...(options.pr ? { pullRequestId: Number(options.pr) } : {}),
            })
          : undefined;

        // Resolved here rather than inside runDoctor so the doctor stays pure
        // and testable: it reports what it is given.
        const prompts = await resolvePrompts({
          config: config.prompts,
          env: process.env,
        });

        const report = runDoctor({
          config,
          mode,
          prompts,
          checkLearn: options.learn === true,
          ...(probe?.registrations
            ? { registrations: probe.registrations }
            : {}),
          ...(probe?.capabilities ? { capabilities: probe.capabilities } : {}),
        });

        if (probe) {
          report.checks.push(...probe.checks);
          report.status = report.checks.some((check) => check.status === "fail")
            ? "fail"
            : report.checks.some((check) => check.status === "warn")
              ? "warn"
              : "ok";
        }

        process.stdout.write(`${formatDoctorReport(report)}\n`);
        process.exitCode = report.status === "fail" ? 1 : 0;
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("init")
    .description("Set Yama up in this repository")
    .option(
      "--write",
      "write the files instead of only showing the plan",
      false,
    )
    .option("--provider <name>", "VCS provider")
    .option(
      "--token-env <name>",
      "env var holding the VCS token",
      "YAMA_VCS_TOKEN",
    )
    .option("--ai-provider <list>", "comma-separated provider fallback chain")
    .option("--ai-model <list>", "comma-separated model fallback chain", "")
    .option("--checks <list>", "comma-separated check ids to enable", "")
    .option("--enable-learning", "configure learning on the merge event", false)
    .action(async (options) => {
      const projectRoot = resolve(program.opts().cwd);
      const detected = detectProject(projectRoot, await gitRemote(projectRoot));

      if (detected.legacyConfigPath) {
        process.stdout.write(
          `Found an existing configuration at ${detected.legacyConfigPath}.\n` +
            `Run \`yama migrate\` — it splits it into the v4 files and keeps the old one working.\n`,
        );
        process.exitCode = 1;
        return;
      }

      const strategy = options.enableLearning
        ? detectMergeStrategy(await recentCommits(projectRoot))
        : undefined;

      const plan = buildInitPlan(detected, {
        provider: options.provider ?? detected.provider ?? DEFAULT_PROVIDER,
        tokenEnv: options.tokenEnv,
        aiProvider: String(options.aiProvider ?? "")
          .split(",")
          .filter(Boolean),
        aiModel: String(options.aiModel).split(",").filter(Boolean),
        dryRunFirst: true,
        enabledChecks: String(options.checks).split(",").filter(Boolean),
        importCodeowners: detected.hasCodeowners,
        ...(strategy && strategy !== "unknown"
          ? { mergeStrategy: strategy }
          : {}),
      });

      process.stdout.write(`${renderInitPlan(detected, plan)}\n`);

      if (!options.write) {
        process.stdout.write(
          "\nNothing written. Re-run with --write to apply.\n",
        );
        return;
      }

      const files = [...plan.files];
      if (strategy && strategy !== "unknown") {
        files.push({
          path: ".github/workflows/yama-learn.yml",
          content: buildLearnWorkflow("yama-bot"),
        });
      }
      const written = writeFiles(projectRoot, files);
      process.stdout.write(
        `\nWrote:\n${written.map((path) => `  ${path}`).join("\n")}\n`,
      );
    });

  program
    .command("migrate")
    .description("Split a v3 configuration into the v4 file tree")
    .option(
      "--write",
      "write the files instead of only showing the plan",
      false,
    )
    .action(async (options) => {
      const projectRoot = resolve(program.opts().cwd);
      const legacyPath = findV3ConfigPath(projectRoot);
      if (!legacyPath) {
        process.stdout.write(
          "No v3 configuration found. If this repository is new, run `yama init`.\n",
        );
        process.exitCode = 1;
        return;
      }

      const { readFileSync } = await import("node:fs");
      const { parse } = await import("yaml");
      const plan = buildMigrationPlan(parse(readFileSync(legacyPath, "utf-8")));

      process.stdout.write(`${renderMigrationPlan(plan)}\n`);
      if (options.write) {
        const written = writeFiles(projectRoot, plan.files);
        process.stdout.write(
          `\nWrote:\n${written.map((path) => `  ${path}`).join("\n")}\n` +
            `\n${legacyPath} still works. Delete it once you are satisfied.\n`,
        );
      }
    });

  program
    .command("learn")
    .description("Learn from a merged pull request and commit what it taught")
    .requiredOption("--pr <number>", "the merged pull request")
    .option("--dry-run", "show what would be learned without committing", false)
    .action(async (options) => {
      const projectRoot = resolve(program.opts().cwd);
      try {
        const config = await loadConfig(loadOptions());

        if (config.learn.trigger === "disabled") {
          process.stdout.write(
            "Learning is disabled. Set learn.trigger to 'merge-event' in .yama/yama.yaml " +
              "and configure learn.git to enable it.\n",
          );
          return;
        }

        const strategy =
          config.learn.mergeStrategy ??
          detectMergeStrategy(await recentCommits(projectRoot));
        const validation = validateLearnTrigger(config.learn.trigger, strategy);
        if (!validation.ok) {
          process.stderr.write(`${validation.message}\n`);
          process.exitCode = 1;
          return;
        }

        // The window, not the trigger, decides what this run learns from.
        // Runs get cancelled and CI has outages; a run that only ever handles
        // its own trigger loses every merge that happened while it was down.
        const branch = config.learn.git?.branch ?? "main";
        const { watermark, existed, warning } = await loadWatermark(
          projectRoot,
          branch,
        );
        if (warning) {
          process.stdout.write(`[warn] ${warning}\n`);
        }

        const window = resolveWindow({
          strategy,
          watermark,
          commits: await commitsSince(projectRoot, watermark.lastLearnedSha),
          // A rebase repository needs the provider's listing; supplying it is
          // the runtime's job, so the window falls back to the trigger here.
          triggerPullRequestId: Number(options.pr),
        });

        process.stdout.write(
          [
            `Branch: ${branch}`,
            `Merge strategy: ${strategy}`,
            `Watermark: ${existed ? (watermark.lastLearnedSha ?? "(time only)") : "none — first run"}`,
            "",
            describeWindow(window),
            "",
          ].join("\n"),
        );

        if (window.entries.length === 0) {
          return;
        }

        const context = createRunContext({
          config,
          identity: {
            provider: identityProvider(process.env),
            owner: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[0],
            repo: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[1],
            pullRequestId: Number(options.pr),
          },
          mode: options.dryRun ? "dry-run" : "live",
        });

        const outcome = await runLearn({
          config,
          context,
          chains: resolveModelChains(config),
          window,
          watermark,
          gitRunner,
          env: process.env,
          logger: {
            info: (message) => process.stdout.write(`  ${message}\n`),
            warn: (message) => process.stderr.write(`  ! ${message}\n`),
          },
        });

        process.stdout.write(
          [
            outcome.summary ?? "Nothing new was learned from this window.",
            "",
            outcome.committed
              ? `Committed${outcome.pushed ? " and pushed" : " but NOT pushed"}.`
              : "Nothing committed.",
            ...outcome.warnings.map((warning) => `[warn] ${warning}`),
            "",
          ].join("\n"),
        );
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("review")
    .description("Review a pull request")
    .option("--pr <number>", "pull request number")
    .option("--branch <name>", "branch; Yama resolves its pull request")
    .option("--base <ref>", "base ref for the diff", "origin/main")
    .option("--head <ref>", "head ref for the diff", "HEAD")
    .option("--dry-run", "analyse and report without posting", false)
    .action(async (options) => {
      const projectRoot = resolve(program.opts().cwd);
      try {
        const config = await loadConfig(loadOptions());
        for (const notice of config.notices) {
          process.stdout.write(`[${notice.level}] ${notice.message}\n`);
        }

        if (!options.pr && !options.branch) {
          process.stderr.write(
            "Pass --pr <number> or --branch <name>. With a branch, Yama resolves the " +
              "pull request and reports an ambiguity rather than choosing.\n",
          );
          process.exitCode = 1;
          return;
        }

        // Everything that can be established without a model is established
        // first, so a misconfiguration fails here rather than mid-review.
        const changeSet = await readLocalChangeSet({
          git,
          cwd: projectRoot,
          base: options.base,
          head: options.head,
          excludePatterns: config.review.excludePatterns,
          maxFiles: config.review.maxFiles,
          deletions: config.review.deletions,
        });

        const context = createRunContext({
          config,
          identity: {
            provider: identityProvider(process.env),
            owner: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[0],
            repo: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[1],
            ...(options.pr ? { pullRequestId: Number(options.pr) } : {}),
            ...(options.branch ? { branch: String(options.branch) } : {}),
          },
          mode: options.dryRun ? "dry-run" : "live",
        });

        const chains = resolveModelChains(config);

        process.stdout.write(
          [
            `Run ${context.runId} — ${context.mode}`,
            `Session: ${context.sessionId}`,
            `Model: ${describeChain(chains.review)}`,
            `Concurrency: ${context.concurrency} (pool ${context.pool.size}, ` +
              `${context.delegationsPerTurn}/turn)`,
            "",
            `${changeSet.files.length} file(s) to review, ` +
              `+${changeSet.totalAdditions}/-${changeSet.totalDeletions} lines` +
              (changeSet.excluded.length > 0
                ? `, ${changeSet.excluded.length} excluded`
                : ""),
            changeSet.truncated ? "File limit reached — scope is partial." : "",
            "",
          ]
            .filter(Boolean)
            .join("\n") + "\n",
        );

        for (const file of changeSet.files) {
          process.stdout.write(
            `  ${file.kind.padEnd(9)} ${file.path} (+${file.additions}/-${file.deletions})\n`,
          );
        }

        const { result, runtime, warnings, posted } = await runReview({
          config,
          context,
          chains,
          git,
          base: options.base,
          head: options.head,
          ...(isForkPullRequest(process.env) ? { isFork: true } : {}),
          logger: {
            info: (message) => process.stdout.write(`  ${message}\n`),
            warn: (message) => process.stderr.write(`  ! ${message}\n`),
          },
        });

        try {
          process.stdout.write(
            `\n${renderRunReport(result, warnings, posted)}\n`,
          );
          await writeRunReport(config.projectRoot, context.runId, result);
        } finally {
          await runtime.shutdown();
        }

        // A blocked review is a successful run that found problems, not a failed
        // one: failing the job here would make "Yama works" indistinguishable
        // from "Yama found a bug", and teams disable whichever is noisier.
        // Only a run that could not do its job exits non-zero.
        process.exitCode = result.stages.outcomes.some(
          (outcome) => outcome.status === "failed",
        )
          ? 1
          : 0;
      } catch (error) {
        const message =
          error instanceof DiffError || error instanceof ConfigError
            ? error.message
            : `Unexpected error: ${(error as Error).message}`;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("bootstrap")
    .description(
      "Mine this repository's merged pull requests once, and propose a knowledge base",
    )
    .option(
      "--write",
      "write the files instead of only showing the plan",
      false,
    )
    .option(
      "--window <count>",
      "how many merged pull requests to read",
      String(BOOTSTRAP_WINDOW),
    )
    .action(async (options) => {
      const projectRoot = resolve(program.opts().cwd);
      try {
        const config = await loadConfig(loadOptions());
        for (const notice of config.notices) {
          process.stdout.write(`[${notice.level}] ${notice.message}\n`);
        }

        const context = createRunContext({
          config,
          identity: {
            provider: identityProvider(process.env),
            owner: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[0],
            repo: (process.env.GITHUB_REPOSITORY ?? "/").split("/")[1],
          },
          // Bootstrap only ever READS the provider. It writes to disk, and only
          // when --write is passed.
          mode: "dry-run",
        });

        const outcome = await runBootstrap({
          config,
          context,
          chains: resolveModelChains(config),
          window: Number(options.window) || BOOTSTRAP_WINDOW,
          env: process.env,
          logger: {
            info: (message) => process.stdout.write(`  ${message}\n`),
            warn: (message) => process.stderr.write(`  ! ${message}\n`),
          },
        });

        for (const warning of outcome.warnings) {
          process.stderr.write(`[warn] ${warning}\n`);
        }

        if (!outcome.plan) {
          process.exitCode = 1;
          return;
        }

        process.stdout.write(`${renderBootstrapPlan(outcome.plan)}\n`);

        if (!options.write) {
          process.stdout.write(
            "\nNothing written. Re-run with --write to apply.\n",
          );
          return;
        }

        const written = writeFiles(projectRoot, outcome.plan.files);
        process.stdout.write(
          `\nWrote:\n${written.map((path) => `  ${path}`).join("\n")}\n` +
            `\nOpen these as a pull request and read them before merging — bootstrap ` +
            `never commits directly, because every rule here will shape future reviews.\n` +
            `\n--- suggested pull request body ---\n${outcome.plan.pullRequestBody}\n`,
        );
      } catch (error) {
        const message =
          error instanceof ConfigError
            ? error.message
            : `Unexpected error: ${(error as Error).message}`;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("config")
    .description("Show the resolved configuration and every notice")
    .action(async () => {
      try {
        const config = await loadConfig(loadOptions());
        for (const notice of config.notices) {
          process.stdout.write(`[${notice.level}] ${notice.message}\n`);
        }
        process.stdout.write(
          `${JSON.stringify(stripInternals(config), null, 2)}\n`,
        );
      } catch (error) {
        const message =
          error instanceof ConfigError
            ? error.message
            : `Unexpected error: ${(error as Error).message}`;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    });

  return program;
}

/** Drop fields that are noise in a config dump. */
function stripInternals(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { notices: _notices, ...rest } = config;
  return rest;
}

/* c8 ignore start — entry point */
if (isMainEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  buildProgram()
    .parseAsync(process.argv)
    .then(async () => {
      // Exit explicitly. Provider SDKs keep telemetry timers and connection
      // pools alive, and a CLI that has printed its result but will not exit is,
      // to CI, a job that hangs until its timeout — indistinguishable from a
      // review that never finished.
      //
      // stdout is flushed first so nothing is lost on the way out.
      await new Promise<void>((resolve) => {
        if (process.stdout.write("")) {
          resolve();
        } else {
          process.stdout.once("drain", () => resolve());
        }
      });
      process.exit(process.exitCode ?? 0);
    })
    .catch((error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
/* c8 ignore stop */
