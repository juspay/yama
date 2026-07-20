/**
 * Single source of truth for the Yama version, read from package.json at
 * runtime. Lives in a leaf module (no barrel imports) so any file — including
 * low-level ones like SessionManager — can import VERSION without pulling in the
 * whole SDK graph (which breaks under the test runner).
 *
 * This file sits at src/v2/utils/ (and dist/v2/utils/ in the build), so the
 * relative require resolves to the repo-root package.json in dev and in the
 * published package alike. Falls back to a sentinel rather than a stale literal.
 */

import { createRequire } from "node:module";

function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return typeof pkg.version === "string" && pkg.version.length > 0
      ? pkg.version
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = resolveVersion();
