/**
 * Entry-point detection for the CLI.
 *
 * The npm bin shim is a SYMLINK: `node_modules/.bin/yama` points at
 * `dist/v4/cli/cli.js`, and under npx the path Node receives as
 * `process.argv[1]` ends with "yama", not "cli.js". The published v4.0.0
 * guarded its entry with a suffix check, so through the shim — exactly how the
 * GitHub Action invokes the CLI — the module loaded, matched nothing, and
 * exited 0 having done no work. `doctor --live` and `review` both became
 * silent no-ops with green checks.
 *
 * Identity, not spelling: resolve both the invoked path and this module's own
 * path through the filesystem and compare. A symlinked shim, a pnpm hard
 * link, and a direct `node dist/v4/cli/cli.js` all resolve to the same file.
 */

import { realpathSync } from "node:fs";

export function isMainEntry(
  entryPath: string | undefined,
  modulePath: string,
): boolean {
  if (entryPath === undefined) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch (error) {
    // realpath fails only when a path cannot be resolved (deleted between
    // launch and here, permission-blocked directory). Degrade to the direct-
    // invocation spelling check — and say so, because a shim that cannot be
    // resolved runs nothing and must not fail silently.
    process.stderr.write(
      `yama: could not resolve the entry path (${(error as Error).message}); ` +
        "falling back to a name check.\n",
    );
    return entryPath.endsWith("cli.js") || entryPath.endsWith("cli.ts");
  }
}
