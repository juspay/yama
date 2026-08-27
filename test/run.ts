/**
 * Yama's e2e test driver and harness (TASKS:0.5). Run with `pnpm test` (tsx).
 *
 * Doctrine, adopted from NeuroLink's CLAUDE.md:
 *
 * - **Rule 15 — end-to-end only.** A suite must exercise a surface Yama actually
 *   ships: the BUILT CLI (`dist/cli/index.js`) or the BUILT library entry
 *   (`dist/index.js`). Importing out of `src/` to assert on an internal is a unit
 *   test and does not belong here.
 * - **One module graph per suite.** `dist/` is the artifact callers load; `src/` is
 *   a second copy of the same code. Mixing them breaks object identity silently.
 *   Suites take everything from `dist/`.
 * - **Keep payloads out of assertion messages.** In NeuroLink this mattered because
 *   its skip classifier reads message text, so a message quoting a payload could
 *   downgrade a real failure to a skip. Yama removes that hazard at the root: the
 *   ONLY skip signal here is `throw new Skip(reason)` — no message-prefix matching,
 *   no error-text sniffing. The habit still stands, because a message full of
 *   captured stdout is unreadable: describe the discrepancy, and let
 *   `assertExit` print the bounded process context separately.
 *
 * Sanity-check a new suite by breaking one assertion on purpose: it must report
 * `✗` and exit non-zero, never `⊘`.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Package root — the thing under test. */
export const REPO_ROOT = path.resolve(HERE, "..");
/** Built CLI entry. Suites drive this; `src/cli/index.ts` is never imported. */
export const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli", "index.js");
/** Built library entry. The only module graph a suite may import from. */
export const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
/** Fixture repos driven by the suites. */
export const FIXTURES = path.join(HERE, "fixtures");

/**
 * A module of the BUILT package other than the library entry — the engine seam and its
 * fallbacks ship as their own modules, and a suite must drive the artifact, not `src/`.
 */
export const distModule = (relative: string): string =>
  path.join(REPO_ROOT, "dist", relative);

/** Scratch directory for one test. Removed by `withTempDir`, whatever the test does. */
export async function withTempDir<T>(
  prefix: string,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), `yama-${prefix}-`));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The `.yama/yama.yaml` a stage suite gets unless it asks for a different one. */
export const WORKSPACE_YAMA_YAML = [
  "models:",
  "  main:",
  "    provider: google-ai",
  "    model: gemini-2.5-flash",
  "pool:",
  "  tier: low",
  "",
].join("\n");

/**
 * A git repository with a minimal, schema-valid `.yama/` — the input every stage suite
 * needs. One commit, then an uncommitted edit, so the local diff is never empty.
 */
export async function gitWorkspace(
  dir: string,
  options: { yamaYaml?: string } = {},
): Promise<void> {
  await mkdir(path.join(dir, ".yama", "rulebook"), { recursive: true });
  await writeFile(
    path.join(dir, ".yama", "yama.yaml"),
    options.yamaYaml ?? WORKSPACE_YAMA_YAML,
    "utf8",
  );
  await writeFile(
    path.join(dir, ".yama", "mcp.yaml"),
    "servers: {}\ncapabilities: {}\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, ".yama", "rulebook", "index.md"),
    "# Rules\n\n- Never log a token.\n",
    "utf8",
  );
  const git = (args: string[]): Promise<ProcessResult> =>
    runCommand("git", args, { cwd: dir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Yama Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "app.ts"), "export const a = 1;\n", "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "initial"]);
  await writeFile(path.join(dir, "app.ts"), "export const a = 2;\n", "utf8");
}

/** Whether `pnpm run build` has produced the surfaces suites drive. */
export const isBuilt = (): boolean =>
  existsSync(CLI_ENTRY) && existsSync(DIST_ENTRY);

/**
 * The one skip signal. Classification is `instanceof` only — deliberately not
 * message-based, so no assertion text can turn a failure into a skip.
 */
export class Skip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Skip";
  }
}

// ---------------------------------------------------------------------------
// Assertions — messages describe the discrepancy, never quote the payload
// ---------------------------------------------------------------------------

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(
      `${what}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

/** The needle is a test-authored literal, so naming it in the message is safe. */
export function assertIncludes(
  haystack: string,
  needle: string,
  where: string,
): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${where}: missing expected text "${needle}"`);
  }
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Spawn with argv (never a shell) and a hard bound.
 *
 * `proc.killed` only records that a signal was delivered, so the SIGKILL
 * escalation tracks the real exit instead — a child that ignores SIGTERM would
 * otherwise hang the run.
 */
export function runCommand(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions & { timeoutMs?: number } = {},
): Promise<ProcessResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });

    let stdout = "";
    let stderr = "";
    let hasExited = false;
    let settled = false;

    const settle = (result: ProcessResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!hasExited) {
            proc.kill("SIGKILL");
          }
        }, 1_000).unref();
      } catch {
        /* the child is already gone */
      }
      settle({
        stdout,
        stderr: `${stderr}\n[harness] timed out after ${timeoutMs}ms`,
        exitCode: -1,
      });
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("exit", () => {
      hasExited = true;
    });
    proc.on("close", (code) => {
      hasExited = true;
      settle({ stdout, stderr, exitCode: code ?? -1 });
    });
    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/** Run the BUILT CLI: `node dist/cli/index.js <args>`. */
export function runCLI(
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<ProcessResult> {
  return runCommand("node", [CLI_ENTRY, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs,
  });
}

const EXCERPT_BYTES = 400;

/**
 * Assert a CLI exit code. On mismatch the process output is printed as context
 * (bounded) and the thrown message stays payload-free.
 */
export function assertExit(
  result: ProcessResult,
  expected: number,
  what: string,
): void {
  if (result.exitCode !== expected) {
    console.log(
      `      context - stdout: ${result.stdout.slice(0, EXCERPT_BYTES)}`,
    );
    console.log(
      `      context - stderr: ${result.stderr.slice(0, EXCERPT_BYTES)}`,
    );
    throw new Error(
      `${what}: expected exit ${expected}, got ${result.exitCode}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bright: "\x1b[1m",
} as const;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: { suite: string; test: string; reason: string }[] = [];

/** Per-test bound. Every case here drives a local subprocess: a hang is a bug, so it FAILS. */
const PER_TEST_TIMEOUT_MS = 60_000;

export type TestFn = () => Promise<void> | void;

export function defineSuite(suiteName: string): {
  test: (name: string, fn: TestFn) => Promise<void>;
  section: (title: string) => void;
  skipAll: (reason: string) => void;
} {
  console.log(`\n${colors.cyan}${colors.bright}▸ ${suiteName}${colors.reset}`);

  const test = async (name: string, fn: TestFn): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Promise.race cannot cancel: a timed-out case keeps running. Cases here
      // hold nothing global, so the remaining ones stay trustworthy.
      await Promise.race([
        (async () => fn())(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `exceeded ${PER_TEST_TIMEOUT_MS}ms - treat as a hang`,
                ),
              ),
            PER_TEST_TIMEOUT_MS,
          );
        }),
      ]);
      passed++;
      console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    } catch (err) {
      if (err instanceof Skip) {
        skipped++;
        console.log(
          `  ${colors.yellow}⊘${colors.reset} ${name} ${colors.yellow}(${err.message})${colors.reset}`,
        );
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        failed++;
        failures.push({ suite: suiteName, test: name, reason });
        console.log(
          `  ${colors.red}✗${colors.reset} ${name}\n      ${colors.yellow}-> ${reason.split("\n")[0]}${colors.reset}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };

  const section = (title: string): void => {
    console.log(`  ${colors.bright}${title}${colors.reset}`);
  };

  const skipAll = (reason: string): void => {
    console.log(
      `  ${colors.yellow}⊘ whole suite skipped: ${reason}${colors.reset}`,
    );
  };

  return { test, section, skipAll };
}

// ---------------------------------------------------------------------------
// Registry — suites run in order, each one asserting at import time
// ---------------------------------------------------------------------------

/**
 * Suites are imported dynamically, from inside `main()`, and this file has NO
 * top-level await. Both halves matter, because a suite imports this module back:
 *
 * - static import of the suite would be a cycle whose suite half evaluates while
 *   `defineSuite` is still in its temporal dead zone;
 * - a top-level `await import(...)` makes THIS module async, so the suite's
 *   static `import { defineSuite } from "./run.js"` waits for this module to
 *   finish evaluating while this module waits for the suite. That deadlock is
 *   real — it reports as "Detected unsettled top-level await" and exit 13.
 *
 * Keeping evaluation synchronous lets the suite resolve its import immediately.
 */
const SUITES: readonly string[] = [
  "./suite-cli.js",
  "./suite-store.js",
  "./suite-tools.js",
  "./suite-engine.js",
  "./suite-native.js",
  "./suite-session.js",
  "./suite-gates.js",
  "./suite-work.js",
  "./suite-platform.js",
  "./suite-recurrence.js",
  "./suite-learn.js",
];

const summarize = (): void => {
  const total = passed + failed + skipped;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${colors.green}passed  ${passed}${colors.reset}`);
  if (failed > 0) {
    console.log(`  ${colors.red}failed  ${failed}${colors.reset}`);
  }
  if (skipped > 0) {
    console.log(`  ${colors.yellow}skipped ${skipped}${colors.reset}`);
  }
  console.log(`  ${colors.bright}total   ${total}${colors.reset}`);
  if (failures.length > 0) {
    console.log(`\n  ${colors.red}FAILURES${colors.reset}`);
    for (const f of failures) {
      console.log(`    ${colors.red}✗${colors.reset} ${f.suite} > ${f.test}`);
      console.log(`      ${f.reason.split("\n")[0]}`);
    }
  }
  if (passed === 0 && failed === 0) {
    console.log(
      `\n  ${colors.yellow}nothing executed — build first: pnpm run build${colors.reset}`,
    );
  }
  console.log(`  RESULT: ${failed > 0 ? "FAIL" : "PASS"}`);
  console.log(`${"=".repeat(60)}\n`);
};

const main = async (): Promise<void> => {
  for (const suite of SUITES) {
    await import(suite);
  }
  summarize();
  process.exitCode = failed > 0 ? 1 : 0;
};

void main().catch((err: unknown) => {
  // A suite that throws outside a `test()` never reported a result, so the run
  // is unknown, not green.
  console.error(`\n${colors.red}suite loading failed${colors.reset}`);
  console.error(err);
  process.exitCode = 1;
});
