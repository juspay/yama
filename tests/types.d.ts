// Type declarations for global test utilities
declare global {
  const testUtils: {
    createMockPR: (overrides?: any) => any;
    createMockDiff: (overrides?: any) => any;
    createMockMCPResponse: (data: any, format?: "direct" | "content") => any;
    wait: (ms: number) => Promise<void>;
  };
}

export {};
