/**
 * Comprehensive unit tests for BitbucketProvider
 * Tests all methods including MCP response parsing, caching, and error handling
 */

import { BitbucketProvider } from '../../src/core/providers/BitbucketProvider';
import { PRIdentifier, GitCredentials, ProviderError } from '../../src/types';
import { cache } from '../../src/utils/Cache';

// Mock the MCP server modules
jest.mock('@nexus2520/bitbucket-mcp-server/build/utils/api-client.js', () => ({
  BitbucketApiClient: jest.fn().mockImplementation(() => ({
    // Mock API client methods
  }))
}));

jest.mock('@nexus2520/bitbucket-mcp-server/build/handlers/branch-handlers.js', () => ({
  BranchHandlers: jest.fn().mockImplementation(() => ({
    handleGetBranch: jest.fn()
  }))
}));

jest.mock('@nexus2520/bitbucket-mcp-server/build/handlers/pull-request-handlers.js', () => ({
  PullRequestHandlers: jest.fn().mockImplementation(() => ({
    handleGetPullRequest: jest.fn(),
    handleUpdatePullRequest: jest.fn(),
    handleAddComment: jest.fn()
  }))
}));

jest.mock('@nexus2520/bitbucket-mcp-server/build/handlers/review-handlers.js', () => ({
  ReviewHandlers: jest.fn().mockImplementation(() => ({
    handleGetPullRequestDiff: jest.fn()
  }))
}));

jest.mock('@nexus2520/bitbucket-mcp-server/build/handlers/file-handlers.js', () => ({
  FileHandlers: jest.fn().mockImplementation(() => ({
    handleGetFileContent: jest.fn(),
    handleListDirectoryContent: jest.fn()
  }))
}));

// Mock the cache
jest.mock('../../src/utils/Cache', () => ({
  cache: {
    getOrSet: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    has: jest.fn(),
    clear: jest.fn(),
    stats: jest.fn().mockReturnValue({ keys: 0, hits: 0, misses: 0 }),
    getHitRatio: jest.fn().mockReturnValue(0)
  },
  Cache: {
    keys: {
      branchInfo: jest.fn((w, r, b) => `branch:${w}:${r}:${b}`),
      prInfo: jest.fn((w, r, p) => `pr:${w}:${r}:${p}`),
      prDiff: jest.fn((w, r, p) => `diff:${w}:${r}:${p}`),
      fileContent: jest.fn((w, r, f, b) => `file:${w}:${r}:${b}:${f}`),
      directoryContent: jest.fn((w, r, p, b) => `dir:${w}:${r}:${b}:${p}`)
    }
  }
}));

describe('BitbucketProvider', () => {
  let provider: BitbucketProvider;
  let mockCredentials: GitCredentials;
  let mockBranchHandlers: any;
  let mockPullRequestHandlers: any;
  let mockReviewHandlers: any;
  let mockFileHandlers: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    mockCredentials = {
      username: 'test-user',
      token: 'test-token',
      baseUrl: 'https://test-bitbucket.com'
    };

    provider = new BitbucketProvider(mockCredentials);

    // Setup mock handlers after initialization
    mockBranchHandlers = {
      handleGetBranch: jest.fn()
    };
    mockPullRequestHandlers = {
      handleGetPullRequest: jest.fn(),
      handleUpdatePullRequest: jest.fn(),
      handleAddComment: jest.fn()
    };
    mockReviewHandlers = {
      handleGetPullRequestDiff: jest.fn()
    };
    mockFileHandlers = {
      handleGetFileContent: jest.fn(),
      handleListDirectoryContent: jest.fn()
    };

    // Mock the provider's internal handlers
    (provider as any).branchHandlers = mockBranchHandlers;
    (provider as any).pullRequestHandlers = mockPullRequestHandlers;
    (provider as any).reviewHandlers = mockReviewHandlers;
    (provider as any).fileHandlers = mockFileHandlers;
    (provider as any).initialized = true;
  });

  describe('Constructor', () => {
    it('should create provider with credentials', () => {
      expect(provider).toBeDefined();
      expect((provider as any).credentials).toEqual(mockCredentials);
      expect((provider as any).baseUrl).toBe('https://test-bitbucket.com');
    });

    it('should use default base URL if not provided', () => {
      const credentialsWithoutUrl = { username: 'test', token: 'test' };
      const providerWithoutUrl = new BitbucketProvider(credentialsWithoutUrl);
      expect((providerWithoutUrl as any).baseUrl).toBe('https://your-bitbucket-server.com');
    });
  });

  describe('parseMCPResponse', () => {
    it('should handle direct JSON response with diff', () => {
      const mockResponse = {
        message: 'Pull request diff retrieved successfully',
        pull_request_id: 12345,
        diff: 'test diff content'
      };

      const result = (provider as any).parseMCPResponse(mockResponse);
      expect(result).toEqual(mockResponse);
    });

    it('should handle MCP content format response', () => {
      const expectedData = {
        message: 'Success',
        pull_request: { id: 123, title: 'Test' }
      };
      
      const mcpResponse = {
        content: [{
          text: JSON.stringify(expectedData)
        }]
      };

      const result = (provider as any).parseMCPResponse(mcpResponse);
      expect(result).toEqual(expectedData);
    });

    it('should handle error responses', () => {
      const errorResponse = {
        error: 'Test error message'
      };

      expect(() => {
        (provider as any).parseMCPResponse(errorResponse);
      }).toThrow('Test error message');
    });

    it('should detect error messages in content', () => {
      const errorResponse = {
        content: [{
          text: 'Error: Something went wrong'
        }]
      };

      expect(() => {
        (provider as any).parseMCPResponse(errorResponse);
      }).toThrow('Error: Something went wrong');
    });

    it('should not flag large diff content as error', () => {
      const largeDiffContent = {
        message: 'Pull request diff retrieved successfully',
        diff: 'Very large diff content with the word Error in a comment or code...' + 'A'.repeat(1000)
      };

      const mcpResponse = {
        content: [{
          text: JSON.stringify(largeDiffContent)
        }]
      };

      const result = (provider as any).parseMCPResponse(mcpResponse);
      expect(result).toEqual(largeDiffContent);
    });

    it('should handle invalid JSON in content', () => {
      const invalidJsonResponse = {
        content: [{
          text: 'Invalid JSON {'
        }]
      };

      const result = (provider as any).parseMCPResponse(invalidJsonResponse);
      expect(result).toBe('Invalid JSON {');
    });
  });

  describe('findPRForBranch', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      branch: 'feature/test'
    };

    it('should find PR for branch successfully', async () => {
      const mockBranchData = {
        open_pull_requests: [{
          id: 12345,
          title: 'Test PR',
          description: 'Test description',
          author: { displayName: 'Test User' },
          destination: { branch: { name: 'main' } },
          createdDate: '2024-01-01T00:00:00Z',
          updatedDate: '2024-01-01T00:00:00Z',
          reviewers: [],
          file_changes: ['test.js']
        }]
      };

      mockBranchHandlers.handleGetBranch.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockBranchData)
      );

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await provider.findPRForBranch(mockIdentifier);

      expect(result).toEqual({
        id: 12345,
        title: 'Test PR',
        description: 'Test description',
        author: 'Test User',
        state: 'OPEN',
        sourceRef: 'feature/test',
        targetRef: 'main',
        createdDate: '2024-01-01T00:00:00Z',
        updatedDate: '2024-01-01T00:00:00Z',
        reviewers: [],
        fileChanges: ['test.js']
      });
    });

    it('should throw error if branch name is missing', async () => {
      const invalidIdentifier = {
        workspace: 'test-workspace',
        repository: 'test-repo'
      } as PRIdentifier;

      await expect(provider.findPRForBranch(invalidIdentifier))
        .rejects.toThrow('Branch name is required');
    });

    it('should throw error if no PR found for branch', async () => {
      const mockBranchData = {
        open_pull_requests: []
      };

      mockBranchHandlers.handleGetBranch.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockBranchData)
      );

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      await expect(provider.findPRForBranch(mockIdentifier))
        .rejects.toThrow('No open PR found for branch: feature/test');
    });
  });

  describe('getPRDetails', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      pullRequestId: 12345
    };

    it('should get PR details successfully', async () => {
      const mockPRData = {
        id: 12345,
        title: 'Test PR',
        description: 'Test description',
        author: { displayName: 'Test User' },
        state: 'OPEN',
        source: { branch: { name: 'feature/test' } },
        destination: { branch: { name: 'main' } },
        createdDate: '2024-01-01T00:00:00Z',
        updatedDate: '2024-01-01T00:00:00Z',
        reviewers: [],
        active_comments: [],
        file_changes: [{ path: 'test.js' }]
      };

      mockPullRequestHandlers.handleGetPullRequest.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockPRData)
      );

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await provider.getPRDetails(mockIdentifier);

      expect(result).toEqual({
        id: 12345,
        title: 'Test PR',
        description: 'Test description',
        author: 'Test User',
        state: 'OPEN',
        sourceRef: 'feature/test',
        targetRef: 'main',
        createdDate: '2024-01-01T00:00:00Z',
        updatedDate: '2024-01-01T00:00:00Z',
        reviewers: [],
        comments: [],
        fileChanges: ['test.js']
      });
    });

    it('should throw error if PR ID is missing', async () => {
      const invalidIdentifier = {
        workspace: 'test-workspace',
        repository: 'test-repo'
      } as PRIdentifier;

      await expect(provider.getPRDetails(invalidIdentifier))
        .rejects.toThrow('Pull request ID is required');
    });
  });

  describe('getPRDiff', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      pullRequestId: 12345
    };

    it('should get PR diff successfully', async () => {
      const mockDiffData = {
        message: 'Pull request diff retrieved successfully',
        pull_request_id: 12345,
        diff: 'diff --git a/test.js b/test.js\n+added line',
        file_changes: ['test.js'],
        total_additions: 1,
        total_deletions: 0
      };

      mockReviewHandlers.handleGetPullRequestDiff.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockDiffData)
      );

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await provider.getPRDiff(mockIdentifier);

      expect(result).toEqual({
        diff: 'diff --git a/test.js b/test.js\n+added line',
        fileChanges: ['test.js'],
        totalAdditions: 1,
        totalDeletions: 0
      });
    });

    it('should handle diff with custom context lines and exclude patterns', async () => {
      const mockDiffData = {
        diff: 'test diff',
        file_changes: [],
        total_additions: 0,
        total_deletions: 0
      };

      mockReviewHandlers.handleGetPullRequestDiff.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockDiffData)
      );

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      await provider.getPRDiff(mockIdentifier, 5, ['*.lock', '*.min.js']);

      expect(mockReviewHandlers.handleGetPullRequestDiff).toHaveBeenCalledWith({
        workspace: 'test-workspace',
        repository: 'test-repo',
        pull_request_id: 12345,
        context_lines: 5,
        exclude_patterns: ['*.lock', '*.min.js']
      });
    });
  });

  describe('getFileContent', () => {
    it('should get file content successfully', async () => {
      const mockFileResponse = {
        content: 'file content here'
      };

      mockFileHandlers.handleGetFileContent.mockResolvedValue({
        content: [{
          text: JSON.stringify(mockFileResponse)
        }]
      });

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await provider.getFileContent(
        'workspace',
        'repo',
        'path/to/file.js',
        'main'
      );

      expect(result).toBe('file content here');
    });

    it('should handle direct content format', async () => {
      mockFileHandlers.handleGetFileContent.mockResolvedValue({
        content: 'direct content'
      });

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await provider.getFileContent(
        'workspace',
        'repo',
        'path/to/file.js',
        'main'
      );

      expect(result).toBe('direct content');
    });
  });

  describe('updatePRDescription', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      pullRequestId: 12345
    };

    it('should update PR description successfully', async () => {
      const mockUpdateResponse = {
        message: 'PR updated successfully'
      };

      mockPullRequestHandlers.handleUpdatePullRequest.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockUpdateResponse)
      );

      const result = await provider.updatePRDescription(
        mockIdentifier,
        'New description'
      );

      expect(result).toEqual({
        success: true,
        message: 'PR updated successfully'
      });

      expect(cache.del).toHaveBeenCalledWith('pr:test-workspace:test-repo:12345');
    });

    it('should handle update errors', async () => {
      mockPullRequestHandlers.handleUpdatePullRequest.mockRejectedValue(
        new Error('Update failed')
      );

      await expect(provider.updatePRDescription(mockIdentifier, 'New description'))
        .rejects.toThrow('Update failed: Update failed');
    });
  });

  describe('addComment', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      pullRequestId: 12345
    };

    it('should add general comment successfully', async () => {
      const mockCommentResponse = {
        id: 67890
      };

      mockPullRequestHandlers.handleAddComment.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockCommentResponse)
      );

      const result = await provider.addComment(
        mockIdentifier,
        'Test comment'
      );

      expect(result).toEqual({
        success: true,
        commentId: 67890
      });
    });

    it('should add inline comment with code snippet', async () => {
      const mockCommentResponse = {
        id: 67890
      };

      mockPullRequestHandlers.handleAddComment.mockResolvedValue(
        globalThis.testUtils.createMockMCPResponse(mockCommentResponse)
      );

      const options = {
        filePath: 'test.js',
        codeSnippet: 'const test = true;',
        searchContext: {
          before: ['// Before'],
          after: ['// After']
        },
        suggestion: 'Consider using let instead'
      };

      await provider.addComment(mockIdentifier, 'Test comment', options);

      expect(mockPullRequestHandlers.handleAddComment).toHaveBeenCalledWith({
        workspace: 'test-workspace',
        repository: 'test-repo',
        pull_request_id: 12345,
        comment_text: 'Test comment',
        file_path: 'test.js',
        code_snippet: 'const test = true;',
        search_context: options.searchContext,
        suggestion: 'Consider using let instead'
      });
    });
  });

  describe('batchOperations', () => {
    it('should execute batch operations successfully', async () => {
      const operations = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockResolvedValue('result2'),
        jest.fn().mockResolvedValue('result3')
      ];

      const results = await provider.batchOperations(operations, {
        maxConcurrent: 2,
        delayBetween: 100
      });

      expect(results).toEqual([
        { success: true, data: 'result1' },
        { success: true, data: 'result2' },
        { success: true, data: 'result3' }
      ]);
    });

    it('should handle batch operation failures', async () => {
      const operations = [
        jest.fn().mockResolvedValue('result1'),
        jest.fn().mockRejectedValue(new Error('Operation failed')),
        jest.fn().mockResolvedValue('result3')
      ];

      const results = await provider.batchOperations(operations, {
        continueOnError: true
      });

      expect(results).toEqual([
        { success: true, data: 'result1' },
        { success: false, error: 'Operation failed' },
        { success: true, data: 'result3' }
      ]);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      mockBranchHandlers.handleGetBranch.mockResolvedValue({
        content: [{ text: JSON.stringify({ status: 'ok' }) }]
      });

      const result = await provider.healthCheck();

      expect(result).toEqual({
        healthy: true,
        details: {
          initialized: true,
          baseUrl: 'https://test-bitbucket.com',
          username: 'test-user',
          apiConnected: true
        }
      });
    });

    it('should return unhealthy status on error', async () => {
      mockBranchHandlers.handleGetBranch.mockRejectedValue(
        new Error('Connection failed')
      );

      const result = await provider.healthCheck();

      expect(result).toEqual({
        healthy: false,
        details: {
          initialized: true,
          error: 'Connection failed'
        }
      });
    });
  });

  describe('getStats', () => {
    it('should return provider statistics', () => {
      const stats = provider.getStats();

      expect(stats).toEqual({
        provider: 'bitbucket',
        initialized: true,
        baseUrl: 'https://test-bitbucket.com',
        cacheStats: { keys: 0, hits: 0, misses: 0 },
        cacheHitRatio: 0
      });
    });
  });

  describe('clearCache', () => {
    it('should clear provider cache', () => {
      provider.clearCache();
      expect(cache.clear).toHaveBeenCalled();
    });
  });
});