/**
 * Types live only in `src/types/`.
 * (NeuroLink CLAUDE.md Critical Rules 11 and 11b, retargeted from src/lib/types/.)
 *
 *   11   no `types/` directory anywhere except `src/types/`
 *   11b  no file literally named `types.ts` outside `src/types/`
 *
 * Scattered types folders and ad-hoc `types.ts` files hide type definitions
 * from the barrel and are where rule-12 violations accumulate.
 *
 * Each file's own path says whether it sits in a forbidden location, and
 * ESLint visits every file — so the union of per-file checks equals a
 * filesystem-wide check.
 */

import {
  isInsideTypesDir,
  isOutsideProject,
  relPath,
  TYPES_DIR,
} from "./paths.js";

function checkPath(rel) {
  if (isOutsideProject(rel) || isInsideTypesDir(rel)) {
    return null;
  }

  const segments = rel.split("/");
  const basename = segments[segments.length - 1];

  // Rule 11b — a file named `types.ts` / `types.tsx` outside the canonical folder.
  if (/^types\.tsx?$/.test(basename)) {
    return {
      rule: "11b",
      reason: 'A file named "types.ts" outside the canonical folder',
    };
  }

  // Rule 11 — the file lives under some other `types/` directory.
  if (segments.slice(0, -1).includes("types")) {
    return {
      rule: "11",
      reason: 'A "types/" directory outside the canonical folder',
    };
  }

  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: `Types must live only in ${TYPES_DIR}/.`,
    },
    schema: [],
    messages: {
      wrongLocation: `{{reason}}. Move these types into ${TYPES_DIR}/ and import them back through the barrel (Critical Rule {{rule}}).`,
    },
  },

  create(context) {
    const result = checkPath(relPath(context));
    if (!result) {
      return {};
    }
    return {
      Program(node) {
        context.report({
          node,
          messageId: "wrongLocation",
          data: { rule: result.rule, reason: result.reason },
        });
      },
    };
  },
};
