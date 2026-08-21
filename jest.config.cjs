/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/*.(test|spec).+(ts|tsx|js)"],
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: { skipLibCheck: true } }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    // Entry points are exercised end to end, not unit tested.
    "!src/v4/cli/cli.ts",
    "!src/v4/index.ts",
    "!src/v4/types/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov"],
  // ESM-style ".js" specifiers resolve to their TypeScript sources under ts-jest.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  // A junit report when YAMA_JUNIT is set, so `.yama/checks.yaml` can parse the
  // suite. Resolved by path rather than by name: pnpm's strict node_modules does
  // not expose transitive bare names to jest's reporter loader.
  reporters: process.env.YAMA_JUNIT
    ? [
        "default",
        [require.resolve("jest-junit"), { outputName: process.env.YAMA_JUNIT }],
      ]
    : ["default"],
  testTimeout: 20000,
  clearMocks: true,
  restoreMocks: true,
};
