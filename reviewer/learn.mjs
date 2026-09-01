/**
 * `yama learn` — the deterministic write path that runs AFTER the learn turn.
 *
 * The agent's half of learn (read the merged pull request, distill learnings,
 * let Hippocampus condense them into the memory database) happens in
 * index.mjs before this module is imported. What lives here is everything a
 * model must never be trusted with, ported from the v5 gitWriter contract:
 * stage exactly one path, read the staged set back out of git, never force
 * push, refuse a remote URL carrying a credential, and carry the skip-ci
 * token in the subject so the commit cannot re-trigger CI.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A remote URL with userinfo before the host: user:token@host would put the
 * secret in argv and logs. The anonymous `git` SSH user (ssh://git@host/…)
 * is not a credential and is excluded; any other userinfo — user:pass@,
 * token@, git:token@ — is refused.
 */
const CREDENTIALED_URL = /^[a-z][a-z0-9+.-]*:\/\/(?!git@)[^/@]*@/i;

/** argv arrays, never a shell — remote names and PR numbers never touch a shell string. */
const git = (dir, args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
};

const refuse = (message) => {
  console.error(`✗ ${message}`);
  return 1;
};

const notice = (message) => {
  console.log(`· ${message}`);
  return 0;
};

/**
 * Checkpoint the WAL so the .sqlite file alone is the complete database
 * (the -wal/-shm siblings stay gitignored). The caller disposed NeuroLink
 * first, so this connection is the only one and TRUNCATE empties the WAL.
 * Returns null on success, or the refusal message.
 */
async function checkpointWal(memoryDbPath) {
  const walPath = `${memoryDbPath}-wal`;
  let Database;
  try {
    ({ default: Database } = await import("better-sqlite3"));
  } catch {
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      return "better-sqlite3 is not installed but a non-empty WAL sits beside the memory database — committing now would ship an incomplete database. Install better-sqlite3 and re-run learn.";
    }
    return null; // no WAL pages → the base file is already complete
  }
  let db;
  try {
    db = new Database(memoryDbPath);
    let row;
    for (let attempt = 1; ; attempt++) {
      const result = db.pragma("wal_checkpoint(TRUNCATE)");
      row = Array.isArray(result) ? result[0] : result;
      if (!row || !row.busy || attempt >= 3) {
        break;
      }
      // A straggling reader can hold one attempt busy; give it a beat.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (row && row.busy) {
      return "the memory database is still held by another connection after 3 checkpoint attempts — re-run learn.";
    }
  } catch (error) {
    // A database that cannot even be opened must be a named refusal, never a
    // stack trace — and never a commit of a file SQLite cannot read.
    return `the memory database at ${memoryDbPath} could not be checkpointed (${error.message}) — refusing to commit a database that cannot be opened. Delete it to reset memory.`;
  } finally {
    db?.close();
  }
  return null;
}

/**
 * Stage, verify, commit and (optionally) push the memory database.
 *
 * @param {{ cwd: string, memoryDbPath: string, pr: string, learn?: {
 *   commit?: boolean, push?: boolean, remote?: string, branch?: string,
 *   commitPrefix?: string, skipCiToken?: string } }} options
 * @returns {Promise<number>} the process exit code
 */
export async function runLearn({ cwd, memoryDbPath, pr, learn = {} }) {
  const commit = learn.commit === true;
  const push = learn.push === true;
  const remote = learn.remote ?? "origin";
  const commitPrefix = learn.commitPrefix ?? "chore(yama): ";
  const skipCiToken = learn.skipCiToken ?? "[skip ci]";

  if (!existsSync(memoryDbPath)) {
    return notice(
      `no memory database at ${memoryDbPath} — nothing was written, nothing to commit`,
    );
  }
  if (!commit) {
    return notice(
      "learn.commit is not enabled in config.json — memory updated locally only",
    );
  }

  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    return refuse("not inside a git repository — learn.commit needs one");
  }
  const root = top.stdout;
  const relPath = path.relative(root, memoryDbPath).split(path.sep).join("/");
  if (relPath.startsWith("..")) {
    return refuse(
      `the memory database (${memoryDbPath}) sits outside the repository at ${root}`,
    );
  }

  if (git(root, ["check-ignore", "-q", "--", relPath]).code === 0) {
    return refuse(
      `${relPath} is gitignored — un-ignore \`memory/*.sqlite\` in your .gitignore (keep \`memory/*.sqlite-*\` ignored) so learn can commit it`,
    );
  }

  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 && learn.branch === undefined) {
    return refuse(
      "HEAD is detached — check out a branch, or set learn.branch in config.json",
    );
  }
  const pushTarget = learn.branch ?? branch.stdout;

  if (push) {
    const url = git(root, ["remote", "get-url", remote]);
    if (url.code !== 0) {
      return refuse(`remote \`${remote}\` is not configured: ${url.stderr}`);
    }
    if (CREDENTIALED_URL.test(url.stdout)) {
      return refuse(
        `the \`${remote}\` remote URL embeds a credential — pushing through it would put the secret in argv and logs. Use a credential helper or an ambient token instead.`,
      );
    }
  }

  const walError = await checkpointWal(memoryDbPath);
  if (walError !== null) {
    return refuse(walError);
  }

  const add = git(root, ["add", "--", relPath]);
  if (add.code !== 0) {
    return refuse(`could not stage ${relPath}: ${add.stderr}`);
  }

  // The staged set, read back out of git: learn commits its one path or nothing.
  const staged = git(root, ["diff", "--cached", "--name-only", "-z"]);
  if (staged.code !== 0) {
    return refuse(`could not read the staged set back: ${staged.stderr}`);
  }
  const stagedPaths = staged.stdout.split("\0").filter(Boolean);
  const foreign = stagedPaths.filter((p) => p !== relPath);
  if (foreign.length > 0) {
    git(root, ["reset", "--", relPath]);
    return refuse(
      `${foreign.length} staged path(s) learn did not stage (${foreign.join(", ")}) — refusing to commit work that is not its own. Commit or unstage them first.`,
    );
  }
  if (stagedPaths.length === 0) {
    return notice("memory is unchanged — nothing to commit");
  }

  const subject = `${commitPrefix}learn from #${pr} ${skipCiToken}`;
  const body = `Learned from pull request #${pr} by \`yama learn\`. Only ${path.posix.dirname(relPath)}/ is touched — delete the database to reset memory.`;
  const committed = git(root, [
    "commit",
    "-m",
    subject,
    "-m",
    body,
    "--",
    relPath,
  ]);
  if (committed.code !== 0) {
    return refuse(`git commit failed: ${committed.stderr || committed.stdout}`);
  }
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).stdout;

  if (!push) {
    return notice(
      `learned from #${pr} → ${sha} (committed; learn.push is off)`,
    );
  }
  const pushed = git(root, ["push", remote, `HEAD:${pushTarget}`]);
  if (pushed.code !== 0) {
    return refuse(
      `committed as ${sha} but the push was rejected: ${pushed.stderr}. yama never force-pushes — re-run learn once the branch settles.`,
    );
  }
  return notice(
    `learned from #${pr} → ${sha} (pushed to ${remote}/${pushTarget})`,
  );
}
