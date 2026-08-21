/**
 * Unified-diff parsing and change-set construction.
 *
 * The diff comes from the local checkout — the repo is already there, which is
 * how `.yama/` was found. Reading it locally instead of through the VCS API is
 * why a v4 run does not need hundreds of tool calls to see the code it is
 * reviewing.
 *
 * Parsing is language-agnostic by construction: a unified diff has the same
 * shape whether it describes Rust or COBOL.
 */

import type {
  BuildChangeSetOptions,
  ChangeSet,
  FileChange,
  Hunk,
} from "../types/index.js";
import {
  looksGenerated,
  matchesAnyPath,
  normalizePath,
} from "../policy/paths.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff.
 *
 * Tolerant on purpose: git emits several header spellings across rename,
 * copy, mode-change and binary cases, and a parser that throws on an
 * unrecognised header would fail the whole review over one unusual file.
 * Unknown headers are skipped; the file simply carries no hunks.
 */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = diff.split("\n");

  let current: FileChange | null = null;
  let newLineNumber = 0;
  let oldLineNumber = 0;

  const flush = (): void => {
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const path = match ? match[2] : "";
      current = {
        path: normalizePath(path),
        kind: "modified",
        hunks: [],
        addedLines: new Set(),
        removedLines: new Set(),
        additions: 0,
        deletions: 0,
      };
      if (match && match[1] !== match[2]) {
        current.previousPath = normalizePath(match[1]);
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("new file mode")) {
      current.kind = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.kind = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.previousPath = normalizePath(line.slice("rename from ".length));
      current.kind = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = normalizePath(line.slice("rename to ".length));
      current.kind = "renamed";
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      current.kind = "binary";
      continue;
    }
    // File headers appear only between `diff --git` and the first `@@`. Once a
    // hunk is open, a line starting with `--- ` is CONTENT — a deleted line
    // whose text begins `-- ` (an SQL or Lua comment, say) — and swallowing it
    // as a header dropped the deletion and desynced every later line number in
    // the hunk. Same for `+++ ` with added `++ ` content, which additionally
    // re-keyed the whole file to a garbage path.
    if (current.hunks.length === 0 && line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path !== "/dev/null") {
        current.path = normalizePath(path.replace(/^b\//, ""));
      }
      continue;
    }
    if (current.hunks.length === 0 && line.startsWith("--- ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        current.kind = "added";
      }
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      const hunk: Hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
      };
      current.hunks.push(hunk);
      newLineNumber = hunk.newStart;
      oldLineNumber = hunk.oldStart;
      continue;
    }

    if (current.hunks.length === 0) {
      continue;
    }

    if (line.startsWith("+")) {
      current.addedLines.add(newLineNumber);
      current.additions += 1;
      newLineNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.removedLines.add(oldLineNumber);
      current.deletions += 1;
      oldLineNumber += 1;
      continue;
    }
    if (line.startsWith(" ") || line.length === 0) {
      newLineNumber += 1;
      oldLineNumber += 1;
      continue;
    }
    // "\ No newline at end of file" and anything else: no line consumed.
  }

  flush();
  return files;
}

/**
 * Build a review-ready change set.
 *
 * Exclusion happens here, in code, before the agent ever sees a file list. Files
 * removed are kept in `excluded` with a reason, because a reviewer who silently
 * skips half a PR is indistinguishable from one that found nothing wrong.
 *
 * When `maxFiles` truncates, the largest changes are kept: a 900-line file is
 * where the risk lives, and dropping it to review nine one-line files would
 * optimise for count over consequence.
 */
export function buildChangeSet(options: BuildChangeSetOptions): ChangeSet {
  const parsed = parseUnifiedDiff(options.diff);

  const included: FileChange[] = [];
  const excluded: FileChange[] = [];

  for (const file of parsed) {
    if (file.kind === "binary") {
      excluded.push({ ...file, excluded: true, excludedReason: "binary" });
      continue;
    }
    if (matchesAnyPath(file.path, options.excludePatterns)) {
      excluded.push({
        ...file,
        excluded: true,
        excludedReason: "excludePatterns",
      });
      continue;
    }
    if (looksGenerated(file.path)) {
      excluded.push({ ...file, excluded: true, excludedReason: "generated" });
      continue;
    }
    // A deleted file's content cannot be fixed, so under the "ignore" policy it
    // is not review material — but it is NOT dropped: it stays in `excluded`,
    // and ownership and guards read excluded files too, because a deletion is
    // exactly when an owner should be looking. What this frees is `maxFiles`
    // budget and agent attention, which on a refactor-heavy pull request is
    // most of both.
    if (options.deletions === "ignore" && file.kind === "deleted") {
      excluded.push({ ...file, excluded: true, excludedReason: "deleted" });
      continue;
    }
    included.push(file);
  }

  let truncated = false;
  let files = included;
  if (options.maxFiles > 0 && included.length > options.maxFiles) {
    truncated = true;
    files = [...included]
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, options.maxFiles);
    for (const file of included) {
      if (!files.includes(file)) {
        excluded.push({ ...file, excluded: true, excludedReason: "maxFiles" });
      }
    }
  }

  return {
    baseSha: options.baseSha,
    headSha: options.headSha,
    files,
    excluded,
    truncated,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** Find a file in the change set, matching renames on either path. */
export function findFile(
  changeSet: ChangeSet,
  path: string,
): FileChange | undefined {
  const target = normalizePath(path);
  return changeSet.files.find(
    (file) => file.path === target || file.previousPath === target,
  );
}

export function fileInChangeSet(changeSet: ChangeSet, path: string): boolean {
  return findFile(changeSet, path) !== undefined;
}

/**
 * Did this pull request change this line?
 *
 * A deleted file has no line to anchor to, so any line "counts" — the finding is
 * about the deletion itself. Everywhere else, only added or modified lines on
 * the new side qualify.
 */
export function lineWasChanged(
  changeSet: ChangeSet,
  path: string,
  line: number,
): boolean {
  const file = findFile(changeSet, path);
  if (!file) {
    return false;
  }
  if (file.kind === "deleted") {
    return true;
  }
  return file.addedLines.has(line);
}

/** Every changed path, for policy evaluation. Includes both sides of renames. */
export function changedPaths(
  changeSet: ChangeSet,
  options: { includeExcluded?: boolean } = {},
): string[] {
  const source = options.includeExcluded
    ? [...changeSet.files, ...changeSet.excluded]
    : changeSet.files;
  const paths = new Set<string>();
  for (const file of source) {
    paths.add(file.path);
    if (file.previousPath) {
      paths.add(file.previousPath);
    }
  }
  return [...paths];
}
