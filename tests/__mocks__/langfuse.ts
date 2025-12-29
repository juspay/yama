/**
 * Mock for langfuse module
 * Used in tests to avoid dynamic import issues with Jest
 */

export class Langfuse {
  constructor(_config: Record<string, unknown>) {
    // Mock constructor
  }

  async getPrompt(
    _name: string,
    _version?: number,
    _options?: Record<string, unknown>,
  ): Promise<{ prompt: string }> {
    // Return empty prompt - tests should use fallback behavior
    throw new Error("Mock: Langfuse not configured");
  }

  async shutdownAsync(): Promise<void> {
    // Mock shutdown
  }
}

export default Langfuse;
