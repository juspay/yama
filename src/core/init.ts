/**
 * `yama init` (TASKS:Y6.2, Y6.3) — scaffold a correct `.yama/` and the CI recipes that
 * carry the run store between runs.
 *
 * One rule: **nothing that already exists is overwritten** unless the operator asks for
 * it. A repository that has been configured by hand and then re-inits must come out of it
 * with its own configuration intact, and be told plainly which files were left alone.
 */
import { join } from "node:path";
import { CONFIG_DIR, CONFIG_FILES } from "../config/index.js";
import { STORE_ROOT } from "../store/index.js";
import type { InitPlatform, InitResult } from "../types/index.js";
import { pathExists, readTextFile, writeTextFile } from "../util/fs.js";
import { templateManifest, templatesDir } from "./templates.js";

/** The run store is a CI artifact and is never committed. */
const GITIGNORE_ENTRY = `${STORE_ROOT}/`;

const GITIGNORE_NOTE =
  "# Yama's run store: stage outputs, worker reports, findings ledger. A CI artifact.";

/**
 * Adds the run-store ignore to `.gitignore` if it is not already covered. Returns the file
 * when it was changed — committing artifacts is the one mistake this scaffold can prevent.
 */
export const ensureGitignore = async (
  root: string,
): Promise<string | undefined> => {
  const file = join(root, ".gitignore");
  const existing = (await readTextFile(file)) ?? "";
  if (
    existing
      .split("\n")
      .some((line) => line.trim().replace(/\/$/, "") === STORE_ROOT)
  ) {
    return undefined;
  }
  const prefix =
    existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  await writeTextFile(
    file,
    `${prefix}${existing === "" ? "" : "\n"}${GITIGNORE_NOTE}\n${GITIGNORE_ENTRY}\n`,
  );
  return file;
};

/**
 * Writes the `.yama/` scaffold and the CI examples. `platform` chooses which capability
 * map is written — the ids are the same everywhere, only the tool names differ.
 */
export const scaffold = async (options: {
  root: string;
  platform: InitPlatform;
  /** Overwrite files that already exist. Off by default, deliberately. */
  force?: boolean;
}): Promise<InitResult> => {
  const from = templatesDir();
  const written: string[] = [];
  const skipped: string[] = [];

  for (const entry of templateManifest(options.platform)) {
    const target = join(options.root, entry.to);
    if (options.force !== true && (await pathExists(target, "file"))) {
      skipped.push(target);
      continue;
    }
    const content = await readTextFile(join(from, entry.from));
    if (content === undefined) {
      throw new Error(
        `template "${entry.from}" is missing from ${from} — this build of yama is incomplete`,
      );
    }
    written.push(await writeTextFile(target, content));
  }

  const ignored = await ensureGitignore(options.root);
  if (ignored !== undefined) {
    written.push(ignored);
  }

  return {
    root: options.root,
    platform: options.platform,
    written,
    skipped,
  };
};

/** What `yama init` prints: what it wrote, what it kept, and what to do next. */
export const renderInitResult = (result: InitResult): string =>
  [
    `yama init — ${result.root}`,
    "",
    result.written.length > 0 ? "written" : "nothing written",
    ...result.written.map((file) => `  ${file}`),
    ...(result.skipped.length > 0
      ? [
          "",
          "left alone (already there — re-run with --force to replace)",
          ...result.skipped.map((file) => `  ${file}`),
        ]
      : []),
    "",
    "next",
    `  1. Edit ${CONFIG_DIR}/${CONFIG_FILES.yama} — the model chains decide who does the reviewing.`,
    `  2. Edit ${CONFIG_DIR}/${CONFIG_FILES.mcp} — map each capability to the tool your platform's MCP server exposes, and export the environment variables it references.`,
    `  3. Write ${CONFIG_DIR}/${CONFIG_FILES.rulebook}/index.md — what this repository actually wants enforced.`,
    "  4. Run `yama doctor` — it connects every server and proves each capability against the tools that server really exposes.",
    "  5. Run `yama review --dry-run` on a local diff before wiring the CI recipe in.",
  ].join("\n");
