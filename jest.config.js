/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)'
  ],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        noImplicitAny: false,
        strict: false,
        skipLibCheck: true
      }
    }],
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/cli/index.ts', // CLI entry point, tested via integration
    '!src/types/**', // Type definitions
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'html',
    'lcov'
  ],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85
    }
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testTimeout: 30000, // 30 seconds for tests that might hit real APIs
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  // Module path mapping for TypeScript aliases
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Mock ESM modules that cause issues
    '^@juspay/neurolink$': '<rootDir>/tests/__mocks__/@juspay/neurolink.ts',
    '^@nexus2520/bitbucket-mcp-server$': '<rootDir>/tests/__mocks__/@nexus2520/bitbucket-mcp-server.ts'
  },
  // Handle ESM modules
  extensionsToTreatAsEsm: ['.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(@juspay/neurolink|@nexus2520/bitbucket-mcp-server)/)'
  ]
};
