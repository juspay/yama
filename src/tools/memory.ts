/**
 * The memory on disk (TASKS:Y7.2) — what earlier reviews decided, as documents.
 *
 * `.yama/memory/` is committed, human-readable and human-editable. That is the whole
 * design: a fact a reviewer disagrees with should be deletable with `rm`, and a fact that
 * is nearly right should be fixable in an editor. So it is one Markdown file per fact plus
 * an index, not a database.
 *
 *     .yama/memory/
 *       index.md          generated: every fact, newest first
 *       facts/<id>.md     one fact, one file — the id IS the file name
 *
 * The index is REBUILT from the directory on every write rather than appended to, so it
 * cannot drift from the facts it lists: a fact deleted by hand disappears from the index
 * the next time learn runs, without anyone having to remember to remove the line.
 */
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { MemoryFact, MemoryFile } from "../types/index.js";
import { isMissing, readTextFile } from "../util/fs.js";

/** Sub-directory holding one file per fact. */
export const FACTS_DIR = "facts";

/** The generated index. Never hand-edited — a write rebuilds it from the facts. */
export const MEMORY_INDEX = "index.md";

/** Field header a fact file carries, so the id survives a round trip through disk. */
const FIELD = {
  id: "yama-fact",
  kind: "kind",
  scope: "scope",
  sources: "sources",
  learnedAt: "learned-at",
} as const;

/** Where one fact's file lives, under the memory directory. */
export const factPath = (memoryDir: string, id: string): string =>
  join(memoryDir, FACTS_DIR, `${id}.md`);

/** Where the generated index lives. */
export const indexPath = (memoryDir: string): string =>
  join(memoryDir, MEMORY_INDEX);

/**
 * One fact as its file. The header is a plain list rather than YAML front matter because
 * the file is read by humans and by a model reading `read_file`, and neither needs a
 * parser to understand a line that says what it is.
 */
export const renderFact = (
  fact: MemoryFact,
  provenance: { pr: number; learnedAt: string },
): string =>
  [
    `# ${fact.statement}`,
    "",
    `- ${FIELD.id}: ${fact.id}`,
    `- ${FIELD.kind}: ${fact.kind}`,
    `- ${FIELD.scope}: ${fact.scope.length > 0 ? fact.scope.join(", ") : "(whole repository)"}`,
    `- ${FIELD.sources}: ${fact.sources.length > 0 ? fact.sources.join(", ") : "(none recorded)"}`,
    `- ${FIELD.learnedAt}: ${provenance.learnedAt} · pull request #${provenance.pr}`,
    "",
    "## Why",
    "",
    fact.rationale,
    "",
    "> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if",
    "> it is nearly right, delete the file if it is wrong — the index rebuilds from this",
    "> directory on the next run.",
    "",
  ].join("\n");

// All three patterns use disjoint character classes and single separators so the scans
// stay linear — `\s+(...)\s*$`-style shapes backtrack polynomially on trailing whitespace.

/** Reads the fact id out of a fact file, so a hand-renamed file cannot go untracked. */
export const factIdOf = (content: string): string | undefined =>
  /^- ?yama-fact: ?([^\s]+) *$/m.exec(content)?.[1];

/** The statement line of a fact file — the index's own text comes from the file itself. */
const statementOf = (content: string): string => {
  const line = /^#[ \t](.*)$/m.exec(content)?.[1]?.trim();
  return line && line.length > 0 ? line : "(no statement)";
};

const kindOf = (content: string): string =>
  /^- ?kind: ?([^\s]+) *$/m.exec(content)?.[1] ?? "knowledge";

/** Every fact file on disk, by id, newest name order. Absent directory reads as empty. */
export const readFactFiles = async (
  memoryDir: string,
): Promise<{ id: string; file: string; content: string }[]> => {
  let names: string[];
  try {
    names = await readdir(join(memoryDir, FACTS_DIR));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const facts: { id: string; file: string; content: string }[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const file = join(memoryDir, FACTS_DIR, name);
    const content = await readTextFile(file);
    if (content !== undefined) {
      facts.push({ id: factIdOf(content) ?? name.slice(0, -3), file, content });
    }
  }
  return facts;
};

/**
 * The index, rebuilt from the fact files themselves. Passing `pending` folds in facts
 * this run is about to write, so the index and the facts land in the same commit.
 */
export const renderMemoryIndex = (
  onDisk: readonly { id: string; content: string }[],
  pending: readonly MemoryFact[] = [],
): string => {
  const replaced = new Set(pending.map((fact) => fact.id));
  const rows = [
    ...pending.map((fact) => ({
      id: fact.id,
      kind: fact.kind,
      statement: fact.statement,
    })),
    ...onDisk
      .filter((entry) => !replaced.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        kind: kindOf(entry.content),
        statement: statementOf(entry.content),
      })),
  ].sort((a, b) => a.id.localeCompare(b.id));

  return [
    "# Review memory",
    "",
    "What earlier reviews of this repository decided. Written by `yama learn` after a pull",
    "request merges; read by every review during WarmUp. A note in here outranks a general",
    "principle — it is what this repository actually settled on.",
    "",
    "**This file is generated.** Edit or delete the fact files under `facts/`; this index is",
    "rebuilt from them on the next `yama learn`.",
    "",
    ...(rows.length > 0
      ? [
          `${rows.length} fact(s):`,
          "",
          ...rows.map(
            (row) =>
              `- [\`${row.id}\`](${FACTS_DIR}/${row.id}.md) · ${row.kind} — ${row.statement}`,
          ),
        ]
      : ["No facts recorded yet."]),
    "",
  ].join("\n");
};

/**
 * Every file a learn run would write, rendered but not written (TASKS:Y7.2).
 *
 * Returned as data so that the dry run and the real run are the same code path minus the
 * writes — what a `--dry-run` prints is exactly what a real run would put on disk.
 */
export const renderMemoryFiles = async (options: {
  memoryDir: string;
  facts: readonly MemoryFact[];
  pr: number;
  learnedAt?: string;
}): Promise<MemoryFile[]> => {
  const learnedAt = options.learnedAt ?? new Date().toISOString();
  const onDisk = await readFactFiles(options.memoryDir);
  return [
    ...options.facts.map((fact) => ({
      path: factPath(options.memoryDir, fact.id),
      content: renderFact(fact, { pr: options.pr, learnedAt }),
    })),
    {
      path: indexPath(options.memoryDir),
      content: renderMemoryIndex(onDisk, options.facts),
    },
  ];
};
