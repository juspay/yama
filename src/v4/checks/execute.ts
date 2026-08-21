/**
 * Running the configured checks for real.
 *
 * The pure layer decides WHAT to run, in what scope, and how to read the output.
 * This is the only place a child process is spawned, which is why the two
 * non-negotiable security rules are enforced here rather than left to a caller
 * to remember:
 *
 *   1. `assertCheckConfigUntampered` runs before anything is spawned. A pull
 *      request that edits `checks.yaml` or a script it names gets no checks at
 *      all — it is either a mistake or an attempt, and both deserve a stop.
 *   2. Fork pull requests get no checks unless `allowForks` is explicitly on.
 *      Running repository commands against code from a fork is arbitrary code
 *      execution with the CI job's credentials.
 *
 * Both fail the checks stage loudly. Neither degrades to "ran nothing" quietly.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckRunResult,
  CommandRunner,
  ResolvedConfig,
  RunChecksOptions,
} from "../types/index.js";
import {
  assertCheckConfigUntampered,
  capFindings,
  executeCheck,
  prepareChecks,
  scopeFindings,
} from "./Runner.js";
import { changedPaths, lineWasChanged } from "../changes/ChangeSet.js";

/**
 * A command runner backed by the shell.
 *
 * A shell IS used here, unlike everywhere else in Yama: check commands are
 * pipelines the project authored (`pnpm lint --format json`), read from the base
 * branch, and rewriting them into argv arrays would break every real config.
 * The safety comes from provenance — rule 1 above — not from argument handling.
 */
export const shellRunner: CommandRunner = async (command, options) => {
  const child = execFile(process.env.SHELL || "/bin/sh", ["-c", command], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    // A check that waits on stdin would hang until its timeout.
    env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: NodeJS.ErrnoException) => {
      options.signal?.removeEventListener("abort", onAbort);
      timedOut = error.code === "ETIMEDOUT";
      resolve({
        stdout,
        stderr: stderr || error.message,
        exitCode: 1,
        timedOut,
      });
    });

    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut: timedOut || signal === "SIGTERM",
      });
    });
  });
};

/** Hash the files a check looks at, so an unchanged input reuses its result. */
async function hashFiles(
  projectRoot: string,
  paths: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await readFile(join(projectRoot, path));
        hashes.set(
          path,
          createHash("sha1").update(content).digest("hex").slice(0, 16),
        );
      } catch {
        // A deleted or unreadable file simply has no hash: the cache key then
        // reflects its absence, which is correct.
      }
    }),
  );
  return hashes;
}

/**
 * Run every configured check and return one result per check.
 *
 * Checks run concurrently, bounded by the run's pool, because they are
 * independent processes and the slowest one is what the stage waits for. Every
 * enabled check produces a result — passed, failed, skipped with a reason, or
 * timeout — because the stage predicate treats a check that produced nothing at
 * all as a gap, not as a pass.
 */
export async function runConfiguredChecks(
  options: RunChecksOptions,
): Promise<CheckRunResult[]> {
  const { config, changeSet, projectRoot } = options;

  if (!config.checks.enabled || config.checks.checks.length === 0) {
    return [];
  }

  const enabled = config.checks.checks.filter(
    (check) => check.enabled !== false,
  );

  if (options.isFork && !config.checks.allowForks) {
    return enabled.map((check) => ({
      checkId: check.id,
      status: "skipped" as const,
      durationMs: 0,
      findings: [],
      droppedFindings: 0,
      reason:
        "fork pull request; checks run project commands and are off unless " +
        "checks.allowForks is explicitly enabled",
    }));
  }

  // Throws CheckSecurityError. Deliberately not caught here: the caller records
  // the checks stage as failed with this message rather than reporting "no
  // checks ran", which would read as a pass.
  assertCheckConfigUntampered(
    enabled,
    changedPaths(changeSet, { includeExcluded: true }),
  );

  const hashes = await hashFiles(projectRoot, changedPaths(changeSet));
  const { prepared, skipped } = prepareChecks(config, changeSet, hashes);
  const isChangedLine = (path: string, line: number): boolean =>
    lineWasChanged(changeSet, path, line);

  const results = await options.pool(
    prepared.map((check) => async () => {
      const result = await executeCheck({
        check,
        runner: options.runner ?? shellRunner,
        cwd: projectRoot,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cache ? { cache: options.cache } : {}),
      });

      const scoped = {
        ...result,
        findings: scopeFindings(
          result.findings,
          check.config,
          changeSet,
          isChangedLine,
        ),
      };
      return capFindings(scoped, check.config.maxFindings);
    }),
  );

  return [...results, ...skipped];
}

/** Which checks used `parse: agent` and produced raw output needing extraction. */
export function needsExtraction(
  config: ResolvedConfig,
  results: CheckRunResult[],
): CheckRunResult[] {
  const agentParsed = new Set(
    config.checks.checks
      .filter((check) => check.parse === "agent")
      .map((check) => check.id),
  );
  return results.filter(
    (result) =>
      agentParsed.has(result.checkId) &&
      result.findings.length === 0 &&
      (result.output ?? "").trim().length > 0,
  );
}
