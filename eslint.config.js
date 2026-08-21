// ESLint v9 configuration for Yama
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        // Node.js globals
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",

        // Browser globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",

        // Test globals
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        vi: "readonly",
        vitest: "readonly",
      },
    },
    rules: {
      // Basic rules
      "no-unused-vars": "off", // Too many legacy unused vars in JS files
      "no-console": "off",
      "no-undef": "error",

      // Modern JavaScript
      "prefer-const": "warn",
      "no-var": "error",

      // Code quality
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],

      // Style (handled by Prettier)
      indent: "off",
      quotes: "off",
      semi: "off",
    },
  },
  {
    // TypeScript files in src/ directory (use project-based linting)
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Disable base rules that are covered by TypeScript
      "no-unused-vars": "off",
      "no-undef": "off",

      // TypeScript-specific rules
      // Re-enabled so dead code cannot silently re-accumulate. Underscore-
      // prefixed names are treated as intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn", // Warn about any types but don't block build
      "@typescript-eslint/prefer-as-const": "warn",
      // Repo convention (mirrors @juspay/neurolink): zero `interface`, always
      // `type X = { ... }`; use intersection (&) instead of extends.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Basic rules
      "no-console": "off",

      // Modern JavaScript
      "prefer-const": "warn",
      "no-var": "error",

      // Code quality
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],

      // Style (handled by Prettier)
      indent: "off",
      quotes: "off",
      semi: "off",
    },
  },
  {
    // TypeScript files in test/ directory
    files: ["tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        // Node.js globals
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",

        // Browser globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",

        // Test globals
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        vi: "readonly",
        vitest: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Disable base rules that are covered by TypeScript
      "no-unused-vars": "off",
      "no-undef": "off",

      // TypeScript-specific rules (less strict for test files)
      "@typescript-eslint/no-unused-vars": "off", // Test files often have unused vars
      "@typescript-eslint/no-explicit-any": "off", // Allow any types in test files
      "@typescript-eslint/prefer-as-const": "warn",
      // Repo convention, and it is repo-wide: zero `interface`, always
      // `type X = { ... }`. Tests declare fixture and port shapes constantly, so
      // leaving them out of this rule is how `interface` creeps back in.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],

      // Basic rules
      "no-console": "off",

      // Modern JavaScript
      "prefer-const": "warn",
      "no-var": "error",

      // Code quality
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],

      // Style (handled by Prettier)
      indent: "off",
      quotes: "off",
      semi: "off",
    },
  },
  {
    // Ignore patterns
    ignores: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      ".git/**",
      ".git_disabled/**",
      "scripts/**",
      "*.config.js",
      "*.config.ts",
      ".changeset/**",
      "*.log",
      "test-output.txt",
      "debug-output.txt",
      "package-lock.json",
      "pnpm-lock.yaml",
      "*.tgz",
      "*.d.ts",
      "src/v4/cli/**/*.d.ts",
    ],
  },
];
