/**
 * Suite: the agent's read-only toolset and the argv git plumbing (TASKS:Y3.1, Y3.2).
 *
 * Two things are being pinned. The sandbox: a path that resolves outside the checkout is
 * a refusal, symlinks included — this is the only thing standing between a review agent
 * and the rest of the filesystem. And the diff: local mode must see untracked files, or a
 * brand-new module would be reviewed as if it did not exist.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  isBuilt,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("tools");

type ToolsApi = {
  resolveWithinRoot: (
    target: string,
    root: string,
  ) => Promise<string | undefined>;
  registerFsTools: (options: {
    register: (name: string, tool: ToolRecord) => void;
    config: { root: string; maxBytes?: number; maxEntries?: number };
  }) => void;
  acquireDiff: (req: { root: string }) => Promise<DiffShape>;
  summarizeDiff: (diff: DiffShape) => string;
  gitHeadSha: (root: string) => Promise<string | undefined>;
  isGitRepo: (root: string) => Promise<boolean>;
};

type ToolRecord = {
  description: string;
  inputSchema?: object;
  execute: (params: unknown, context?: unknown) => Promise<unknown>;
};

type DiffShape = {
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
  additions: number;
  deletions: number;
  patch: string;
  empty: boolean;
  head?: string;
};

type ToolResult = Record<string, unknown> & {
  isError?: boolean;
  error?: string;
};

const load = async (): Promise<ToolsApi> => {
  const mod = await import(DIST_ENTRY);
  return mod as ToolsApi;
};

/** Registers the fs toolset into a plain map, the way the seam would. */
const fsTools = async (root: string, config?: { maxEntries?: number }) => {
  const tools = new Map<string, ToolRecord>();
  const api = await load();
  api.registerFsTools({
    register: (name, tool) => tools.set(name, tool),
    config: { root, ...(config ?? {}) },
  });
  return {
    call: async (name: string, params: unknown): Promise<ToolResult> =>
      (await tools.get(name)?.execute(params)) as ToolResult,
    names: [...tools.keys()],
  };
};

/** A git repository with one commit, built with argv git — no shell anywhere. */
const gitRepo = async (dir: string): Promise<void> => {
  const run = (args: string[]) => runCommand("git", args, { cwd: dir });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Yama Test"]);
  await run(["config", "commit.gpgsign", "false"]);
  await writeFile(
    path.join(dir, "kept.ts"),
    "export const kept = 1;\n",
    "utf8",
  );
  await writeFile(
    path.join(dir, "gone.ts"),
    "export const gone = 1;\n",
    "utf8",
  );
  await run(["add", "-A"]);
  await run(["commit", "-q", "-m", "initial"]);
};

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("the path sandbox");

  await test("a path inside the root resolves; `..` does not", async () => {
    const api = await load();
    await withTempDir("sandbox", async (dir) => {
      const root = path.join(dir, "repo");
      await mkdir(path.join(root, "src"), { recursive: true });
      await writeFile(path.join(root, "src", "a.ts"), "a", "utf8");
      assert(
        (await api.resolveWithinRoot("src/a.ts", root)) !== undefined,
        "a file inside the root must resolve",
      );
      assertEqual(
        await api.resolveWithinRoot("../outside.txt", root),
        undefined,
        "a parent-relative escape",
      );
      assertEqual(
        await api.resolveWithinRoot("/etc/passwd", root),
        undefined,
        "an absolute path outside the root",
      );
    });
  });

  await test("a symlink pointing out of the tree is an escape", async () => {
    const api = await load();
    await withTempDir("sandbox", async (dir) => {
      const root = path.join(dir, "repo");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(dir, "secret.txt"), "s", "utf8");
      await symlink(path.join(dir, "secret.txt"), path.join(root, "link.txt"));
      assertEqual(
        await api.resolveWithinRoot("link.txt", root),
        undefined,
        "a symlink out of the root must not resolve",
      );
    });
  });

  section("read_file and list_files");

  await test("both tools are registered, and only those two", async () => {
    await withTempDir("fs", async (dir) => {
      const tools = await fsTools(dir);
      assertEqual(
        tools.names.sort().join(","),
        "list_files,read_file",
        "tool names",
      );
    });
  });

  await test("read_file pages a long file instead of truncating it", async () => {
    await withTempDir("fs", async (dir) => {
      await writeFile(
        path.join(dir, "long.txt"),
        "abcdefghij".repeat(10),
        "utf8",
      );
      const tools = await fsTools(dir);
      const first = await tools.call("read_file", {
        path: "long.txt",
        limit: 30,
      });
      assertEqual(first.totalSize, 100, "total size");
      assertEqual(String(first.content).length, 30, "first page length");
      assertEqual(first.hasMore, true, "hasMore on the first page");
      const last = await tools.call("read_file", {
        path: "long.txt",
        offset: 90,
      });
      assertEqual(String(last.content).length, 10, "last page length");
      assertEqual(last.hasMore, false, "hasMore on the last page");
    });
  });

  await test("read_file refuses an escape and names the fix", async () => {
    await withTempDir("fs", async (dir) => {
      await writeFile(path.join(dir, "in.txt"), "x", "utf8");
      const tools = await fsTools(dir);
      const refused = await tools.call("read_file", { path: "../in.txt" });
      assertEqual(refused.isError, true, "escape must be refused");
      assertIncludes(
        String(refused.error),
        "outside the repository",
        "refusal text",
      );
    });
  });

  await test("read_file refuses a file that is not there", async () => {
    await withTempDir("fs", async (dir) => {
      const tools = await fsTools(dir);
      const refused = await tools.call("read_file", { path: "nope.txt" });
      assertEqual(refused.isError, true, "missing file must be refused");
      assertIncludes(
        String(refused.error),
        "list_files",
        "refusal must name the way out",
      );
    });
  });

  await test("list_files walks the tree and skips .git and node_modules", async () => {
    await withTempDir("fs", async (dir) => {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await mkdir(path.join(dir, ".git"), { recursive: true });
      await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(dir, "src", "a.ts"), "a", "utf8");
      await writeFile(path.join(dir, ".git", "HEAD"), "ref", "utf8");
      await writeFile(
        path.join(dir, "node_modules", "pkg", "i.js"),
        "j",
        "utf8",
      );
      const tools = await fsTools(dir);
      const listed = await tools.call("list_files", { path: ".", depth: 3 });
      const paths = (listed.entries as { path: string }[]).map((e) => e.path);
      assert(
        paths.includes(path.join("src", "a.ts")),
        "source file must be listed",
      );
      assert(
        !paths.some((p) => p.startsWith(".git")),
        ".git must never be walked",
      );
      assert(
        !paths.some((p) => p.startsWith("node_modules")),
        "node_modules must never be walked",
      );
    });
  });

  await test("list_files refuses a file, and points at read_file", async () => {
    await withTempDir("fs", async (dir) => {
      await writeFile(path.join(dir, "a.ts"), "a", "utf8");
      const tools = await fsTools(dir);
      const refused = await tools.call("list_files", { path: "a.ts" });
      assertEqual(refused.isError, true, "a file is not a directory");
      assertIncludes(
        String(refused.error),
        "read_file",
        "refusal must name the right tool",
      );
    });
  });

  section("argv git");

  await test("a directory with no repository is not a work tree", async () => {
    const api = await load();
    await withTempDir("git", async (dir) => {
      assertEqual(await api.isGitRepo(dir), false, "plain directory");
    });
  });

  await test("the local diff sees modified, deleted AND untracked files", async () => {
    const api = await load();
    await withTempDir("git", async (dir) => {
      await gitRepo(dir);
      await writeFile(
        path.join(dir, "kept.ts"),
        "export const kept = 2;\n",
        "utf8",
      );
      await runCommand("git", ["rm", "-q", "gone.ts"], { cwd: dir });
      await writeFile(
        path.join(dir, "brand-new.ts"),
        "export const fresh = 3;\n",
        "utf8",
      );

      const diff = await api.acquireDiff({ root: dir });
      const byPath = new Map(diff.files.map((file) => [file.path, file]));
      assertEqual(byPath.get("kept.ts")?.status, "modified", "modified file");
      assertEqual(byPath.get("gone.ts")?.status, "deleted", "deleted file");
      assertEqual(
        byPath.get("brand-new.ts")?.status,
        "added",
        "untracked file must be part of the local diff",
      );
      assertEqual(diff.empty, false, "a diff with files is not empty");
      assertIncludes(
        diff.patch,
        "brand-new.ts",
        "patch must contain the untracked file",
      );
      assertIncludes(
        diff.patch,
        "kept.ts",
        "patch must contain the modified file",
      );
    });
  });

  await test("line counts survive the numstat/name-status pairing", async () => {
    const api = await load();
    await withTempDir("git", async (dir) => {
      await gitRepo(dir);
      await writeFile(path.join(dir, "kept.ts"), "one\ntwo\nthree\n", "utf8");
      const diff = await api.acquireDiff({ root: dir });
      const kept = diff.files.find((file) => file.path === "kept.ts");
      assertEqual(kept?.additions, 3, "additions on the modified file");
      assertEqual(kept?.deletions, 1, "deletions on the modified file");
      assertIncludes(api.summarizeDiff(diff), "kept.ts", "summary line");
    });
  });

  await test("a clean tree produces an empty diff, not an error", async () => {
    const api = await load();
    await withTempDir("git", async (dir) => {
      await gitRepo(dir);
      const diff = await api.acquireDiff({ root: dir });
      assertEqual(diff.empty, true, "clean tree");
      assertEqual(diff.files.length, 0, "no changed files");
      assertEqual(typeof (await api.gitHeadSha(dir)), "string", "head sha");
    });
  });

  await test("a path with a space and a shell metacharacter is just a path", async () => {
    const api = await load();
    await withTempDir("git", async (dir) => {
      await gitRepo(dir);
      await writeFile(
        path.join(dir, "a file; echo pwned.ts"),
        "export const x = 1;\n",
        "utf8",
      );
      const diff = await api.acquireDiff({ root: dir });
      assert(
        diff.files.some((file) => file.path.includes("echo pwned")),
        "argv execution must treat metacharacters as literal path characters",
      );
    });
  });
}
