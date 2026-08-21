/**
 * Filesystem sandbox.
 *
 * The agent reads the checked-out repository directly — that is the whole point
 * of the local-first design. It must not read anything else. A CI runner's home
 * directory holds credentials, and `../../../etc/passwd` is the oldest trick
 * there is.
 *
 * Resolution is done with the real path, not string prefixes: a symlink inside
 * the repo that points outside it would defeat a prefix check.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { SandboxCheck } from "../types/index.js";

/** Files that must never be read even inside the repository. */
const DENIED_PATTERNS = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])\.env(\.|$)/,
  /(^|[/\\])\.npmrc$/,
  /(^|[/\\])\.netrc$/,
  /(^|[/\\])id_(rsa|ed25519|ecdsa)$/,
];

/**
 * Resolve a path against the repository root, refusing anything outside it.
 *
 * `.git` is denied along with the rest: it holds credentials in `config` and
 * the full history of every secret ever committed, and nothing a reviewer needs
 * requires reading it directly — the git tools cover that.
 */
export function resolveInSandbox(
  requestedPath: string,
  projectRoot: string,
): SandboxCheck {
  if (requestedPath.includes("\0")) {
    return {
      allowed: false,
      reason: "Refused: the path contains a null byte.",
    };
  }

  const root = safeRealpath(resolve(projectRoot));
  const absolute = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);

  const real = safeRealpath(absolute);

  if (real !== root && !real.startsWith(root + sep)) {
    return {
      allowed: false,
      reason:
        `Refused: "${requestedPath}" resolves outside the repository. ` +
        `Only files in the checked-out repository are readable.`,
    };
  }

  const relative = real.slice(root.length);
  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(relative)) {
      return {
        allowed: false,
        reason:
          `Refused: "${requestedPath}" is in a protected location. ` +
          `Repository metadata and credential files are never readable.`,
      };
    }
  }

  return { allowed: true, absolutePath: real };
}

/**
 * Resolve symlinks where possible.
 *
 * A path that does not exist yet cannot be a symlink escape, so its literal
 * resolution is safe to use — and returning it lets the caller produce an honest
 * "no such file" instead of a confusing sandbox refusal.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // The path does not exist yet, so it cannot be a symlink escape. Returning
    // the literal resolution lets the caller report an honest ENOENT instead of
    // a confusing sandbox refusal.
    return path;
  }
}
