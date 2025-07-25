/**
 * Global test setup for Yama test suite
 */

// Global test timeout
jest.setTimeout(30000);

// Suppress console.log during tests unless explicitly needed
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  // Suppress logs unless running with DEBUG=true
  if (!process.env.DEBUG) {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
  }
});

afterEach(() => {
  // Restore console methods
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;

  // Clear all mocks
  jest.clearAllMocks();
});

// Global test utilities
(globalThis as any).testUtils = {
  // Helper to create mock PR data
  createMockPR: (overrides = {}) => ({
    id: 12345,
    title: "Test PR",
    description: "Test description",
    author: "test-user",
    state: "OPEN",
    sourceRef: "feature/test",
    targetRef: "main",
    createdDate: "2024-01-01T00:00:00Z",
    updatedDate: "2024-01-01T00:00:00Z",
    reviewers: [],
    fileChanges: [],
    ...overrides,
  }),

  // Helper to create mock diff data
  createMockDiff: (overrides = {}) => ({
    diff: "diff --git a/test.js b/test.js\n+added line\n-removed line",
    fileChanges: ["test.js"],
    totalAdditions: 1,
    totalDeletions: 1,
    ...overrides,
  }),

  // Helper to create mock MCP response
  createMockMCPResponse: (
    data: any,
    format: "direct" | "content" = "content",
  ) => {
    if (format === "direct") {
      return data;
    }
    return {
      content: [
        {
          text: JSON.stringify(data),
        },
      ],
    };
  },

  // Helper to wait for async operations
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
