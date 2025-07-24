// Mock for @juspay/neurolink
export class NeuroLink {
  constructor() {}

  async generate(options: any): Promise<any> {
    // Mock AI response for testing
    return {
      content: JSON.stringify({
        violations: [
          {
            type: 'inline',
            file: 'src/test.js',
            code_snippet: '+ const password = "hardcoded123"',
            severity: 'CRITICAL',
            category: 'security',
            issue: 'Hardcoded password detected',
            message: 'Hardcoded credentials pose a security risk',
            impact: 'Potential security breach',
            suggestion: 'const password = process.env.PASSWORD'
          }
        ],
        summary: 'Found 1 security issue',
        positiveObservations: ['Good code structure'],
        statistics: {
          filesReviewed: 1,
          totalIssues: 1,
          criticalCount: 1,
          majorCount: 0,
          minorCount: 0,
          suggestionCount: 0
        }
      }),
      provider: 'mock',
      responseTime: 100,
      analytics: {
        provider: 'mock',
        responseTime: 100
      }
    };
  }
}

export default NeuroLink;
