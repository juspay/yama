/**
 * The git write path (TASKS:Y7.2) — the ONLY place in Yama that ever changes a repository,
 * and the only one that can do real damage. Everything here is a refusal looking for a
 * reason not to fire.
 *
 * The hygiene, as contract rather than advice:
 *
 *   1. **Only `.yama/` is ever staged.** Paths are staged explicitly, by name, and the
 *      staged set is then READ BACK out of git and checked. A learn run that finds anything
 *      else staged — a half-finished edit in the CI checkout, a hook that added something —
 *      refuses rather than committing someone else's work under Yama's name.
 *   2. **No credential is ever written anywhere.** Not into a config file, not into a
 *      remote URL, not into a command line. Credentials reach git the way git expects them
 *      to, from the ambient environment; a remote URL that already carries `user:token@` is
 *      a refusal, because pushing to it would put the secret in this process's argv and in
 *      every log that captures it.
 *   3. **Never a force push.** `git push <remote> HEAD:<branch>`, and nothing else. A
 *      rejected push stays rejected — a knowledge commit is never worth rewriting history.
 *   4. **`[skip ci]` in the subject, and the loop is checked as well.** A learn commit that
 *      re-triggers CI would re-trigger learn. The token stops the build; the check against
 *      the last commit stops a repeat even where the token is ignored.
 *
 * The plan is built first and executed second, so `--dry-run` is the same code with the
 * writes left out — a test can assert exactly what would have happened.
 */
import { relative, resolve, sep } from "node:path";
import type {
  GitWritePlan,
  GitWriteResult,
  MemoryFile,
} from "../types/index.js";
import { writeTextFile } from "../util/fs.js";
import { git } from "./git.js";

/** Everything a learn commit may touch. Anything else staged is a refusal. */
export const WRITABLE_PREFIX = ".yama/";

/** Userinfo in a remote URL — `https://user:token@host/...`. */
const CREDENTIALS_IN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i;

/** Repo-relative, POSIX-separated. The form git speaks and the plan records. */
export const repoRelative = (root: string, file: string): string =>
  relative(resolve(root), resolve(file)).split(sep).join("/");

/** True when a repo-relative path is inside the one directory learn may write. */
export const isWritablePath = (path: string): boolean =>
  path.startsWith(WRITABLE_PREFIX) && !path.split("/").includes("..");

/**
 * The remote's URL, and a refusal when it carries a credential.
 *
 * Yama does not fix this for you and does not strip it: a URL with a token in it is
 * already in `.git/config` on disk, and quietly working around that would hide it.
 */
export const checkRemote = async (
  root: string,
  remote: string,
): Promise<string | undefined> => {
  const result = await git(root, ["remote", "get-url", remote]);
  if (result.exitCode !== 0) {
    return `remote "${remote}" is not configured in this repository — set learn.remote in .yama/yama.yaml, or add the remote`;
  }
  return CREDENTIALS_IN_URL.test(result.stdout.trim())
    ? `remote "${remote}" has credentials embedded in its URL. Yama will not push through it: the secret would end up in this process's argv and in the logs. Use a credential helper, an askpass program, or a token in the environment, and set the remote to a plain URL.`
    : undefined;
};

/** The branch HEAD is on, or undefined on a detached HEAD (CI checks pull requests out). */
export const currentBranch = async (
  root: string,
): Promise<string | undefined> => {
  const result = await git(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  const name = result.stdout.trim();
  return result.exitCode === 0 && name.length > 0 ? name : undefined;
};

/** Subject of the most recent commit — the loop check reads it. */
export const headSubject = async (root: string): Promise<string> =>
  (await git(root, ["log", "-1", "--format=%s"])).stdout.trim();

/**
 * The commit a learn run would make. Nothing is written, staged or run by this function —
 * it only reads git and decides.
 *
 * `refusals` non-empty means the write must not proceed. Each one names what to do.
 */
export const planMemoryCommit = async (options: {
  root: string;
  files: readonly MemoryFile[];
  pr: number;
  summary: string;
  branch?: string;
  remote?: string;
  commitPrefix?: string;
  skipCiToken?: string;
  push?: boolean;
}): Promise<GitWritePlan> => {
  const remote = options.remote ?? "origin";
  const push = options.push ?? false;
  const skipCi = options.skipCiToken ?? "[skip ci]";
  const paths = options.files.map((file) =>
    repoRelative(options.root, file.path),
  );
  const refusals: string[] = [];

  const outside = paths.filter((path) => !isWritablePath(path));
  if (outside.length > 0) {
    refusals.push(
      `learn may only write under ${WRITABLE_PREFIX}, and this plan touches ${outside.join(", ")}`,
    );
  }
  if (paths.length === 0) {
    refusals.push(
      "there is nothing to commit — the run produced no memory files",
    );
  }

  const branch = options.branch ?? (await currentBranch(options.root));
  if (branch === undefined) {
    refusals.push(
      "HEAD is detached, so there is no branch to commit knowledge to. CI usually checks a pull request out detached — set learn.branch in .yama/yama.yaml to the branch the merge landed on.",
    );
  }

  const subject = `${options.commitPrefix ?? "chore(yama): "}learn from #${options.pr} ${skipCi}`;
  // Loop prevention: a learn commit that produced another learn commit is a loop, whatever
  // the CI system made of the skip token.
  if ((await headSubject(options.root)) === subject) {
    refusals.push(
      `the last commit on this branch is already this exact learn commit — nothing new was learned from #${options.pr}`,
    );
  }

  if (push) {
    const remoteProblem = await checkRemote(options.root, remote);
    if (remoteProblem !== undefined) {
      refusals.push(remoteProblem);
    }
  }

  return {
    root: options.root,
    branch: branch ?? "(detached)",
    remote,
    paths,
    subject,
    body: [
      options.summary,
      "",
      `Learned from pull request #${options.pr} by \`yama learn\`.`,
      "Only .yama/memory/ is touched. Edit or delete a fact file if it is wrong.",
    ].join("\n"),
    push,
    refusals,
  };
};

/** Repo-relative paths git reports as staged, whatever their spelling on disk. */
const stagedPaths = async (root: string): Promise<string[]> => {
  const result = await git(root, ["diff", "--cached", "--name-only", "-z"]);
  return result.stdout.split("\0").filter((path) => path !== "");
};

/**
 * Executes the plan: write the files, stage exactly them, prove that is all that is
 * staged, commit, and push without force.
 *
 * `dryRun` stops before the first write and returns the plan — the same decisions, none of
 * the consequences.
 */
export const commitMemory = async (options: {
  plan: GitWritePlan;
  files: readonly MemoryFile[];
  dryRun: boolean;
}): Promise<GitWriteResult> => {
  const { plan } = options;
  const base = { plan, dryRun: options.dryRun, written: [], pushed: false };

  if (plan.refusals.length > 0) {
    return { ...base, skipped: plan.refusals.join("\n") };
  }
  if (options.dryRun) {
    return {
      ...base,
      skipped: "--dry-run: nothing was written, committed or pushed",
    };
  }

  const written: string[] = [];
  for (const file of options.files) {
    written.push(await writeTextFile(file.path, file.content));
  }

  // `--` then the exact paths: nothing is staged by pattern, and no path can be read as
  // an option however it is spelled.
  const add = await git(plan.root, ["add", "--", ...plan.paths]);
  if (add.exitCode !== 0) {
    return {
      ...base,
      written,
      skipped: `staging the memory files failed: ${add.stderr.trim() || `git add exited ${add.exitCode}`}`,
    };
  }

  // Read the staged set back out of git rather than trusting what was asked for. Anything
  // else in there belongs to somebody else, and this commit is not the place for it.
  const staged = await stagedPaths(plan.root);
  const foreign = staged.filter((path) => !isWritablePath(path));
  if (foreign.length > 0) {
    await git(plan.root, ["reset", "--", ...plan.paths]);
    return {
      ...base,
      written,
      skipped: `refusing to commit: ${foreign.length} path(s) outside ${WRITABLE_PREFIX} are staged in this work tree (${foreign.join(", ")}). Yama will not commit changes it did not make. Commit or unstage them and run learn again.`,
    };
  }
  if (staged.length === 0) {
    // Nothing to commit is an OUTCOME, not a refusal — see GitWriteResult.
    return {
      ...base,
      written,
      nothingToCommit: true,
      skipped: "the memory files are identical to what is already committed",
    };
  }

  const commit = await git(plan.root, [
    "commit",
    "-m",
    plan.subject,
    "-m",
    plan.body,
    "--",
    ...plan.paths,
  ]);
  if (commit.exitCode !== 0) {
    return {
      ...base,
      written,
      skipped: `the commit failed: ${commit.stderr.trim() || commit.stdout.trim() || `git commit exited ${commit.exitCode}`}`,
    };
  }
  const sha = (await git(plan.root, ["rev-parse", "HEAD"])).stdout.trim();

  if (!plan.push) {
    return { ...base, written, commit: sha };
  }
  // No --force, no --force-with-lease, no refspec games. A rejected push stays rejected.
  const pushed = await git(plan.root, [
    "push",
    plan.remote,
    `HEAD:${plan.branch}`,
  ]);
  return {
    ...base,
    written,
    commit: sha,
    pushed: pushed.exitCode === 0,
    ...(pushed.exitCode === 0
      ? {}
      : {
          skipped: `committed as ${sha}, but the push was rejected: ${pushed.stderr.trim() || `git push exited ${pushed.exitCode}`}. Yama never force-pushes — pull the branch and run learn again.`,
        }),
  };
};
