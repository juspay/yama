/**
 * Enhanced Bitbucket Provider - Optimized from both pr-police.js and pr-describe.js
 * Provides unified, cached, and optimized Bitbucket operations
 */

import { PRIdentifier, PRInfo, PRDiff, GitCredentials, ProviderError } from '../../types';
import { logger } from '../../utils/Logger';
import { cache, Cache } from '../../utils/Cache';

export interface BitbucketMCPResponse {
  content?: Array<{ text?: string }>;
  message?: string;
  error?: string;
}

export class BitbucketProvider {
  private apiClient: any;
  private branchHandlers: any;
  private pullRequestHandlers: any;
  private reviewHandlers: any;
  private fileHandlers: any;
  private initialized = false;
  private baseUrl: string;
  private credentials: GitCredentials;

  constructor(credentials: GitCredentials) {
    this.credentials = credentials;
    this.baseUrl = credentials.baseUrl || 'https://your-bitbucket-server.com';
  }

  /**
   * Initialize MCP handlers with lazy loading and connection reuse
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.debug('Initializing Bitbucket MCP handlers...');

      // Import handlers dynamically for better performance
      const [
        { BitbucketApiClient },
        { BranchHandlers },
        { PullRequestHandlers },
        { ReviewHandlers },
        { FileHandlers }
      ] = await Promise.all([
        import('@nexus2520/bitbucket-mcp-server/build/utils/api-client.js'),
        import('@nexus2520/bitbucket-mcp-server/build/handlers/branch-handlers.js'),
        import('@nexus2520/bitbucket-mcp-server/build/handlers/pull-request-handlers.js'),
        import('@nexus2520/bitbucket-mcp-server/build/handlers/review-handlers.js'),
        import('@nexus2520/bitbucket-mcp-server/build/handlers/file-handlers.js')
      ]);

      // Initialize API client with connection reuse
      this.apiClient = new BitbucketApiClient(
        this.baseUrl,
        this.credentials.username,
        undefined, // No app password needed for Server
        this.credentials.token
      );

      // Initialize all handlers
      this.branchHandlers = new BranchHandlers(this.apiClient, this.baseUrl);
      this.pullRequestHandlers = new PullRequestHandlers(
        this.apiClient,
        this.baseUrl,
        this.credentials.username
      );
      this.reviewHandlers = new ReviewHandlers(this.apiClient, this.credentials.username);
      this.fileHandlers = new FileHandlers(this.apiClient, this.baseUrl);

      this.initialized = true;
      logger.debug('Bitbucket MCP handlers initialized successfully');

    } catch (error) {
      throw new ProviderError(`Failed to initialize Bitbucket provider: ${(error as Error).message}`);
    }
  }

  /**
   * Parse MCP response with error handling
   */
  private parseMCPResponse<T>(result: BitbucketMCPResponse): T {
    try {
      // Handle error responses
      if (result.error) {
        throw new Error(result.error);
      }

      // Handle direct JSON response (success case)
      if (result.message && (result as any).pull_request) {
        return result as any;
      }

      // Handle MCP format response
      if (result.content && result.content[0]) {
        const responseContent = result.content[0].text || result.content[0];

        if (typeof responseContent === 'string') {
          // Check for error messages
          if (responseContent.includes('Not found') || responseContent.includes('Error')) {
            throw new Error(responseContent);
          }

          // Try to parse as JSON
          try {
            return JSON.parse(responseContent);
          } catch (parseError) {
            // If not JSON, it's likely an error message
            throw new Error(responseContent);
          }
        }

        // If it's already an object, return it
        return responseContent as T;
      }

      // Return result as-is if it doesn't match expected formats
      return result as any;

    } catch (error) {
      logger.error(`Failed to parse MCP response: ${(error as Error).message}`);
      throw new ProviderError(`Response parsing failed: ${(error as Error).message}`);
    }
  }

  /**
   * Find PR for branch with intelligent caching
   */
  async findPRForBranch(identifier: PRIdentifier): Promise<PRInfo> {
    await this.initialize();

    const { workspace, repository, branch } = identifier;
    if (!branch) {
      throw new ProviderError('Branch name is required');
    }

    const cacheKey = Cache.keys.branchInfo(workspace, repository, branch);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(`Finding PR for branch: ${workspace}/${repository}@${branch}`);

        const rawBranchData = await this.branchHandlers.handleGetBranch({
          workspace,
          repository,
          branch_name: branch,
          include_merged_prs: false,
        });

        const branchData = this.parseMCPResponse(rawBranchData);

        // Direct data extraction
        if ((branchData as any).open_pull_requests && (branchData as any).open_pull_requests.length > 0) {
          const firstPR = (branchData as any).open_pull_requests[0];
          return {
            id: firstPR.id,
            title: firstPR.title,
            description: firstPR.description || '',
            author: firstPR.author?.displayName || firstPR.author?.name || 'Unknown',
            state: 'OPEN',
            sourceRef: branch,
            targetRef: firstPR.destination?.branch?.name || 'main',
            createdDate: firstPR.createdDate || new Date().toISOString(),
            updatedDate: firstPR.updatedDate || new Date().toISOString(),
            reviewers: firstPR.reviewers || [],
            fileChanges: firstPR.file_changes || []
          } as PRInfo;
        }

        throw new ProviderError(`No open PR found for branch: ${branch}`);
      },
      3600 // Cache for 1 hour
    );
  }

  /**
   * Get PR details with enhanced caching
   */
  async getPRDetails(identifier: PRIdentifier): Promise<PRInfo> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError('Pull request ID is required');
    }

    const cacheKey = Cache.keys.prInfo(workspace, repository, pullRequestId);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(`Getting PR details: ${workspace}/${repository}#${pullRequestId}`);

        const rawPRDetails = await this.pullRequestHandlers.handleGetPullRequest({
          workspace,
          repository,
          pull_request_id: pullRequestId,
        });

        const prData = this.parseMCPResponse(rawPRDetails);

        return {
          id: (prData as any).id,
          title: (prData as any).title,
          description: (prData as any).description || '',
          author: (prData as any).author?.displayName || (prData as any).author?.name || 'Unknown',
          state: (prData as any).state || 'OPEN',
          sourceRef: (prData as any).source?.branch?.name || '',
          targetRef: (prData as any).destination?.branch?.name || '',
          createdDate: (prData as any).createdDate || new Date().toISOString(),
          updatedDate: (prData as any).updatedDate || new Date().toISOString(),
          reviewers: (prData as any).reviewers || [],
          comments: (prData as any).active_comments || [],
          fileChanges: (prData as any).file_changes?.map((f: any) => f.path || f.file) || []
        } as PRInfo;
      },
      1800 // Cache for 30 minutes
    );
  }

  /**
   * Get PR diff with smart caching and filtering
   */
  async getPRDiff(
    identifier: PRIdentifier,
    contextLines = 3,
    excludePatterns: string[] = ['*.lock', '*.svg']
  ): Promise<PRDiff> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError('Pull request ID is required');
    }

    const cacheKey = Cache.keys.prDiff(workspace, repository, pullRequestId);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(`Getting PR diff: ${workspace}/${repository}#${pullRequestId}`);

        const rawDiff = await this.reviewHandlers.handleGetPullRequestDiff({
          workspace,
          repository,
          pull_request_id: pullRequestId,
          context_lines: contextLines,
          exclude_patterns: excludePatterns,
        });

        const diffData = this.parseMCPResponse(rawDiff);

        return {
          diff: (diffData as any).diff || '',
          fileChanges: (diffData as any).file_changes || [],
          totalAdditions: (diffData as any).total_additions || 0,
          totalDeletions: (diffData as any).total_deletions || 0
        } as PRDiff;
      },
      1800 // Cache for 30 minutes
    );
  }

  /**
   * Get file content with caching
   */
  async getFileContent(
    workspace: string,
    repository: string,
    filePath: string,
    branch: string
  ): Promise<string> {
    await this.initialize();

    const cacheKey = Cache.keys.fileContent(workspace, repository, filePath, branch);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(`Getting file content: ${workspace}/${repository}/${filePath}@${branch}`);

        const result = await this.fileHandlers.handleGetFileContent({
          workspace,
          repository,
          file_path: filePath,
          branch,
        });

        const fileData = this.parseMCPResponse(result);
        return (fileData as any).content || '';
      },
      7200 // Cache for 2 hours (files change less frequently)
    );
  }

  /**
   * List directory content with caching
   */
  async listDirectoryContent(
    workspace: string,
    repository: string,
    path: string,
    branch: string
  ): Promise<any[]> {
    await this.initialize();

    const cacheKey = Cache.keys.directoryContent(workspace, repository, path, branch);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(`Listing directory: ${workspace}/${repository}/${path}@${branch}`);

        const result = await this.fileHandlers.handleListDirectoryContent({
          workspace,
          repository,
          path,
          branch,
        });

        const dirData = this.parseMCPResponse(result);
        return (dirData as any).contents || [];
      },
      3600 // Cache for 1 hour
    );
  }

  /**
   * Update PR description with reviewer preservation
   */
  async updatePRDescription(
    identifier: PRIdentifier,
    description: string
  ): Promise<{ success: boolean; message: string }> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError('Pull request ID is required');
    }

    try {
      logger.debug(`Updating PR description: ${workspace}/${repository}#${pullRequestId}`);

      const result = await this.pullRequestHandlers.handleUpdatePullRequest({
        workspace,
        repository,
        pull_request_id: pullRequestId,
        description: description
      });

      const updateData = this.parseMCPResponse(result);

      // Invalidate related cache entries
      cache.del(Cache.keys.prInfo(workspace, repository, pullRequestId));

      return {
        success: true,
        message: (updateData as any).message || 'PR description updated successfully'
      };

    } catch (error) {
      logger.error(`Failed to update PR description: ${(error as Error).message}`);
      throw new ProviderError(`Update failed: ${(error as Error).message}`);
    }
  }

  /**
   * Add comment to PR with smart positioning
   */
  async addComment(
    identifier: PRIdentifier,
    commentText: string,
    options: {
      filePath?: string;
      lineNumber?: number;
      lineType?: 'ADDED' | 'REMOVED' | 'CONTEXT';
      codeSnippet?: string;
      searchContext?: {
        before: string[];
        after: string[];
      };
      matchStrategy?: 'exact' | 'best' | 'strict';
      suggestion?: string;
    } = {}
  ): Promise<{ success: boolean; commentId?: number }> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError('Pull request ID is required');
    }

    try {
      logger.debug(`Adding comment to PR: ${workspace}/${repository}#${pullRequestId}`);

      const args: any = {
        workspace,
        repository,
        pull_request_id: pullRequestId,
        comment_text: commentText,
      };

      // Add inline comment parameters if provided
      if (options.filePath && options.codeSnippet) {
        args.file_path = options.filePath;
        args.code_snippet = options.codeSnippet;
        if (options.searchContext) args.search_context = options.searchContext;
        if (options.matchStrategy) args.match_strategy = options.matchStrategy;
        if (options.suggestion) args.suggestion = options.suggestion;
      } else if (options.filePath && options.lineNumber) {
        // Fallback to line number if no code snippet
        args.file_path = options.filePath;
        args.line_number = options.lineNumber;
        args.line_type = options.lineType || 'CONTEXT';
      }

      const result = await this.pullRequestHandlers.handleAddComment(args);
      const commentData = this.parseMCPResponse(result);

      return {
        success: true,
        commentId: (commentData as any).id
      };

    } catch (error) {
      logger.error(`Failed to add comment: ${(error as Error).message}`);
      throw new ProviderError(`Comment failed: ${(error as Error).message}`);
    }
  }

  /**
   * Batch operation support for multiple API calls
   */
  async batchOperations<T>(
    operations: Array<() => Promise<T>>,
    options: {
      maxConcurrent?: number;
      delayBetween?: number;
      continueOnError?: boolean;
    } = {}
  ): Promise<Array<{ success: boolean; data?: T; error?: string }>> {
    const {
      maxConcurrent = 5,
      delayBetween = 1000,
      continueOnError = true
    } = options;

    const results: Array<{ success: boolean; data?: T; error?: string }> = [];
    
    // Process operations in batches
    for (let i = 0; i < operations.length; i += maxConcurrent) {
      const batch = operations.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async (operation) => {
        try {
          const data = await operation();
          return { success: true, data };
        } catch (error) {
          const errorMessage = error instanceof Error ? (error as Error).message : String(error);
          if (!continueOnError) {
            throw error;
          }
          return { success: false, error: errorMessage };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Add delay between batches (except for the last batch)
      if (i + maxConcurrent < operations.length && delayBetween > 0) {
        await new Promise(resolve => setTimeout(resolve, delayBetween));
      }
    }

    return results;
  }

  /**
   * Health check for the provider
   */
  async healthCheck(): Promise<{ healthy: boolean; details: any }> {
    try {
      await this.initialize();
      
      // Try a simple API call to verify connectivity
      const testResult = await this.branchHandlers.handleGetBranch({
        workspace: 'test',
        repository: 'test',
        branch_name: 'test',
        include_merged_prs: false,
      });

      return {
        healthy: true,
        details: {
          initialized: this.initialized,
          baseUrl: this.baseUrl,
          username: this.credentials.username,
          apiConnected: !!testResult
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: {
          initialized: this.initialized,
          error: (error as Error).message
        }
      };
    }
  }

  /**
   * Get provider statistics and cache metrics
   */
  getStats(): any {
    return {
      provider: 'bitbucket',
      initialized: this.initialized,
      baseUrl: this.baseUrl,
      cacheStats: cache.stats(),
      cacheHitRatio: cache.getHitRatio()
    };
  }

  /**
   * Clear provider-related cache entries
   */
  clearCache(): void {
    // Clear all cache entries (could be made more specific)
    cache.clear();
    logger.debug('BitbucketProvider cache cleared');
  }
}

// Export factory function
export function createBitbucketProvider(credentials: GitCredentials): BitbucketProvider {
  return new BitbucketProvider(credentials);
}