// Mock for @nexus2520/bitbucket-mcp-server
export class BitbucketMCPServer {
  constructor(config: any) {}

  async initialize(): Promise<void> {
    // Mock initialization
  }

  async getPullRequest(params: any): Promise<any> {
    return {
      id: params.pullRequestId || 123,
      title: 'Test PR',
      description: 'Test description',
      author: { displayName: 'Test Author' },
      state: 'OPEN',
      fromRef: { displayId: 'feature/test' },
      toRef: { displayId: 'main' }
    };
  }

  async getPullRequestDiff(params: any): Promise<any> {
    return {
      diff: 'diff --git a/test.js b/test.js\n+const test = "hello";\n',
      fileChanges: ['test.js']
    };
  }

  async addComment(params: any): Promise<any> {
    return {
      id: 1,
      text: params.text,
      author: { displayName: 'Yama' }
    };
  }

  async updatePullRequest(params: any): Promise<any> {
    return {
      ...params,
      version: 2
    };
  }

  async getFileContent(params: any): Promise<any> {
    return {
      content: '# Test file content\nconst test = "hello";',
      path: params.path
    };
  }

  async listDirectory(params: any): Promise<any> {
    return {
      files: ['README.md', 'package.json'],
      directories: ['src', 'tests']
    };
  }

  async healthCheck(): Promise<any> {
    return {
      healthy: true,
      status: 'OK'
    };
  }

  getStats(): any {
    return {
      apiCalls: 0,
      cacheHits: 0
    };
  }

  clearCache(): void {
    // Mock cache clear
  }
}

export default BitbucketMCPServer;
