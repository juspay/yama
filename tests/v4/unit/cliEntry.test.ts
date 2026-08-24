/**
 * Entry-point detection — the guard that decides whether cli.ts runs main.
 *
 * The regression under test: npm installs the CLI as a SYMLINK
 * (node_modules/.bin/yama → dist/v4/cli/cli.js), so process.argv[1] ends with
 * "yama", not "cli.js". v4.0.0's suffix check made every npx invocation — how
 * the GitHub Action runs the CLI — load the module, match nothing, and exit 0
 * silently. The guard must recognise the shim by file identity, not spelling.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainEntry } from "../../../src/v4/cli/entry.js";

describe("isMainEntry", () => {
  let root: string;
  let cliPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yama-entry-"));
    cliPath = join(root, "cli.js");
    writeFileSync(cliPath, "// stand-in for dist/v4/cli/cli.js\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("recognises direct invocation (node dist/v4/cli/cli.js)", () => {
    expect(isMainEntry(cliPath, cliPath)).toBe(true);
  });

  it("recognises the npm bin shim — a symlink named yama", () => {
    const shimPath = join(root, "yama");
    symlinkSync(cliPath, shimPath);
    expect(isMainEntry(shimPath, cliPath)).toBe(true);
  });

  it("stays false when another module is the entry (jest, an importer)", () => {
    const otherPath = join(root, "other.js");
    writeFileSync(otherPath, "\n");
    expect(isMainEntry(otherPath, cliPath)).toBe(false);
  });

  it("stays false without an entry path (node -e, REPL)", () => {
    expect(isMainEntry(undefined, cliPath)).toBe(false);
  });

  it("falls back to the spelling check when a path cannot be resolved", () => {
    const gone = join(root, "missing", "cli.js");
    expect(isMainEntry(gone, cliPath)).toBe(true);
    expect(isMainEntry(join(root, "missing", "yama"), cliPath)).toBe(false);
  });
});
