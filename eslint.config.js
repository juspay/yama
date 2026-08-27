/**
 * ESLint flat config for Yama (TASKS 0.3).
 *
 * Yama adopts NeuroLink's code rulings (its CLAUDE.md "Critical Rules"),
 * retargeted from `src/lib/types/` onto Yama's `src/types/`. Each ruling is
 * enforced exactly once — by an official rule where one exists, otherwise by a
 * custom rule in ./eslint-rules/ or an AST selector below, never by two of them:
 *
 *   Rule 7   zero `interface`, intersection over `extends`
 *              → @typescript-eslint/consistent-type-definitions (official + autofixable)
 *   Rule 8   no "Types"/"Type" suffix in src/types/ filenames  → yama/no-types-suffix-filename
 *   Rule 9   exported type names unique across src/types/      → yama/unique-type-names
 *   Rule 10  the barrel uses `export *` only                   → selectors, src/types/index.ts block
 *   Rule 11  no types/ folder or types.ts outside src/types/   → yama/no-local-types-folder
 *   Rule 12  no type definitions/re-exports outside src/types/ → yama/no-type-export-outside-types
 *   Rule 13  internal types imported from the barrel only      → yama/barrel-type-imports
 *   Rule 14  no double type assertions (`as unknown as T`)     → selectors, src block
 *
 * Plus one Yama-specific ruling with the same shape as NeuroLink's "ai" seam:
 *   TASKS 0.4  only src/engine/ may import @juspay/neurolink
 *              → no-restricted-imports + an ImportExpression selector
 *
 * No type-aware linting: nothing enabled here needs type information, and
 * skipping `parserOptions.project` keeps test/ and this config file lintable
 * without a second tsconfig. Add `projectService: true` to the src block when a
 * type-aware rule earns its keep.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import yama from "./eslint-rules/index.js";

const ENGINE_PACKAGE = "@juspay/neurolink";

const ENGINE_SEAM_MESSAGE =
  `Only src/engine/ may import ${ENGINE_PACKAGE} (TASKS 0.4). Every other module ` +
  `talks to the engine through the seam, so engine primitives can be swapped ` +
  `without touching product code.`;

/**
 * Critical Rule 14 — `x as unknown as T` / `x as any as T`.
 * A double assertion defeats the compiler's structural-overlap check entirely:
 * the value is trusted as T with zero validation. Fix the type at the source,
 * narrow with a runtime-validating type guard, or use a single (still checked)
 * `as T`. @typescript-eslint/no-unsafe-type-assertion is the stricter official
 * alternative, but it bans every narrowing assertion — so the precise pattern
 * is banned by selector instead. Covers `as` and angle-bracket forms.
 */
const NO_DOUBLE_ASSERTION = [
  {
    selector:
      ":matches(TSAsExpression, TSTypeAssertion):matches([expression.type='TSAsExpression'], [expression.type='TSTypeAssertion'])[expression.typeAnnotation.type='TSUnknownKeyword']",
    message:
      "Unsafe double type assertion (`… as unknown as T`) defeats all compiler checking. Fix the type at the source, use a runtime-validating type guard, or a single `as T`.",
  },
  {
    selector:
      ":matches(TSAsExpression, TSTypeAssertion):matches([expression.type='TSAsExpression'], [expression.type='TSTypeAssertion'])[expression.typeAnnotation.type='TSAnyKeyword']",
    message:
      "Unsafe double type assertion (`… as any as T`) defeats all compiler checking. Fix the type at the source, use a runtime-validating type guard, or a single `as T`.",
  },
];

/**
 * TASKS 0.4 — `no-restricted-imports` does not see dynamic `import("…")`,
 * so the engine seam needs a selector too (NeuroLink hit the same gap with
 * lazy imports of "ai").
 */
const NO_ENGINE_DYNAMIC_IMPORT = [
  {
    selector: "ImportExpression[source.value=/^@juspay\\/neurolink(\\/|$)/]",
    message: `Dynamic import of ${ENGINE_PACKAGE} is restricted. ${ENGINE_SEAM_MESSAGE}`,
  },
];

/**
 * Critical Rule 10 — src/types/index.ts contains `export * from "./file.js"`
 * lines and nothing else: no selective or aliased re-exports, no local
 * definitions. `export *` is what makes the barrel complete by construction;
 * a selective export silently drops types from it.
 */
const TYPES_BARREL_PURITY = [
  {
    selector: "ExportNamedDeclaration",
    message:
      'The types barrel must use `export * from "./file.js"` only — no selective (`export type { X }`) or aliased (`X as Y`) re-exports. On a name collision, rename at the source with a domain prefix.',
  },
  {
    selector:
      ":matches(TSTypeAliasDeclaration, TSInterfaceDeclaration, TSEnumDeclaration)",
    message:
      "The types barrel must not define types locally. Put the type in a file under src/types/ and `export *` it.",
  },
];

const TS_RULES = {
  // Rule 7 — zero `interface`; `type` with intersection instead of `extends`.
  // The official rule autofixes both halves of the ruling. Its one gap versus
  // NeuroLink's custom rule is `declare global { interface Window {…} }`, which
  // TypeScript requires for declaration merging — Yama is Node-only and has
  // none; if one ever appears it takes a single eslint-disable comment.
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],

  // Base rules TypeScript already covers.
  "no-unused-vars": "off",
  "no-undef": "off",

  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/prefer-as-const": "error",
  "@typescript-eslint/no-non-null-assertion": "warn",

  "no-eval": "error",
  "no-implied-eval": "error",
  "prefer-const": "error",
  "no-var": "error",
  eqeqeq: ["error", "always"],
  curly: ["error", "all"],

  // Style belongs to Prettier.
  indent: "off",
  quotes: "off",
  semi: "off",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".yama/**",
      // Fixture repos are review INPUT for Yama's own e2e suites — they hold
      // deliberately bad code and must not be linted (TASKS Y8.1).
      "test/fixtures/**",
      // The repository's own CommonJS build/validation scripts. CI and the git
      // hooks run them; this config has never parsed them, and they are checked
      // by being run, not by being linted.
      "scripts/**",
      "**/*.d.ts",
      "*.tsbuildinfo",
    ],
  },

  js.configs.recommended,

  {
    // This config, the custom rules, and any other plain-JS tooling.
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
    },
  },

  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    plugins: { yama },
    rules: {
      ...TS_RULES,

      "yama/no-types-suffix-filename": "error", // Rule 8
      "yama/unique-type-names": "error", // Rule 9
      "yama/no-local-types-folder": "error", // Rule 11 & 11b
      "yama/no-type-export-outside-types": "error", // Rule 12
      "yama/barrel-type-imports": "error", // Rule 13

      // TASKS 0.4 — engine seam (static imports; dynamic ones by selector).
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: ENGINE_PACKAGE, message: ENGINE_SEAM_MESSAGE }],
          patterns: [
            { group: [`${ENGINE_PACKAGE}/*`], message: ENGINE_SEAM_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...NO_DOUBLE_ASSERTION,
        ...NO_ENGINE_DYNAMIC_IMPORT,
      ],

      // Yama is a CLI: stdout is a product surface, but only from src/cli/.
      "no-console": ["error", { allow: ["warn", "error", "info"] }],

      // Greenfield code-quality gates. NeuroLink's equivalents are looser only
      // because they accommodate legacy call sites.
      "max-depth": ["error", 4],
      "max-params": ["error", 5],
      "max-lines-per-function": ["warn", 120],
    },
  },

  {
    // Rule 10 — the barrel. Its `no-restricted-syntax` replaces the src block's
    // array wholesale, so the shared selectors are re-spread here.
    files: ["src/types/index.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...NO_DOUBLE_ASSERTION,
        ...NO_ENGINE_DYNAMIC_IMPORT,
        ...TYPES_BARREL_PURITY,
      ],
    },
  },

  {
    // TASKS 0.4 — the seam itself is the one place the engine may be imported.
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": ["error", ...NO_DOUBLE_ASSERTION],
    },
  },

  {
    // The CLI writes to stdout for a living.
    files: ["src/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },

  {
    // Suites drive the built CLI (NeuroLink rule 15), so the import-discipline
    // and type-location rulings that shape src/ do not apply — except the two
    // that are about hygiene anywhere: no `interface`, no stray types folder.
    // Rule 14 exempts tests, as it does in NeuroLink.
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    plugins: { yama },
    rules: {
      ...TS_RULES,
      "yama/no-local-types-folder": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
    },
  },
);
