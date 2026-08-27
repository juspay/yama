/**
 * Internal types are imported from the barrel, never from a type file.
 * (NeuroLink CLAUDE.md Critical Rule 13, retargeted from src/lib/types/.)
 *
 *   import type { RunContext } from "../types/index.js"   ✓
 *   import type { RunContext } from "../types"            ✓  (resolves to the barrel)
 *   import type { RunContext } from "../types/run.js"     ✗
 *   import("../types/run.js").RunContext                  ✗
 *   export { X } from "../types/run.js"                   ✗
 *
 * External packages (`zod`, `yargs`, …) are untouched — only relative paths
 * with a `types/` segment are inspected. Files inside src/types/ are exempt;
 * they import from each other.
 */

import { isInsideTypesDir, relPath, TYPES_DIR } from "./paths.js";

/** True for a relative import that names a specific file inside a `types/` folder. */
function isDirectTypeFileImport(source) {
  if (!source.startsWith(".")) {
    return false;
  }
  const m = /\/types\/([^/]+?)(?:\.[jt]sx?)?$/.exec(source);
  return m !== null && m[1] !== "index";
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: `Require barrel imports for internal types from ${TYPES_DIR}/.`,
    },
    schema: [],
    messages: {
      useBarrel:
        "Import internal types from the barrel (`{{barrel}}`) instead of `{{source}}`.",
    },
  },

  create(context) {
    if (isInsideTypesDir(relPath(context))) {
      return {};
    }

    function check(node, source) {
      if (typeof source !== "string" || !isDirectTypeFileImport(source)) {
        return;
      }
      context.report({
        node,
        messageId: "useBarrel",
        data: {
          barrel: source.replace(/\/types\/[^/]+$/, "/types/index.js"),
          source,
        },
      });
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node.source, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        if (node.source) {
          check(node.source, node.source.value);
        }
      },
      /** `import("../types/run.js").RunContext` — dynamic type import. */
      TSImportType(node) {
        const arg = node.argument;
        if (!arg) {
          return;
        }
        if (
          arg.type === "TSLiteralType" &&
          typeof arg.literal?.value === "string"
        ) {
          check(arg, arg.literal.value);
        } else if (arg.type === "Literal" && typeof arg.value === "string") {
          check(arg, arg.value);
        }
      },
    };
  },
};
