import type { GitCommandCheck } from "../types/index.js";
/**
 * Read-only git access.
 *
 * The diff under review is attacker-controlled. A prompt injection that reaches
 * a shell reaches the CI job's credentials, so this allow-list is fail-closed by
 * construction: a git subcommand that is not explicitly known to be read-only is
 * treated as mutating, including subcommands that do not exist yet.
 *
 * Blocking a safe command costs one tool call. Allowing an unsafe one costs the
 * repository.
 */

/** Git subcommands that only read repository state. */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "show",
  "diff",
  "blame",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "describe",
  "merge-base",
  "cat-file",
  "shortlog",
  "name-rev",
  "status",
]);

/**
 * Flags that turn a read-only subcommand into something else.
 *
 * `git diff --output=x` writes a file; `git log --output` likewise. `-c`
 * injects arbitrary configuration, which can set `core.pager` or
 * `core.sshCommand` to a command of the caller's choosing — a shell escape
 * wearing a read-only subcommand as a disguise.
 */
const DANGEROUS_FLAGS = [
  "--output",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "-c",
  "--config-env",
  "--ext-diff",
  "--no-index",
];

/**
 * Split a command string into arguments.
 *
 * Handles quoting, and rejects shell metacharacters outright rather than trying
 * to reason about them. `git log; rm -rf /` must never parse into something
 * that looks like a safe `git log`.
 */

/**
 * The same protected-file patterns the filesystem sandbox enforces.
 *
 * Duplicated as PATTERNS rather than imported as code because the shapes the
 * two doors see differ: the sandbox tests resolved relative paths, while git
 * arguments arrive as pathspecs and `rev:path` specs. What must be identical is
 * the set of protected names, and the test below asserts the two lists agree.
 */
const DENIED_GIT_PATHS = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\:])\.env(\.|$)/,
  /(^|[/\\:])\.npmrc$/,
  /(^|[/\\:])\.netrc$/,
  /(^|[/\\:])id_(rsa|ed25519|ecdsa)$/,
];

/** Does any part of a git argument reference a protected file? */
function touchesDeniedPath(arg: string): boolean {
  // A rev:path spec ("HEAD:.env", "abc123:dir/.npmrc") hides the path after a
  // colon; check both the whole argument and the post-colon part.
  const candidates = [arg, ...arg.split(":").slice(1)];
  return candidates.some((candidate) =>
    DENIED_GIT_PATHS.some((pattern) => pattern.test(candidate)),
  );
}

export function parseGitCommand(command: string): GitCommandCheck {
  const trimmed = command.trim();

  const metacharacter = /[;&|`$(){}<>\n\\]/.exec(trimmed);
  if (metacharacter) {
    return {
      allowed: false,
      reason:
        `Refused: the command contains the shell metacharacter "${metacharacter[0]}". ` +
        `Only a single plain git command is permitted.`,
    };
  }

  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const args = tokens.map((token) =>
    /^["']/.test(token) ? token.slice(1, -1) : token,
  );

  if (args.length === 0) {
    return { allowed: false, reason: "Refused: empty command." };
  }
  if (args[0] !== "git") {
    return {
      allowed: false,
      reason: `Refused: only git is available here, not "${args[0]}".`,
    };
  }

  // A global flag before the subcommand is where `-c core.pager=…` hides.
  const rest = args.slice(1);
  const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
  if (subcommandIndex === -1) {
    return { allowed: false, reason: "Refused: no git subcommand given." };
  }
  const globalFlags = rest.slice(0, subcommandIndex);
  for (const flag of globalFlags) {
    return {
      allowed: false,
      reason:
        `Refused: the global flag "${flag}" can change git's behaviour arbitrarily. ` +
        `Call the subcommand directly.`,
    };
  }

  const subcommand = rest[subcommandIndex];
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      allowed: false,
      reason:
        `Refused: "git ${subcommand}" is not on the read-only allow-list. ` +
        `Yama never modifies the repository during a review.`,
    };
  }

  const subcommandArgs = rest.slice(subcommandIndex + 1);
  for (const arg of subcommandArgs) {
    const flag = arg.split("=")[0];
    if (DANGEROUS_FLAGS.includes(flag)) {
      return {
        allowed: false,
        reason: `Refused: "${flag}" is not permitted — it can write files or run commands.`,
      };
    }
    // The sandbox refuses read_file on credentials and git internals; git can
    // reach the same bytes through history (`git show HEAD:.env`,
    // `git log -p -- .npmrc`). The same denial applies here, on every argument
    // and on the path half of a rev:path spec, so the git door is not a bypass
    // of the filesystem door.
    if (touchesDeniedPath(arg)) {
      return {
        allowed: false,
        reason:
          `Refused: "${arg}" references a protected file. Credentials and git ` +
          `internals are not readable during a review, including from history.`,
      };
    }
  }

  return { allowed: true, subcommand, args: rest };
}

/** True when a tool name refers to a git operation that can mutate state. */
export function isMutatingGitTool(toolName: string): boolean {
  const name = (toolName.split(/[.:/]/).pop() ?? toolName).toLowerCase();
  if (!name.startsWith("git_")) {
    return false;
  }
  return (
    !READ_ONLY_GIT_SUBCOMMANDS.has(name.slice(4).replace(/_/g, "-")) &&
    !READ_ONLY_GIT_SUBCOMMANDS.has(name.slice(4))
  );
}
