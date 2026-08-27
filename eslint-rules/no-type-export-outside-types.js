/**
 * No type definitions or type re-exports outside `src/types/`.
 * (NeuroLink CLAUDE.md Critical Rule 12, retargeted from src/lib/types/.)
 *
 * Files outside the canonical folder must not:
 *   A) re-export types      `export type { X } from "…"` / `export { type X } from "…"`
 *   B) define exported types `export type X = …`, `export interface X {}`
 *   C) export enums          `export enum X {}` (also a type boundary)
 *   D) export a local type   `type X = …; export { X }`
 *
 * A module `index.ts` re-exports runtime values only; consumers import types
 * from the barrel. A genuine exception needs an explicit
 * `// eslint-disable-next-line yama/no-type-export-outside-types -- <reason>`.
 */

import { isInsideTypesDir, relPath, TYPES_DIR } from "./paths.js";

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: `Disallow exporting types from files outside ${TYPES_DIR}/.`,
    },
    schema: [],
    messages: {
      noTypeReExport: `Type re-exports are forbidden outside ${TYPES_DIR}/. Move the definition there and let it flow through the barrel.`,
      noTypeDefinition: `Type definition \`{{name}}\` must live in ${TYPES_DIR}/, not here.`,
      noInlineTypeExport: `Export specifier \`{{name}}\` is type-only; move the type into ${TYPES_DIR}/.`,
    },
  },

  create(context) {
    if (isInsideTypesDir(relPath(context))) {
      return {};
    }

    /** `type X = …; export { X }` — a declaration-less export of a local type. */
    function reportLocalTypeSpecifiers(node) {
      const scope = context.sourceCode.getScope(node);
      for (const spec of node.specifiers) {
        const localName = spec.local?.name;
        if (!localName) {
          continue;
        }
        let variable;
        for (let s = scope; s && !variable; s = s.upper) {
          variable = s.variables.find((v) => v.name === localName);
        }
        const isTypeDef = variable?.defs.some(
          (d) =>
            d.node?.type === "TSTypeAliasDeclaration" ||
            d.node?.type === "TSInterfaceDeclaration",
        );
        if (isTypeDef) {
          context.report({
            node: spec,
            messageId: "noInlineTypeExport",
            data: { name: spec.exported?.name ?? localName },
          });
        }
      }
    }

    function reportSpecifier(spec) {
      context.report({
        node: spec,
        messageId: "noInlineTypeExport",
        data: {
          name: spec.exported?.name ?? spec.local?.name ?? "<anonymous>",
        },
      });
    }

    return {
      ExportNamedDeclaration(node) {
        // B) / C) `export type X = …`, `export interface X {}`, `export enum X {}`.
        // Checked first: these also carry `exportKind === "type"`, and naming the
        // offending declaration is a better message than "re-export".
        const declared = node.declaration;
        if (
          declared &&
          (declared.type === "TSTypeAliasDeclaration" ||
            declared.type === "TSInterfaceDeclaration" ||
            declared.type === "TSEnumDeclaration")
        ) {
          context.report({
            node: declared,
            messageId: "noTypeDefinition",
            data: { name: declared.id?.name ?? "<anonymous>" },
          });
          return;
        }

        // A) `export type { X } from "…"`, and its source-less `export type { X }` form.
        if (node.exportKind === "type") {
          if (node.source) {
            context.report({ node, messageId: "noTypeReExport" });
          } else {
            node.specifiers.forEach(reportSpecifier);
          }
          return;
        }

        // A) `export { type X, value } from "…"` — per-specifier type modifier.
        for (const spec of node.specifiers) {
          if (spec.exportKind === "type") {
            reportSpecifier(spec);
          }
        }

        // D) local type exported through a plain specifier list.
        if (!node.source && node.specifiers.length > 0) {
          reportLocalTypeSpecifiers(node);
        }
      },

      /** `export type * from "…"` — a whole-module type re-export. */
      ExportAllDeclaration(node) {
        if (node.exportKind === "type") {
          context.report({ node, messageId: "noTypeReExport" });
        }
      },
    };
  },
};
