/**
 * Writing what was learned back to the repository.
 *
 * This is the only place Yama holds write credentials, and it is never loaded
 * during a review. Three rules, each fixing a real leak observed in an existing
 * production pipeline:
 *
 *  1. **Credentials never touch a file or a command line.** The reference
 *     implementation writes `git config url."https://$USER:$TOKEN@host/".insteadOf`,
 *     which the shell expands — putting the live token into the workspace's
 *     `.git/config`, where it survives the job and lands in any artifact that
 *     archives the checkout. Here they live in an env var the shell expands at
 *     the moment of use, or in a 0600 temp file outside the workspace that is
 *     removed in a `finally`.
 *
 *  2. **Never force-push.** The reference implementation pushes `--force` to the
 *     default branch. A concurrent merge would be silently destroyed. Here a
 *     rejection means fetch, rebase, retry — and if it still fails, fail loudly.
 *
 *  3. **Stage explicitly.** `git add .yama/**` only, and abort if anything else
 *     is staged. A learn commit that sweeps up a stray build artifact is a
 *     supply-chain problem wearing a chore commit's clothes.
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommitOptions,
  CommitResult,
  CredentialSetup,
  LearnGitConfig,
} from "../types/index.js";

export class GitWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWriteError";
  }
}

/**
 * Prepare credentials.
 *
 * SSH writes the key to a 0600 file OUTSIDE the workspace — inside it, a later
 * `git add` or an artifact upload could capture it. HTTPS uses an askpass helper
 * rather than a URL, because a URL with a token in it appears in `git remote
 * -v`, in error messages, and in every process listing on the machine.
 */
export function prepareCredentials(
  config: LearnGitConfig,
  env: NodeJS.ProcessEnv,
): CredentialSetup {
  const auth = config.auth ?? "ssh";

  if (auth === "ssh") {
    const keyEnv = config.sshKeyEnv ?? "YAMA_SSH_KEY";
    const key = env[keyEnv];
    if (!key || key.trim().length === 0) {
      throw new GitWriteError(
        `Learning cannot write: ${keyEnv} is unset or empty. Set it to the private key ` +
          `body (not a path) in your CI secret store.`,
      );
    }

    const dir = mkdtempSync(join(tmpdir(), "yama-key-"));
    const keyPath = join(dir, "id");
    writeFileSync(keyPath, key.endsWith("\n") ? key : `${key}\n`, {
      mode: 0o600,
    });
    chmodSync(keyPath, 0o600);

    return {
      env: {
        // IdentitiesOnly stops ssh from offering every agent key and being
        // rejected before it reaches this one.
        GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  const userEnv = config.userEnv ?? "YAMA_GIT_USER";
  const tokenEnv = config.tokenEnv ?? "YAMA_GIT_TOKEN";
  if (!env[tokenEnv] || env[tokenEnv]?.trim().length === 0) {
    throw new GitWriteError(
      `Learning cannot write: ${tokenEnv} is unset or empty. Set it in your CI secret store.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "yama-ask-"));
  const askpass = join(dir, "askpass.sh");
  // The helper reads the secret from the environment at call time. The value
  // never appears in this file, in a command line, or in git's configuration.
  writeFileSync(
    askpass,
    `#!/bin/sh\ncase "$1" in\n*Username*) printf '%s' "$${userEnv}" ;;\n*) printf '%s' "$${tokenEnv}" ;;\nesac\n`,
    { mode: 0o700 },
  );
  chmodSync(askpass, 0o700);

  return {
    env: { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Paths a learn commit is allowed to touch. */
const ALLOWED_PREFIX = ".yama/";

/** Reject any path outside `.yama/`. */
export function assertScopedPaths(paths: string[]): void {
  const outside = paths.filter(
    (path) => !path.replace(/^\.\//, "").startsWith(ALLOWED_PREFIX),
  );
  if (outside.length > 0) {
    throw new GitWriteError(
      `Refusing to commit paths outside ${ALLOWED_PREFIX}: ${outside.join(", ")}. ` +
        `Learning only ever writes its own knowledge files.`,
    );
  }
}

/**
 * Commit and push what was learned.
 *
 * Every git invocation goes through the runner with the credential environment,
 * so the caller cannot accidentally run one without it — or with it, after
 * cleanup.
 */
export async function commitAndPush(
  options: CommitOptions,
): Promise<CommitResult> {
  assertScopedPaths(options.paths);

  const { runner, cwd, config } = options;
  const branch = config.branch ?? "main";
  const remote = config.remote;
  if (!remote) {
    throw new GitWriteError(
      "Learning cannot write: learn.git.remote is not configured.",
    );
  }

  const credentials = prepareCredentials(config, options.env);
  const env = { ...options.env, ...credentials.env };
  const maxAttempts = Math.max(1, options.maxPushAttempts ?? 3);

  const git = async (command: string) => runner(`git ${command}`, { cwd, env });

  try {
    // Identity on the command, not in the repository's config: this process
    // must not leave configuration behind in a workspace it does not own.
    const identity =
      `-c user.name=${JSON.stringify(options.botIdentity)} ` +
      `-c user.email=${JSON.stringify(options.botEmail ?? `${options.botIdentity}@users.noreply.local`)}`;

    for (const path of options.paths) {
      await git(`add -- ${JSON.stringify(path)}`);
    }

    // Anything staged that we did not stage is not ours to commit.
    const staged = await git("diff --cached --name-only");
    const stagedPaths = staged.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (stagedPaths.length === 0) {
      return {
        committed: false,
        pushed: false,
        reason: "nothing to commit",
        attempts: 0,
      };
    }

    assertScopedPaths(stagedPaths);

    const commit = await git(
      `${identity} commit -m ${JSON.stringify(options.message)}`,
    );
    if (commit.exitCode !== 0) {
      throw new GitWriteError(
        `Commit failed: ${commit.stderr || commit.stdout}`,
      );
    }

    const sha = (await git("rev-parse HEAD")).stdout.trim();

    let attempts = 0;
    let lastError = "";
    while (attempts < maxAttempts) {
      attempts += 1;
      const push = await git(
        `push ${JSON.stringify(remote)} HEAD:refs/heads/${branch}`,
      );
      if (push.exitCode === 0) {
        return { committed: true, pushed: true, sha, attempts };
      }
      lastError = push.stderr || push.stdout;

      // A rejection here almost always means someone merged while we worked.
      // Rebase onto them and try again. Never force: their commit is real work
      // and ours is a chore commit.
      const fetch = await git(`fetch ${JSON.stringify(remote)} ${branch}`);
      if (fetch.exitCode !== 0) {
        break;
      }
      const rebase = await git("rebase FETCH_HEAD");
      if (rebase.exitCode !== 0) {
        await git("rebase --abort");
        break;
      }
    }

    throw new GitWriteError(
      `Could not push the learning commit after ${attempts} attempt(s): ${lastError}. ` +
        `Yama never force-pushes — resolve the conflict and re-run, or set ` +
        `learn.mode to 'pull-request' if the branch is protected.`,
    );
  } finally {
    credentials.cleanup();
  }
}

/**
 * The commit subject.
 *
 * `[skip ci]` is necessary but not sufficient — it is honoured inconsistently
 * across GitHub Actions, Bitbucket Pipelines and Jenkins. `yama init` also
 * writes an actor guard and a paths-ignore filter into the workflow, so the loop
 * is broken in two independent ways.
 */
export function learnCommitMessage(pullRequestId: number): string {
  return `chore(yama): learn from #${pullRequestId} [skip ci]`;
}
