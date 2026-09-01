/**
 * Suite: the v6 reviewer — the artifact the package actually ships.
 *
 * v6's bin points at `reviewer/index.mjs`, which needs no build step: driving
 * the file in the repository IS driving what ships, the same end-to-end
 * doctrine the other suites apply to `dist/`. Everything here is offline and
 * deterministic — scaffolding, argument guards, and package wiring. The
 * model-driven review path is exercised live by `yama-review.yml` on every
 * pull request of this repository, which no offline suite can replace.
 *
 * The reviewer's runtime files are deliberately not imported or modified:
 * suites observe the shipped surface through a subprocess, nothing else.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  REPO_ROOT,
  assert,
  assertEqual,
  assertExit,
  assertIncludes,
  defineSuite,
  runCommand,
  withTempDir,
  type ProcessResult,
} from "./run.js";

const { test, section } = defineSuite("reviewer");

const REVIEWER_ENTRY = path.join(REPO_ROOT, "reviewer", "index.mjs");

/** Files `yama init` scaffolds; the CLI contract for onboarding. */
const SCAFFOLD_FILES = [
  "config.json",
  "MCP.json",
  "prompts.json",
  "skills/guidelines/SKILL.md",
  "memory/hippocampus.sqlite",
  ".env.example",
] as const;

/** Drive the shipped reviewer entry: `node reviewer/index.mjs <args>`. */
const runReviewer = (
  args: readonly string[],
  cwd: string,
  timeoutMs = 45_000,
): Promise<ProcessResult> =>
  runCommand("node", [REVIEWER_ENTRY, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    timeoutMs,
  });

section("init scaffold");

await test("init creates the whole structure in an empty directory", async () => {
  await withTempDir("init", async (dir) => {
    const r = await runReviewer(["init"], dir);
    assertExit(r, 0, "yama init");
    for (const file of SCAFFOLD_FILES) {
      assert(
        existsSync(path.join(dir, file)),
        `missing scaffold file: ${file}`,
      );
    }
    // The scaffolded JSON must parse, and provider/model must be placeholders
    // the operator is told to fill — not silently runnable defaults.
    const config = JSON.parse(
      await readFile(path.join(dir, "config.json"), "utf8"),
    ) as {
      provider?: string;
      learnPrompt?: string;
      learn?: { commit?: boolean };
    };
    assert(
      typeof config.provider === "string" && config.provider.startsWith("<"),
      "config.json provider is not a fill-me placeholder",
    );
    assert(
      typeof config.learnPrompt === "string" &&
        config.learnPrompt.includes("${pr}"),
      "config.json learnPrompt placeholder is missing",
    );
    assertEqual(
      config.learn?.commit,
      false,
      "scaffolded learn.commit (no surprise commits by default)",
    );
    const prompts = JSON.parse(
      await readFile(path.join(dir, "prompts.json"), "utf8"),
    ) as { prompts?: unknown[] };
    assert(
      Array.isArray(prompts.prompts) && prompts.prompts.length > 0,
      "prompts.json has no prompts array",
    );
  });
});

await test("init never overwrites — second run skips every existing file", async () => {
  await withTempDir("init-idem", async (dir) => {
    assertExit(await runReviewer(["init"], dir), 0, "first init");
    const before = await readFile(path.join(dir, "config.json"), "utf8");
    const second = await runReviewer(["init"], dir);
    assertExit(second, 0, "second init");
    assertIncludes(second.stdout, "exists, skipped", "second init output");
    const after = await readFile(path.join(dir, "config.json"), "utf8");
    assertEqual(after, before, "config.json content across re-init");
  });
});

section("run guards");

await test("run without a config points at init and exits non-zero", async () => {
  await withTempDir("run-bare", async (dir) => {
    const r = await runReviewer(["run", "pr=1"], dir);
    assertExit(r, 1, "yama run in an empty directory");
    assertIncludes(
      `${r.stdout}\n${r.stderr}`,
      "yama init",
      "missing-config guidance",
    );
  });
});

section("learn guards");

await test("learn without pr= prints usage and exits non-zero", async () => {
  await withTempDir("learn-usage", async (dir) => {
    const r = await runReviewer(["learn"], dir);
    assertExit(r, 1, "yama learn without pr=");
    assertIncludes(
      `${r.stdout}\n${r.stderr}`,
      "pr=<number>",
      "learn usage line",
    );
  });
});

await test("learn with a non-numeric pr is rejected", async () => {
  await withTempDir("learn-badpr", async (dir) => {
    const r = await runReviewer(["learn", "pr=abc"], dir);
    assertExit(r, 1, "yama learn pr=abc");
    assertIncludes(
      `${r.stdout}\n${r.stderr}`,
      "pr=<number>",
      "learn usage line",
    );
  });
});

await test("learn without a config points at init and exits non-zero", async () => {
  await withTempDir("learn-bare", async (dir) => {
    const r = await runReviewer(["learn", "pr=1"], dir);
    assertExit(r, 1, "yama learn in an empty directory");
    assertIncludes(
      `${r.stdout}\n${r.stderr}`,
      "yama init",
      "missing-config guidance",
    );
  });
});

await test("learn without a learnPrompt names the missing key", async () => {
  await withTempDir("learn-noprompt", async (dir) => {
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ provider: "litellm", model: "open-fast" }),
      "utf8",
    );
    const r = await runReviewer(["learn", "pr=1"], dir);
    assertExit(r, 1, "yama learn without learnPrompt");
    assertIncludes(
      `${r.stdout}\n${r.stderr}`,
      "learnPrompt",
      "missing-learnPrompt guidance",
    );
  });
});

section("package wiring");

await test("the bin points at the reviewer entry that exists and is ESM-executable", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { bin?: Record<string, string>; files?: string[] };
  assertEqual(
    pkg.bin?.["yama"],
    "./reviewer/index.mjs",
    "package.json bin.yama",
  );
  assert(existsSync(REVIEWER_ENTRY), "reviewer/index.mjs is missing");
  const head = (await readFile(REVIEWER_ENTRY, "utf8")).slice(0, 30);
  assertIncludes(head, "#!/usr/bin/env node", "reviewer entry shebang");
});

await test("the files allowlist ships the reviewer and nothing stale", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { files?: string[] };
  const files = pkg.files ?? [];
  assert(
    files.includes("reviewer/index.mjs"),
    "files misses reviewer/index.mjs",
  );
  assert(files.includes("reviewer/init.mjs"), "files misses reviewer/init.mjs");
  assert(
    files.includes("reviewer/learn.mjs"),
    "files misses reviewer/learn.mjs",
  );
  assert(files.includes("action.yml"), "files misses action.yml");
  assert(!files.includes("dist"), "files still ships the v5 dist");
  assert(!files.includes("templates"), "files still ships the v5 templates");
});
