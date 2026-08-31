/**
 * The agent's read-only filesystem toolset (TASKS:Y3.1).
 *
 * Two tools, both sandboxed: every path is resolved through realpath and must land inside
 * the repository root, so a symlink pointing out of the tree is a refusal rather than a
 * read. There is deliberately no write tool — the review path never edits the repo.
 *
 * Files are paged, not truncated: `read_file` returns a window of LINES plus `hasMore`,
 * and the whole file is always reachable through the `nextOffset` it hands back.
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { EngineToolRegistrar, FsToolConfig } from "../types/index.js";
import { readTextFile, resolveWithinRoot } from "../util/fs.js";
import { jsonSchemaOf, refuse } from "../util/tool.js";

/** Ceiling on one `read_file` page, in characters. Lines are never cut in half. */
const DEFAULT_READ_CHARS = 64 * 1024;
/** Entries returned by one `list_files` call. */
const DEFAULT_MAX_ENTRIES = 500;
/** Directories a code review never needs to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".yama"]);

const ReadSchema = z.object({
  path: z.string().min(1),
  /** 1-based LINE to start at. Omit for the top of the file. */
  offset: z.number().int().min(0).optional(),
  /** How many LINES to return. Omit for as much of the file as fits in one page. */
  limit: z.number().int().min(1).optional(),
});

const ListSchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().min(1).max(8).optional(),
});

/**
 * One page of a file, addressed in LINES.
 *
 * It used to be addressed in characters, and nothing said so — the description spoke of
 * "the next offset" and the result carried a `totalSize` that was a character count. Every
 * model reads those as lines, and one measured run proves what that costs: a stage spent
 * 29 of its 32 steps walking a 17 KB file in 300-to-800 character windows (`offset: 0`,
 * `380`, `4800`, `5600`, …), never reached the work it was there to do, and the review
 * failed. The model's own note in that transcript reads "the read tool is quirky with
 * offsets". It was not quirky; it was lying.
 *
 * So: `offset` is a 1-based LINE number, `limit` is a COUNT OF LINES, and the result hands
 * back `nextOffset` so paging never requires arithmetic against a unit you have to guess.
 * The byte ceiling still applies — a page stops early rather than returning a megabyte —
 * and when it does, `nextOffset` points at the first line that did not fit.
 */
const pageOf = (
  content: string,
  offset: number | undefined,
  limit: number | undefined,
  maxBytes: number,
): {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
  nextOffset?: number;
} => {
  const lines = content.split("\n");
  // A trailing newline yields one empty last element; it is not a line anyone can read.
  const totalLines =
    lines.length > 1 && lines[lines.length - 1] === ""
      ? lines.length - 1
      : lines.length;
  // 0 and 1 both mean "the top of the file": a model that counts from zero is not wrong
  // enough to deserve an empty page.
  const startLine = Math.min(Math.max(offset ?? 1, 1), totalLines || 1);
  const wanted = limit ?? totalLines;

  const taken: string[] = [];
  let bytes = 0;
  let line = startLine;
  while (line <= totalLines && taken.length < wanted) {
    const text = lines[line - 1] ?? "";
    // Always take the first line, however long: a page that comes back empty teaches the
    // model nothing except to try the same call again.
    if (taken.length > 0 && bytes + text.length + 1 > maxBytes) {
      break;
    }
    taken.push(text);
    bytes += text.length + 1;
    line += 1;
  }

  const endLine = line - 1;
  const hasMore = endLine < totalLines;
  return {
    content: taken.join("\n"),
    startLine,
    endLine,
    totalLines,
    hasMore,
    ...(hasMore ? { nextOffset: line } : {}),
  };
};

const escaped = (path: string): { isError: true; error: string } =>
  refuse(
    `"${path}" resolves outside the repository. Ask for a repository-relative path inside the checkout.`,
  );

/** Recursive listing, bounded by depth and entry count; never follows out of the root. */
const walk = async (
  dir: string,
  root: string,
  depth: number,
  budget: { left: number },
): Promise<{ path: string; kind: "file" | "dir"; size?: number }[]> => {
  if (depth === 0 || budget.left <= 0) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const found: { path: string; kind: "file" | "dir"; size?: number }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.left <= 0) {
      break;
    }
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = join(dir, entry.name);
    const rel = relative(root, absolute);
    budget.left -= 1;
    if (entry.isDirectory()) {
      found.push({ path: rel, kind: "dir" });
      found.push(...(await walk(absolute, root, depth - 1, budget)));
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      found.push({ path: rel, kind: "file", size: info.size });
    }
  }
  return found;
};

/** Registers `read_file` and `list_files`, both confined to `config.root`. */
export const registerFsTools = (options: {
  register: EngineToolRegistrar;
  config: FsToolConfig;
}): void => {
  const root = options.config.root;
  const maxBytes = options.config.maxBytes ?? DEFAULT_READ_CHARS;
  const maxEntries = options.config.maxEntries ?? DEFAULT_MAX_ENTRIES;

  options.register("read_file", {
    description:
      "Read a repository file. Paths are repository-relative and confined to the checkout. offset and limit are in LINES, not characters: offset is the 1-based first line to return and limit is how many lines to return. Omit both to read the whole file — that is one step, and it is usually the right call. When hasMore is true, ask again with the nextOffset the result gives you.",
    inputSchema: jsonSchemaOf(ReadSchema),
    execute: async (params) => {
      const parsed = ReadSchema.safeParse(params ?? {});
      if (!parsed.success) {
        return refuse(
          "read_file needs { path, offset?, limit? } with a non-empty path. offset is a 1-based line number and limit is a number of lines.",
        );
      }
      const resolved = await resolveWithinRoot(parsed.data.path, root);
      if (resolved === undefined) {
        return escaped(parsed.data.path);
      }
      // A directory is a refusal with a next step, not an EISDIR crash surfaced raw
      // to the model (observed live: read_file on a directory threw and burned a step).
      const kind = await stat(resolved).catch(() => undefined);
      if (kind?.isDirectory()) {
        return refuse(
          `"${parsed.data.path}" is a directory — use list_files to see what is inside it, then read a file.`,
        );
      }
      const content = await readTextFile(resolved);
      if (content === undefined) {
        return refuse(
          `no file at "${parsed.data.path}". Use list_files to see what is there.`,
        );
      }
      return {
        path: relative(root, resolved) || parsed.data.path,
        ...pageOf(content, parsed.data.offset, parsed.data.limit, maxBytes),
      };
    },
  });

  options.register("list_files", {
    description:
      "List repository files and directories under a path. Skips .git, node_modules, dist and .yama. Use it to find the rulebook and memory files before reading them.",
    inputSchema: jsonSchemaOf(ListSchema),
    execute: async (params) => {
      const parsed = ListSchema.safeParse(params ?? {});
      if (!parsed.success) {
        return refuse("list_files takes { path?, depth? }.");
      }
      const target = parsed.data.path ?? ".";
      const resolved = await resolveWithinRoot(target, root);
      if (resolved === undefined) {
        return escaped(target);
      }
      let info;
      try {
        info = await stat(resolved);
      } catch {
        return refuse(`no directory at "${target}". List its parent first.`);
      }
      if (!info.isDirectory()) {
        return refuse(
          `"${target}" is a file, not a directory. Read it with read_file.`,
        );
      }
      const budget = { left: maxEntries };
      const entries = await walk(
        resolved,
        root,
        parsed.data.depth ?? 2,
        budget,
      );
      return {
        path: relative(root, resolved) || ".",
        entries,
        truncated: budget.left <= 0,
      };
    },
  });
};
