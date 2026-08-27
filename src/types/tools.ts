/**
 * Yama-owned tooling: the read-only filesystem tools the agent gets (TASKS:Y3.1) and the
 * argv-only git plumbing the shell uses to acquire a diff (TASKS:Y3.2, PLAN.md section 3).
 */

/** How one file changed. Renames keep the old path so a reviewer can follow it. */
export type GitChangedFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  additions: number;
  deletions: number;
};

/** What to diff. `local` compares the working tree (staged + unstaged) against HEAD. */
export type GitDiffRequest = {
  root: string;
  /** Left-hand side. Omitted in local mode. */
  base?: string;
  /** Right-hand side. Omitted in local mode (the working tree). */
  head?: string;
  /**
   * Include untracked files. Defaults to true in local mode and false otherwise — an
   * incremental local diff (`base` set, working tree on the right) still has to see the
   * brand-new file a previous review never looked at (TASKS:Y7.1).
   */
  includeUntracked?: boolean;
};

/**
 * A diff, whole. `patch` is the complete unified diff — it is banked to the run store and
 * read back on demand, never trimmed to fit a prompt (PLAN.md section 2.3).
 */
export type GitDiff = {
  base?: string;
  head?: string;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  patch: string;
  /** True when the working tree holds no change at all. */
  empty: boolean;
};

/** Sandbox for the read-only fs toolset: every path must resolve inside `root`. */
export type FsToolConfig = {
  root: string;
  /** Bytes returned by one `read_file` call before it pages. Default 64 KiB. */
  maxBytes?: number;
  /** Entries returned by one `list_files` call. Default 500. */
  maxEntries?: number;
};

/* ------------------------------------------------------------------- checks */

/**
 * Which declared checks this change is not allowed to run (TASKS:Y5.2).
 *
 * A check is a command Yama executes on the reviewer's behalf, so the change under review
 * must not be able to choose it. The commands come from the BASE branch's `checks.yaml`,
 * and anything the head modified is refused: a pull request that edits `checks.yaml` or a
 * script it names has just tried to rewrite the reviewer's instructions.
 */
export type ChecksGuard = {
  /** Set when the whole file is untrusted — every check is refused with this reason. */
  allBlocked?: string;
  /** check id → why that one check is refused. */
  blocked: Record<string, string>;
};

/** What `run_check` hands back: where the evidence is banked, never the output inline. */
export type CheckRunResult = {
  checkId: string;
  taskId: string;
  state: string;
  exitCode?: number;
  /** Whether a non-zero exit gates anything, or is only evidence. */
  optional: boolean;
  /** Bounded tail. The full streams are banked — page them with command_output. */
  tailPreview: string;
  /** Verbatim call that reads the whole stdout back. */
  stdout?: string;
  stderr?: string;
};
