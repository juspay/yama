/**
 * The agent's read access to the checked-out repository.
 *
 * This is the local-first half of the design: reading a file from disk costs
 * nothing and returns the real thing, where reading it through a VCS API costs a
 * round trip and returns whatever the API felt like paginating. v3 made four
 * hundred tool calls to reconstruct what `git diff` prints in one.
 *
 * Every path goes through the sandbox and every git command through the
 * read-only allow-list. Both fail closed, and both are pure functions tested
 * separately — this module only turns them into tools.
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceToolOptions, YamaTool } from "../types/index.js";
import { resolveInSandbox } from "./sandbox.js";
import { parseGitCommand } from "./gitSafe.js";

const run = promisify(execFile);

/** Output cap per call. Enough to read a large file; not enough to flood a window. */
const MAX_CHARS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const truncate = (text: string, limit = MAX_CHARS): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} more characters]`;

/** Read a file, or a slice of one. */
export function readFileTool(options: WorkspaceToolOptions): YamaTool {
  return {
    name: "read_file",
    description:
      "Read a file from the checked-out repository. Prefer this over fetching file " +
      "content through the VCS — it is the same bytes, without the round trip. Pass " +
      "`startLine`/`endLine` to read part of a large file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative path.",
        },
        startLine: { type: "number", description: "1-indexed, inclusive." },
        endLine: { type: "number", description: "1-indexed, inclusive." },
      },
      required: ["path"],
    },
    stages: ["resolve", "orient", "review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const check = resolveInSandbox(
        String(params.path ?? ""),
        options.projectRoot,
      );
      if (!check.allowed) {
        return { error: check.reason };
      }
      try {
        const content = await readFile(check.absolutePath, "utf8");
        const start =
          typeof params.startLine === "number" ? params.startLine : undefined;
        const end =
          typeof params.endLine === "number" ? params.endLine : undefined;

        if (start === undefined && end === undefined) {
          return { path: params.path, content: truncate(content) };
        }

        // A trailing newline is a terminator, not a fifth line. Reporting one
        // more line than the file has sends the agent looking at nothing.
        const lines = content.replace(/\n$/, "").split("\n");
        const from = Math.max(1, start ?? 1);
        const to = Math.min(lines.length, end ?? lines.length);
        return {
          path: params.path,
          startLine: from,
          endLine: to,
          totalLines: lines.length,
          content: truncate(
            lines
              .slice(from - 1, to)
              .map((line, index) => `${from + index}\t${line}`)
              .join("\n"),
          ),
        };
      } catch (error) {
        return {
          error: `Could not read "${params.path}": ${(error as Error).message}`,
        };
      }
    },
  };
}

/** List a directory. */
export function listFilesTool(options: WorkspaceToolOptions): YamaTool {
  return {
    name: "list_files",
    description:
      "List the entries of a directory in the checked-out repository. Use it to orient " +
      "yourself in an unfamiliar area before reading files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative directory. Defaults to the root.",
        },
      },
    },
    stages: ["resolve", "orient", "review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const check = resolveInSandbox(
        String(params.path ?? "."),
        options.projectRoot,
      );
      if (!check.allowed) {
        return { error: check.reason };
      }
      try {
        const entries = await readdir(check.absolutePath, {
          withFileTypes: true,
        });
        return {
          path: params.path ?? ".",
          entries: entries
            .filter(
              (entry) => entry.name !== ".git" && entry.name !== "node_modules",
            )
            .slice(0, 500)
            .map((entry) => ({
              name: entry.name,
              kind: entry.isDirectory() ? "directory" : "file",
            })),
        };
      } catch (error) {
        return {
          error: `Could not list "${params.path}": ${(error as Error).message}`,
        };
      }
    },
  };
}

/**
 * Search the repository.
 *
 * `execFile` with an argument array, never a shell string: the pattern comes
 * from a model reading attacker-controlled text, and a shell would make it
 * arbitrary code execution. ripgrep when available, `git grep` otherwise —
 * both respect ignore files, which is what keeps `node_modules` out of results.
 */
export function searchCodeTool(options: WorkspaceToolOptions): YamaTool {
  return {
    name: "search_code",
    description:
      "Search the repository for a pattern (regular expression). Use it to find callers, " +
      "other implementations of a convention, or whether a problem you found repeats " +
      "elsewhere. Results are file:line:text.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        path: { type: "string", description: "Restrict to this subdirectory." },
        glob: {
          type: "string",
          description: 'Restrict to matching files, e.g. "*.ts".',
        },
        maxResults: { type: "number" },
      },
      required: ["pattern"],
    },
    stages: ["orient", "review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const pattern = String(params.pattern ?? "");
      if (!pattern) {
        return { error: "A pattern is required." };
      }

      let searchRoot = options.projectRoot;
      if (params.path) {
        const check = resolveInSandbox(
          String(params.path),
          options.projectRoot,
        );
        if (!check.allowed) {
          return { error: check.reason };
        }
        searchRoot = check.absolutePath;
      }

      const limit = Math.min(
        typeof params.maxResults === "number" ? params.maxResults : 100,
        300,
      );

      const attempts: Array<{ file: string; args: string[] }> = [
        {
          file: "rg",
          args: [
            "--line-number",
            "--no-heading",
            "--color=never",
            `--max-count=${limit}`,
            ...(params.glob ? ["--glob", String(params.glob)] : []),
            "--regexp",
            pattern,
            searchRoot,
          ],
        },
        {
          file: "git",
          args: [
            "grep",
            "--line-number",
            "--no-color",
            "-I",
            "-E",
            "--",
            pattern,
            ...(params.glob ? [`*${String(params.glob)}`] : []),
          ],
        },
      ];

      for (const attempt of attempts) {
        try {
          const { stdout } = await run(attempt.file, attempt.args, {
            cwd: attempt.file === "git" ? searchRoot : options.projectRoot,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          });
          return formatMatches(stdout, options.projectRoot, limit);
        } catch (error) {
          const failure = error as { code?: number | string; stdout?: string };
          // Exit 1 is "no matches" for both tools — a result, not a failure.
          if (failure.code === 1) {
            return { matches: [], count: 0 };
          }
          if (typeof failure.stdout === "string" && failure.stdout.length > 0) {
            return formatMatches(failure.stdout, options.projectRoot, limit);
          }
          // ENOENT on rg: fall through to git grep.
        }
      }

      return { error: "No search backend is available in this environment." };
    },
  };
}

function formatMatches(
  stdout: string,
  projectRoot: string,
  limit: number,
): {
  matches: Array<{ path: string; line: number; text: string }>;
  count: number;
  truncated?: boolean;
} {
  const lines = stdout.split("\n").filter(Boolean);
  const matches = lines.slice(0, limit).flatMap((line) => {
    const match = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!match) {
      return [];
    }
    const path = match[1].startsWith("/")
      ? relative(projectRoot, match[1])
      : match[1];
    return [{ path, line: Number(match[2]), text: match[3].slice(0, 400) }];
  });
  return {
    matches,
    count: matches.length,
    ...(lines.length > limit ? { truncated: true } : {}),
  };
}

/**
 * Read-only git.
 *
 * The allow-list is the authority and it treats unknown subcommands as
 * mutating. Arguments are passed as an array so no shell is involved.
 */
export function gitTool(options: WorkspaceToolOptions): YamaTool {
  return {
    name: "git",
    description:
      "Run a read-only git command in the checked-out repository — log, diff, show, " +
      "blame, and similar. Anything that could modify the repository is refused. " +
      "`git diff <base>...<head>` is the fastest way to see exactly what changed.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The full command, e.g. "git diff origin/main...HEAD -- src/".',
        },
      },
      required: ["command"],
    },
    stages: ["resolve", "orient", "review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const check = parseGitCommand(String(params.command ?? ""));
      if (!check.allowed) {
        return { error: check.reason };
      }
      try {
        const { stdout, stderr } = await run("git", check.args, {
          cwd: options.projectRoot,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { output: truncate(stdout || stderr) };
      } catch (error) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          message: string;
        };
        return {
          // A non-zero git exit is often the answer (no such ref, empty diff),
          // so its output is returned rather than swallowed into an error.
          output: truncate(failure.stdout ?? ""),
          error: truncate(failure.stderr || failure.message, 2_000),
        };
      }
    },
  };
}

export function buildWorkspaceTools(options: WorkspaceToolOptions): YamaTool[] {
  return [
    readFileTool(options),
    listFilesTool(options),
    searchCodeTool(options),
    gitTool(options),
  ];
}

/** True when the path is a directory. Used by the doctor's workspace probe. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
