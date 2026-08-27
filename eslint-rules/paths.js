/**
 * Shared path helpers for Yama's custom lint rules.
 *
 * Yama's canonical types folder is `src/types/` (NeuroLink's is
 * `src/lib/types/`) — this module is the single place that knows that.
 *
 * Difference from NeuroLink's rules, deliberately: they match a `/src/lib/types/`
 * substring against the ABSOLUTE path, which misfires when the checkout itself
 * sits under a directory called `types` (every file then looks like it lives in
 * a stray types folder). These helpers work on the path relative to ESLint's
 * cwd instead, so only the repo's own layout is ever inspected.
 */

import path from "node:path";
import process from "node:process";

/** Canonical types folder, relative to the repo root. */
export const TYPES_DIR = "src/types";

/** The one barrel that re-exports every type file. */
export const TYPES_BARREL = `${TYPES_DIR}/index.ts`;

/** Repo-relative, forward-slashed path of the file being linted. */
export function relPath(context) {
  const filename = context.filename ?? "";
  if (!path.isAbsolute(filename)) {
    // Virtual filenames such as "<input>" (stdin) — nothing to reason about.
    return filename.split(path.sep).join("/");
  }
  const cwd = context.cwd ?? process.cwd();
  return path.relative(cwd, filename).split(path.sep).join("/");
}

/** True when the path escapes the linted project (`../…`) or is virtual. */
export function isOutsideProject(rel) {
  return rel === "" || rel.startsWith("../") || rel.startsWith("<");
}

/** True for files inside the canonical types folder (barrel included). */
export function isInsideTypesDir(rel) {
  return rel === TYPES_DIR || rel.startsWith(`${TYPES_DIR}/`);
}

/** True only for the types barrel itself. */
export function isTypesBarrel(rel) {
  return rel === TYPES_BARREL;
}
