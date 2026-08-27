/**
 * The agent's read-only filesystem toolset (TASKS:Y3.1).
 *
 * Two tools, both sandboxed: every path is resolved through realpath and must land inside
 * the repository root, so a symlink pointing out of the tree is a refusal rather than a
 * read. There is deliberately no write tool — the review path never edits the repo.
 *
 * Files are paged, not truncated: `read_file` returns a window plus `hasMore`, and the
 * whole file is always reachable by asking for the next offset.
 */
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { EngineToolRegistrar, FsToolConfig } from "../types/index.js";
import { readTextFile, resolveWithinRoot } from "../util/fs.js";
import { jsonSchemaOf, refuse } from "../util/tool.js";

/** Characters returned by one `read_file` call when the model does not say. */
const DEFAULT_READ_CHARS = 64 * 1024;
/** Entries returned by one `list_files` call. */
const DEFAULT_MAX_ENTRIES = 500;
/** Directories a code review never needs to walk. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".yama"]);

const ReadSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

const ListSchema = z.object({
  path: z.string().optional(),
  depth: z.number().int().min(1).max(8).optional(),
});

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
      "Read a repository file. Paths are repository-relative and confined to the checkout. Long files come back a page at a time — when hasMore is true, ask again with the next offset rather than guessing at the rest.",
    inputSchema: jsonSchemaOf(ReadSchema),
    execute: async (params) => {
      const parsed = ReadSchema.safeParse(params ?? {});
      if (!parsed.success) {
        return refuse(
          "read_file needs { path, offset?, limit? } with a non-empty path.",
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
      const offset = parsed.data.offset ?? 0;
      const page = content.slice(
        offset,
        offset + (parsed.data.limit ?? maxBytes),
      );
      return {
        path: relative(root, resolved) || parsed.data.path,
        content: page,
        offset,
        totalSize: content.length,
        hasMore: offset + page.length < content.length,
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
