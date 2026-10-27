/**
 * ESLint flat config for Yama.
 *
 * The shipped reviewer (src/*.mjs) is plain ESM run directly by node; the
 * e2e harness (test/) is TypeScript run by tsx. Both are linted here.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const SHARED_RULES = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
  "no-var": "error",
  eqeqeq: ["error", "always"],
  curly: ["error", "all"],
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      // The repository's own CommonJS validation scripts. CI and the git hooks
      // run them; they are checked by being run, not by being linted.
      "scripts/**",
    ],
  },

  js.configs.recommended,

  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: SHARED_RULES,
  },

  {
    files: ["test/**/*.ts"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...SHARED_RULES,
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
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
    },
  },
);
