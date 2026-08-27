/**
 * Every exported name in `src/types/` must be globally unique across that folder.
 * (NeuroLink CLAUDE.md Critical Rule 9, retargeted from src/lib/types/.)
 *
 * The barrel re-exports every type file with `export *`, so two files declaring
 * the same name collide at the barrel. Disambiguate with a domain prefix
 * (`Run*`, `Finding*`, `Config*`, `Engine*`, …) at the declaration site.
 *
 * Cross-file check via a module-level Map. ESLint loads the plugin once per
 * process, so one `pnpm run lint` sees every file at once.
 *
 * Caveat, same as NeuroLink's: linting a SUBSET of files (lint-staged on a
 * partial diff) only compares within that subset — a duplicate is invisible
 * unless both declarations are in the same run. The full-project `eslint .`
 * that CI runs always has the complete view, which is what this rule relies on.
 */

import { isInsideTypesDir, relPath } from "./paths.js";

/** @type {Map<string, string>} exported name → repo-relative file that declared it first */
const declarations = new Map();

function register(context, node, name) {
  const rel = relPath(context);
  if (!isInsideTypesDir(rel)) {
    return;
  }
  const existing = declarations.get(name);
  if (existing !== undefined && existing !== rel) {
    context.report({
      node,
      messageId: "duplicate",
      data: { name, other: existing },
    });
    return;
  }
  declarations.set(name, rel);
}

/** Only `export`ed declarations can collide in the barrel. */
function exported(node) {
  return node.parent?.type === "ExportNamedDeclaration";
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Every exported name in src/types/ must be globally unique.",
    },
    schema: [],
    messages: {
      duplicate:
        'Type name "{{name}}" is already declared in {{other}}. `export *` in the barrel makes this a collision — add a domain prefix to disambiguate.',
    },
  },

  create(context) {
    return {
      TSTypeAliasDeclaration(node) {
        if (exported(node)) {
          register(context, node, node.id.name);
        }
      },
      TSInterfaceDeclaration(node) {
        if (exported(node)) {
          register(context, node, node.id.name);
        }
      },
      TSEnumDeclaration(node) {
        if (exported(node) && node.id?.name) {
          register(context, node, node.id.name);
        }
      },
      ClassDeclaration(node) {
        if (exported(node) && node.id?.name) {
          register(context, node, node.id.name);
        }
      },
    };
  },
};
