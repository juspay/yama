/**
 * Read-only git plumbing (TASKS:Y3.2, PLAN.md section 3).
 *
 * Every call is argv, never a shell string. The diff is acquired WHOLE — the full unified
 * patch is banked to the run store and read back on demand, so no prompt budget ever
 * decides which hunks the reviewer gets to see.
 *
 * Local mode means "everything HEAD does not have yet": tracked changes (staged and
 * unstaged) plus untracked files, which is where a brand-new module hides.
 */
import type {
  GitChangedFile,
  GitDiff,
  GitDiffRequest,
} from "../types/index.js";
import { runArgv } from "../util/proc.js";

/** git's empty tree. Diffing against it is how a repo with no commits still has a diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const STATUS_LETTERS: Record<string, GitChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
};

/** Runs one git command in `root`. A non-zero exit is returned, not thrown. */
export const git = (
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  runArgv("git", args, { cwd: root, ...(signal ? { signal } : {}) });

/** True when `root` is inside a git work tree. */
export const isGitRepo = async (root: string): Promise<boolean> =>
  (await git(root, ["rev-parse", "--is-inside-work-tree"])).exitCode === 0;

/** Current commit, or undefined in a repository with no commits yet. */
export const gitHeadSha = async (root: string): Promise<string | undefined> => {
  const result = await git(root, ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
};

/** Contents of one path at one ref, or `undefined` when that ref has no such file. */
export const gitShowFile = async (
  root: string,
  ref: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const result = await git(root, ["show", `${ref}:${path}`], signal);
  return result.exitCode === 0 ? result.stdout : undefined;
};

/** Where two refs diverged — the commit a pull request is actually adding to. */
export const gitMergeBase = async (
  root: string,
  left: string,
  right: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const result = await git(root, ["merge-base", left, right], signal);
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
};

/** True when `ref` resolves in this repository. */
export const gitHasRef = async (
  root: string,
  ref: string,
  signal?: AbortSignal,
): Promise<boolean> =>
  (
    await git(
      root,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      signal,
    )
  ).exitCode === 0;

/** Refs a repository's default branch is usually called, in preference order. */
const DEFAULT_BRANCH_CANDIDATES = [
  "origin/main",
  "origin/master",
  "main",
  "master",
] as const;

/**
 * The repository's default branch, from `origin/HEAD` where the remote publishes it and
 * from the usual names where it does not. `undefined` means the caller must be told to
 * name the base itself rather than have one guessed for it.
 */
export const gitDefaultBranch = async (
  root: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  const symbolic = await git(
    root,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    signal,
  );
  if (symbolic.exitCode === 0) {
    return symbolic.stdout.trim().replace(/^refs\/remotes\//, "");
  }
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    if (await gitHasRef(root, candidate, signal)) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * The two ends of a branch or pull-request diff (TASKS:Y3.2, Y5.4).
 *
 * Yama takes the diff from GIT, not from the platform: it is deterministic, it costs no
 * API call, and it works the same on every forge. The platform is asked for comments and
 * the verdict, and for nothing else. `base` may be named explicitly — CI knows it — and is
 * otherwise resolved from the default branch; the merge base is what makes the diff "what
 * this change adds" rather than "everything that happened on main meanwhile".
 */
export const resolveDiffRange = async (options: {
  root: string;
  head: string;
  base?: string;
  signal?: AbortSignal;
}): Promise<{ base: string; head: string }> => {
  const { root, head, signal } = options;
  const base = options.base ?? (await gitDefaultBranch(root, signal));
  if (base === undefined) {
    throw new Error(
      `cannot work out what to diff "${head}" against: this repository has no origin/HEAD and no main or master branch. Pass --base <ref> to name the branch the change is going into.`,
    );
  }
  if (!(await gitHasRef(root, base, signal))) {
    throw new Error(
      `base ref "${base}" does not resolve in ${root}. Fetch it first (CI often needs fetch-depth: 0), or pass --base <ref> with one that does.`,
    );
  }
  if (!(await gitHasRef(root, head, signal))) {
    throw new Error(
      `head ref "${head}" does not resolve in ${root}. Check the branch name, or check the change out first.`,
    );
  }
  return {
    base: (await gitMergeBase(root, base, head, signal)) ?? base,
    head,
  };
};

/** NUL-separated fields, with the trailing empty token dropped. */
const zSplit = (text: string): string[] =>
  text.split("\0").filter((token) => token !== "");

/**
 * `--name-status -z`: a status token, then one path — or two for a rename/copy. Statuses
 * and `--numstat` come from the same diff invocation, so the two lists align by index.
 */
const parseNameStatus = (text: string): GitChangedFile[] => {
  const tokens = zSplit(text);
  const files: GitChangedFile[] = [];
  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index];
    const letter = code.slice(0, 1);
    const paired = letter === "R" || letter === "C";
    const first = tokens[index + 1] ?? "";
    const second = paired ? (tokens[index + 2] ?? "") : undefined;
    files.push({
      path: second ?? first,
      ...(second !== undefined ? { previousPath: first } : {}),
      status: STATUS_LETTERS[letter] ?? "unknown",
      additions: 0,
      deletions: 0,
    });
    index += paired ? 3 : 2;
  }
  return files;
};

/** `--numstat -z`: `adds TAB dels TAB` then the same path fields as `--name-status`. */
const applyNumstat = (files: GitChangedFile[], text: string): void => {
  const tokens = zSplit(text);
  let index = 0;
  let position = 0;
  while (index < tokens.length && position < files.length) {
    const [adds, dels] = tokens[index].split("\t");
    const file = files[position];
    file.additions = Number.parseInt(adds, 10) || 0;
    file.deletions = Number.parseInt(dels, 10) || 0;
    index += file.previousPath === undefined ? 2 : 3;
    position += 1;
  }
};

/** Untracked files, which no `git diff` against HEAD would ever mention. */
const untrackedFiles = async (
  root: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const result = await git(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    signal,
  );
  return result.exitCode === 0 ? zSplit(result.stdout) : [];
};

/** A patch for one untracked file: `--no-index` against /dev/null. Exit 1 means "differs". */
const untrackedPatch = async (
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ patch: string; additions: number }> => {
  const result = await git(
    root,
    ["diff", "--no-index", "--no-color", "--", "/dev/null", path],
    signal,
  );
  const patch = result.stdout;
  const additions = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  return { patch, additions };
};

/** The diff arguments for one request: a range when given, the working tree otherwise. */
const rangeArgs = (
  base: string | undefined,
  head: string | undefined,
): string[] => {
  if (base === undefined) {
    return [head ?? "HEAD"];
  }
  return head === undefined ? [base] : [base, head];
};

/**
 * Acquires a diff, whole. In local mode (`base` omitted, no `head`) this is the working
 * tree against HEAD plus every untracked file; `includeUntracked` overrides that default,
 * which is what makes an incremental local diff (TASKS:Y7.1) see new files too.
 */
export const acquireDiff = async (
  req: GitDiffRequest,
  signal?: AbortSignal,
): Promise<GitDiff> => {
  const local = req.base === undefined && req.head === undefined;
  const head = local ? ((await gitHeadSha(req.root)) ?? EMPTY_TREE) : req.head;
  const range = rangeArgs(req.base, local ? head : req.head);
  const untracked = req.includeUntracked ?? local;

  const common = ["diff", "-M", "--no-color", ...range];
  const [status, numstat, patch] = await Promise.all([
    git(req.root, [...common, "--name-status", "-z"], signal),
    git(req.root, [...common, "--numstat", "-z"], signal),
    git(req.root, common, signal),
  ]);
  if (status.exitCode !== 0) {
    throw new Error(
      `git diff failed in ${req.root}: ${status.stderr.trim() || `exit ${status.exitCode}`}`,
    );
  }

  const files = parseNameStatus(status.stdout);
  applyNumstat(files, numstat.stdout);
  let patches = patch.stdout;

  if (untracked) {
    for (const path of await untrackedFiles(req.root, signal)) {
      const extra = await untrackedPatch(req.root, path, signal);
      files.push({
        path,
        status: "added",
        additions: extra.additions,
        deletions: 0,
      });
      patches += extra.patch;
    }
  }

  return {
    ...(req.base !== undefined ? { base: req.base } : {}),
    ...(head !== undefined ? { head } : {}),
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    patch: patches,
    empty: files.length === 0,
  };
};

/** One line per file — the bounded view a prompt gets; the patch itself stays banked. */
export const summarizeDiff = (diff: GitDiff): string =>
  diff.files
    .map(
      (file) =>
        `${file.status.padEnd(8)} +${file.additions} -${file.deletions}  ${
          file.previousPath ? `${file.previousPath} -> ` : ""
        }${file.path}`,
    )
    .join("\n");
