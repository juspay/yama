// Mock for @juspay/neurolink
export class NeuroLink {
  private customTools = new Map<string, any>();
  private toolContext: Record<string, unknown> | null = null;

  constructor() {}

  registerTool(name: string, tool: any): void {
    this.customTools.set(name, tool);
  }

  setToolContext(context: Record<string, unknown>): void {
    this.toolContext = context;
  }

  getCustomTools(): Map<string, any> {
    return this.customTools;
  }

  async addExternalMCPServer(): Promise<void> {}

  async listMCPServers(): Promise<any[]> {
    return [];
  }

  async getMCPStatus(): Promise<any> {
    return { totalServers: 0, totalTools: 0 };
  }

  getExternalMCPTools(): any[] {
    return [];
  }

  getExternalMCPServerTools(): any[] {
    return [];
  }

  async removeExternalMCPServer(): Promise<void> {}

  async generate(options: any): Promise<any> {
    // Mock AI response for testing
    return {
      content: JSON.stringify({
        violations: [
          {
            type: "inline",
            file: "src/test.js",
            code_snippet: '+ const password = "hardcoded123"',
            severity: "CRITICAL",
            category: "security",
            issue: "Hardcoded password detected",
            message: "Hardcoded credentials pose a security risk",
            impact: "Potential security breach",
            suggestion: "const password = process.env.PASSWORD",
          },
        ],
        summary: "Found 1 security issue",
        positiveObservations: ["Good code structure"],
        statistics: {
          filesReviewed: 1,
          totalIssues: 1,
          criticalCount: 1,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0,
        },
      }),
      provider: "mock",
      responseTime: 100,
      analytics: {
        provider: "mock",
        responseTime: 100,
      },
      toolContext: this.toolContext,
    };
  }
}

export default NeuroLink;
