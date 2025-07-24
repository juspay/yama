/**
 * Comprehensive unit tests for ContextGatherer
 * Tests unified context gathering, caching, and AI integration
 */

import { ContextGatherer } from '../../src/core/ContextGatherer';
import { BitbucketProvider } from '../../src/core/providers/BitbucketProvider';
import { PRIdentifier, AIProviderConfig } from '../../src/types';
import { cache } from '../../src/utils/Cache';

// Mock NeuroLink
const mockNeurolink = {
  generate: jest.fn()
};

// Mock dynamic import for NeuroLink
global.eval = jest.fn().mockReturnValue(
  jest.fn().mockResolvedValue({
    NeuroLink: jest.fn().mockImplementation(() => mockNeurolink)
  })
);

// Mock cache
jest.mock('../../src/utils/Cache', () => ({
  cache: {
    getOrSet: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    setWithTags: jest.fn(),
    has: jest.fn(),
    del: jest.fn(),
    invalidateTag: jest.fn(),
    stats: jest.fn().mockReturnValue({ keys: 0, hits: 0, misses: 0 }),
    getHitRatio: jest.fn().mockReturnValue(0)
  },
  Cache: {
    keys: {
      branchInfo: jest.fn((w, r, b) => `branch:${w}:${r}:${b}`),
      prInfo: jest.fn((w, r, p) => `pr:${w}:${r}:${p}`),
      prDiff: jest.fn((w, r, p) => `diff:${w}:${r}:${p}`),
      fileContent: jest.fn((w, r, f, b) => `file:${w}:${r}:${b}:${f}`),
      directoryContent: jest.fn((w, r, p, b) => `dir:${w}:${r}:${b}:${p}`),
      projectContext: jest.fn((w, r, b) => `context:${w}:${r}:${b}`)
    }
  }
}));

describe('ContextGatherer', () => {
  let contextGatherer: ContextGatherer;
  let mockBitbucketProvider: jest.Mocked<BitbucketProvider>;
  let mockAIConfig: AIProviderConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset the neurolink mock
    mockNeurolink.generate.mockClear();

    // Mock BitbucketProvider
    mockBitbucketProvider = {
      findPRForBranch: jest.fn(),
      getPRDetails: jest.fn(),
      getPRDiff: jest.fn(),
      getFileContent: jest.fn(),
      listDirectoryContent: jest.fn(),
      updatePRDescription: jest.fn(),
      addComment: jest.fn(),
      initialize: jest.fn(),
      healthCheck: jest.fn(),
      getStats: jest.fn(),
      clearCache: jest.fn(),
      batchOperations: jest.fn()
    } as any;

    mockAIConfig = {
      provider: 'google-ai',
      model: 'gemini-2.5-pro',
      enableAnalytics: true,
      enableFallback: true,
      timeout: '5m',
      temperature: 0.7,
      maxTokens: 1000000
    };

    contextGatherer = new ContextGatherer(mockBitbucketProvider, mockAIConfig);
  });

  describe('Constructor', () => {
    it('should create ContextGatherer with providers', () => {
      expect(contextGatherer).toBeDefined();
      expect((contextGatherer as any).bitbucketProvider).toBe(mockBitbucketProvider);
      expect((contextGatherer as any).aiConfig).toBe(mockAIConfig);
    });
  });

  describe('gatherContext', () => {
    const mockIdentifier: PRIdentifier = {
      workspace: 'test-workspace',
      repository: 'test-repo',
      branch: 'feature/test'
    };

    it('should gather complete context successfully', async () => {
      // Setup mock PR data
      const mockPR = globalThis.testUtils.createMockPR({
        id: 12345,
        fileChanges: ['file1.js', 'file2.js']
      });

      const mockProjectContext = {
        memoryBank: {
          summary: 'Test project context',
          projectContext: 'React application',
          patterns: 'Standard patterns',
          standards: 'High quality standards'
        },
        clinerules: 'Test clinerules',
        filesProcessed: 3
      };

      const mockDiff = globalThis.testUtils.createMockDiff({
        diff: 'test diff content',
        fileChanges: ['file1.js', 'file2.js']
      });

      // Mock the cache calls to execute the functions
      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => {
        if (key.includes('branch:') || key.includes('pr:')) {
          return fn();
        }
        if (key.includes('context:')) {
          return mockProjectContext;
        }
        if (key.includes('diff:')) {
          return fn();
        }
        return fn();
      });

      // Mock provider calls
      mockBitbucketProvider.findPRForBranch.mockResolvedValue(mockPR);
      mockBitbucketProvider.getPRDetails.mockResolvedValue(mockPR);
      mockBitbucketProvider.getPRDiff.mockResolvedValue(mockDiff);

      const result = await contextGatherer.gatherContext(mockIdentifier);

      expect(result).toEqual({
        pr: mockPR,
        identifier: {
          ...mockIdentifier,
          pullRequestId: mockPR.id
        },
        projectContext: mockProjectContext,
        diffStrategy: {
          strategy: 'whole',
          reason: '2 file(s) ≤ 2 (threshold), using whole diff',
          fileCount: 2,
          estimatedSize: 'Small (~5-20 KB)'
        },
        prDiff: mockDiff,
        fileDiffs: undefined,
        contextId: expect.any(String),
        gatheredAt: expect.any(String),
        cacheHits: [],
        gatheringDuration: expect.any(Number)
      });
    });

    it('should handle PR ID provided directly', async () => {
      const identifierWithPR = {
        ...mockIdentifier,
        pullRequestId: 12345
      };

      const mockPR = globalThis.testUtils.createMockPR({ id: 12345 });

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());
      (cache.has as jest.Mock).mockReturnValue(false);

      mockBitbucketProvider.getPRDetails.mockResolvedValue(mockPR);
      mockBitbucketProvider.listDirectoryContent.mockResolvedValue([]);

      const result = await contextGatherer.gatherContext(identifierWithPR);

      expect(result.pr).toEqual(mockPR);
      expect(mockBitbucketProvider.findPRForBranch).not.toHaveBeenCalled();
      expect(mockBitbucketProvider.getPRDetails).toHaveBeenCalledWith(identifierWithPR);
    });

    it('should determine file-by-file strategy for large changesets', async () => {
      const mockPR = globalThis.testUtils.createMockPR({
        fileChanges: Array.from({ length: 25 }, (_, i) => `file${i}.js`)
      });

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => {
        if (key.includes('context:')) {
          return {
            memoryBank: { summary: 'test' },
            clinerules: '',
            filesProcessed: 0
          };
        }
        return fn();
      });

      mockBitbucketProvider.findPRForBranch.mockResolvedValue(mockPR);
      mockBitbucketProvider.getPRDetails.mockResolvedValue(mockPR);
      mockBitbucketProvider.getPRDiff.mockResolvedValue(globalThis.testUtils.createMockDiff());

      const result = await contextGatherer.gatherContext(mockIdentifier);

      expect(result.diffStrategy.strategy).toBe('file-by-file');
      expect(result.diffStrategy.reason).toBe('25 file(s) > 2 (threshold), using file-by-file');
    });

    it('should skip diff gathering when includeDiff is false', async () => {
      const mockPR = globalThis.testUtils.createMockPR();

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => {
        if (key.includes('context:')) {
          return {
            memoryBank: { summary: 'test' },
            clinerules: '',
            filesProcessed: 0
          };
        }
        return fn();
      });

      mockBitbucketProvider.findPRForBranch.mockResolvedValue(mockPR);
      mockBitbucketProvider.getPRDetails.mockResolvedValue(mockPR);

      const result = await contextGatherer.gatherContext(mockIdentifier, {
        includeDiff: false
      });

      expect(result.prDiff).toBeUndefined();
      expect(result.fileDiffs).toBeUndefined();
      expect(mockBitbucketProvider.getPRDiff).not.toHaveBeenCalled();
    });
  });

  describe('gatherProjectContext', () => {
    it('should gather project context with memory bank files', async () => {
      const mockMemoryBankFiles = [
        { name: 'project.yml', type: 'file' },
        { name: 'patterns.yml', type: 'file' },
        { name: 'standards.yml', type: 'file' }
      ];

      const mockFileContents = {
        'project.yml': 'project: test\ndescription: test project',
        'patterns.yml': 'patterns: standard',
        'standards.yml': 'standards: high quality'
      };

      const mockClinerules = 'test clinerules content';

      mockBitbucketProvider.listDirectoryContent.mockResolvedValue(mockMemoryBankFiles);
      
      // Mock file content calls
      mockBitbucketProvider.getFileContent
        .mockResolvedValueOnce(mockFileContents['project.yml'])
        .mockResolvedValueOnce(mockFileContents['patterns.yml'])
        .mockResolvedValueOnce(mockFileContents['standards.yml'])
        .mockResolvedValueOnce(mockClinerules);

      // Set up cache to bypass AI parsing for this test
      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => {
        if (key.includes('context:')) {
          // Return a mock project context that includes the AI parsed data
          return {
            memoryBank: {
              summary: 'Test project context\nStandard patterns\nHigh quality standards',
              projectContext: 'Test project context',
              patterns: 'Standard patterns',
              standards: 'High quality standards'
            },
            clinerules: mockClinerules,
            filesProcessed: 3
          };
        }
        return fn();
      });

      // Mock the private method call
      const identifier = {
        workspace: 'test',
        repository: 'test',
        branch: 'main',
        pullRequestId: 123
      };

      // Don't override the cache mock - let it use the one set up above

      const result = await (contextGatherer as any).gatherProjectContext(
        identifier,
        [],
        false
      );

      expect(result).toEqual({
        memoryBank: {
          summary: expect.stringContaining('Test project context'),
          projectContext: 'Test project context',
          patterns: 'Standard patterns',
          standards: 'High quality standards'
        },
        clinerules: mockClinerules,
        filesProcessed: 3
      });
    });

    it('should handle missing memory bank directory', async () => {
      mockBitbucketProvider.listDirectoryContent.mockResolvedValue([]);

      const identifier = {
        workspace: 'test',
        repository: 'test',
        branch: 'main',
        pullRequestId: 123
      };

      (cache.getOrSet as jest.Mock).mockImplementation(async (key, fn) => fn());

      const result = await (contextGatherer as any).gatherProjectContext(
        identifier,
        [],
        false
      );

      expect(result).toEqual({
        memoryBank: {
          summary: 'No project context available',
          projectContext: 'None',
          patterns: 'None',
          standards: 'None'
        },
        clinerules: '',
        filesProcessed: 0
      });
    });
  });

  describe('parseProjectContextWithAI', () => {
    it('should parse project context with AI successfully', async () => {
      const mockFileContents = {
        'project.yml': 'project description',
        'patterns.yml': 'coding patterns'
      };
      const mockClinerules = 'clinerules content';

      // Pre-initialize the neurolink on the contextGatherer instance
      const mockGenerate = jest.fn().mockResolvedValue({
        content: JSON.stringify({
          success: true,
          projectContext: 'Parsed project context',
          patterns: 'Parsed patterns',
          standards: 'Parsed standards'
        })
      });
      
      (contextGatherer as any).neurolink = {
        generate: mockGenerate
      };

      const result = await (contextGatherer as any).parseProjectContextWithAI(
        mockFileContents,
        mockClinerules
      );

      expect(result).toEqual({
        projectContext: 'Parsed project context',
        patterns: 'Parsed patterns',
        standards: 'Parsed standards'
      });
    });

    it('should handle AI parsing failure gracefully', async () => {
      mockNeurolink.generate.mockRejectedValue(new Error('AI service unavailable'));

      const result = await (contextGatherer as any).parseProjectContextWithAI(
        {},
        ''
      );

      expect(result).toEqual({
        projectContext: 'AI parsing unavailable',
        patterns: 'Standard patterns assumed',
        standards: 'Standard quality requirements'
      });
    });

    it('should handle invalid AI response', async () => {
      mockNeurolink.generate.mockResolvedValue({
        content: JSON.stringify({
          success: false,
          error: 'Parsing failed'
        })
      });

      const result = await (contextGatherer as any).parseProjectContextWithAI(
        {},
        ''
      );

      expect(result).toEqual({
        projectContext: 'AI parsing unavailable',
        patterns: 'Standard patterns assumed',
        standards: 'Standard quality requirements'
      });
    });
  });

  describe('determineDiffStrategy', () => {
    it('should choose whole strategy for small changesets', () => {
      const fileChanges = ['file1.js', 'file2.js'];

      const strategy = (contextGatherer as any).determineDiffStrategy(fileChanges);

      expect(strategy).toEqual({
        strategy: 'whole',
        reason: '2 file(s) ≤ 2 (threshold), using whole diff',
        fileCount: 2,
        estimatedSize: 'Small (~5-20 KB)'
      });
    });

    it('should choose file-by-file strategy for moderate changesets', () => {
      const fileChanges = Array.from({ length: 10 }, (_, i) => `file${i}.js`);

      const strategy = (contextGatherer as any).determineDiffStrategy(fileChanges);

      expect(strategy).toEqual({
        strategy: 'file-by-file',
        reason: '10 file(s) > 2 (threshold), using file-by-file',
        fileCount: 10,
        estimatedSize: 'Medium (~50-200 KB)'
      });
    });

    it('should choose file-by-file strategy for large changesets', () => {
      const fileChanges = Array.from({ length: 30 }, (_, i) => `file${i}.js`);

      const strategy = (contextGatherer as any).determineDiffStrategy(fileChanges);

      expect(strategy).toEqual({
        strategy: 'file-by-file',
        reason: '30 file(s) > 2 (threshold), using file-by-file',
        fileCount: 30,
        estimatedSize: 'Large (~200-500 KB)'
      });
    });

    it('should handle very large changesets', () => {
      const fileChanges = Array.from({ length: 100 }, (_, i) => `file${i}.js`);

      const strategy = (contextGatherer as any).determineDiffStrategy(fileChanges);

      expect(strategy).toEqual({
        strategy: 'file-by-file',
        reason: '100 file(s) > 2 (threshold), using file-by-file',
        fileCount: 100,
        estimatedSize: 'Very Large (>500 KB)'
      });
    });

    it('should handle empty changeset', () => {
      const fileChanges: string[] = [];

      const strategy = (contextGatherer as any).determineDiffStrategy(fileChanges);

      expect(strategy).toEqual({
        strategy: 'whole',
        reason: 'No files to analyze',
        fileCount: 0,
        estimatedSize: '0 KB'
      });
    });
  });

  describe('getCachedContext', () => {
    it('should return cached context if available', async () => {
      const mockContext = {
        pr: globalThis.testUtils.createMockPR(),
        identifier: { workspace: 'test', repository: 'test', branch: 'test' },
        contextId: 'test-id',
        gatheredAt: '2024-01-01T00:00:00Z'
      };

      (cache.get as jest.Mock).mockReturnValue(mockContext);

      const result = await contextGatherer.getCachedContext({
        workspace: 'test',
        repository: 'test',
        branch: 'test'
      });

      expect(result).toEqual(mockContext);
    });

    it('should return null if no cached context', async () => {
      (cache.get as jest.Mock).mockReturnValue(null);

      const result = await contextGatherer.getCachedContext({
        workspace: 'test',
        repository: 'test',
        branch: 'test'
      });

      expect(result).toBeNull();
    });
  });

  describe('invalidateContext', () => {
    it('should invalidate context cache for PR', () => {
      const identifier = {
        workspace: 'test',
        repository: 'test',
        pullRequestId: 123
      };

      contextGatherer.invalidateContext(identifier);

      expect(cache.invalidateTag).toHaveBeenCalledWith('pr:123');
      expect(cache.invalidateTag).toHaveBeenCalledWith('workspace:test');
    });
  });

  describe('generateContextId', () => {
    it('should generate consistent context ID', () => {
      const identifier = {
        workspace: 'test',
        repository: 'repo',
        branch: 'main'
      };

      const id1 = (contextGatherer as any).generateContextId(identifier);
      const id2 = (contextGatherer as any).generateContextId(identifier);

      expect(id1).toBe(id2);
      expect(typeof id1).toBe('string');
      expect(id1.length).toBe(16);
    });

    it('should handle different identifier formats', () => {
      const identifier1 = {
        workspace: 'test',
        repository: 'repo',
        pullRequestId: 123
      };

      const identifier2 = {
        workspace: 'test',
        repository: 'repo',
        branch: 'main'
      };

      const id1 = (contextGatherer as any).generateContextId(identifier1);
      const id2 = (contextGatherer as any).generateContextId(identifier2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('parseAIResponse', () => {
    it('should parse valid AI response', () => {
      const mockResponse = {
        content: JSON.stringify({
          success: true,
          data: 'test data'
        })
      };

      const result = (contextGatherer as any).parseAIResponse(mockResponse);

      expect(result).toEqual({
        success: true,
        data: 'test data'
      });
    });

    it('should handle response with text field', () => {
      const mockResponse = {
        text: JSON.stringify({
          success: true,
          data: 'test data'
        })
      };

      const result = (contextGatherer as any).parseAIResponse(mockResponse);

      expect(result).toEqual({
        success: true,
        data: 'test data'
      });
    });

    it('should handle empty response', () => {
      const result = (contextGatherer as any).parseAIResponse({});

      expect(result).toEqual({
        success: false,
        error: 'Empty response'
      });
    });

    it('should handle invalid JSON', () => {
      const mockResponse = {
        content: 'invalid json {'
      };

      const result = (contextGatherer as any).parseAIResponse(mockResponse);

      expect(result).toEqual({
        success: false,
        error: 'No JSON found'
      });
    });
  });

  describe('getStats', () => {
    it('should return gathering statistics', () => {
      const stats = contextGatherer.getStats();

      expect(stats).toEqual({
        lastGatheringDuration: expect.any(Number),
        cacheStats: { keys: 0, hits: 0, misses: 0 },
        cacheHitRatio: 0
      });
    });
  });
});
