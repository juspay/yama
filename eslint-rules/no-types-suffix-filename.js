/**
 * No "Types"/"Type" suffix in filenames under `src/types/`.
 * (NeuroLink CLAUDE.md Critical Rule 8, retargeted from src/lib/types/.)
 *
 * The folder IS the types folder — the suffix is redundant:
 *   src/types/run.ts        ✓
 *   src/types/runTypes.ts   ✗
 *   src/types/runType.ts    ✗
 *   src/types/index.ts      ✓  (canonical barrel name)
 *
 * ESLint visits every file, so the union of per-file checks equals a
 * filesystem-wide check. Reported once per file from a `Program` listener.
 */

import { isOutsideProject, relPath, TYPES_DIR } from "./paths.js";

function badBasename(rel) {
  if (isOutsideProject(rel)) {
    return null;
  }
  // Top-level files of the types folder only, mirroring NeuroLink's rule.
  const m = new RegExp(`^${TYPES_DIR}/([^/]+)\\.tsx?$`).exec(rel);
  if (!m) {
    return null;
  }
  const basename = m[1];
  if (basename === "index") {
    return null;
  }
  return /Types?$/.test(basename) ? basename : null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: `Type filenames inside ${TYPES_DIR}/ must not carry a redundant "Types"/"Type" suffix.`,
    },
    schema: [],
    messages: {
      badSuffix: `File "{{name}}.ts" has a redundant suffix — ${TYPES_DIR}/ IS the types folder. Rename it to drop the "Types"/"Type" suffix.`,
    },
  },

  create(context) {
    const name = badBasename(relPath(context));
    if (!name) {
      return {};
    }
    return {
      Program(node) {
        context.report({ node, messageId: "badSuffix", data: { name } });
      },
    };
  },
};
