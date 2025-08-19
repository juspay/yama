/**
 * Enhanced GitHub Provider - Hosted GitHub MCP Server Integration
 * Provides unified, cached, and optimized GitHub operations via GitHub's hosted MCP service
 */

import {
  PRIdentifier,
  PRInfo,
  PRDiff,
  GitCredentials,
  ProviderError,
} from "../../types/index.js";
import { BaseGitProvider } from "./GitProvider.js";
import { logger } from "../../utils/Logger.js";
import { cache, Cache } from "../../utils/Cache.js";
import { spawn, ChildProcess } from "child_process";

export interface GitHubMCPResponse {
  jsonrpc: string;
  id: string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface GitHubMCPConfig {
  mcpServerUrl?: string;
  timeout?: number;
  retries?: number;
  dockerImage?: string;
}

export class GitHubProvider extends BaseGitProvider {
  private mcpConfig: GitHubMCPConfig;
  private mcpServerUrl: string;
  private mcpProcess: ChildProcess | null = null;
  private requestCounter = 0;

  constructor(credentials: GitCredentials, mcpConfig: GitHubMCPConfig = {}) {
    super(credentials);
    this.mcpConfig = {
      mcpServerUrl: "http://localhost:3000",
      timeout: 30000, // 30 seconds
      retries: 3,
      dockerImage: "ghcr.io/github/github-mcp-server:latest",
      ...mcpConfig,
    };
    this.mcpServerUrl = this.mcpConfig.mcpServerUrl!;
  }

  protected getDefaultBaseUrl(): string {
    return "https://api.github.com";
  }

  protected getProviderName(): string {
    return "GitHub";
  }

  /**
   * Initialize GitHub MCP server via Docker subprocess
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      logger.debug("Initializing GitHub MCP server via Docker subprocess...");

      // Start the MCP server process
      await this.startMCPProcess();

      // Test connection with a simple health check
      await this.testMCPConnection();

      this.initialized = true;
      logger.debug("GitHub MCP server initialized successfully");
    } catch (error) {
      if (this.mcpProcess) {
        this.mcpProcess.kill();
        this.mcpProcess = null;
      }
      throw new ProviderError(
        `Failed to initialize GitHub provider: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Start the GitHub MCP server as a subprocess
   */
  private async startMCPProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.debug("Starting GitHub MCP server subprocess...");

      // Determine container runtime
      const containerCmd = process.env.CONTAINER_CMD || "podman";

      // Build container args with runtime-specific security options
      const containerArgs = [
        "run",
        "-i",
        "--rm",
        "--read-only",
        "--user", "1000:1000",
        "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${this.credentials.token}`
      ];

      // Add Docker-specific security options
      if (containerCmd === "docker") {
        containerArgs.push("--no-new-privileges");
      }

      containerArgs.push(
        this.mcpConfig.dockerImage!,
        "stdio"
      );

      // Start the MCP server via Docker/Podman
      this.mcpProcess = spawn(containerCmd, containerArgs, {
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (!this.mcpProcess || !this.mcpProcess.stdin || !this.mcpProcess.stdout) {
        reject(new Error("Failed to start MCP process"));
        return;
      }

      // Handle process errors
      this.mcpProcess.on("error", (error) => {
        logger.error("MCP process error:", error.message);
        reject(error);
      });

      this.mcpProcess.stderr?.on("data", (data) => {
        logger.debug("MCP stderr:", data.toString());
      });

      // Wait a moment for the process to start
      setTimeout(() => {
        if (this.mcpProcess && !this.mcpProcess.killed) {
          logger.debug("MCP server process started successfully");
          resolve();
        } else {
          reject(new Error("MCP process failed to start"));
        }
      }, 2000);
    });
  }

  /**
   * Test MCP connection with a health check
   */
  private async testMCPConnection(): Promise<void> {
    try {
      // Try a simple operation to verify the connection works
      // tools/list is a direct method call, not a tool
      const result = await this.executeDirectMCPMethod("tools/list", {});
      if (result.error) {
        throw new Error(`MCP server error: ${result.error.message}`);
      }
      logger.debug("GitHub MCP server connection verified");
    } catch (error) {
      throw new Error(`GitHub MCP server connection test failed: ${(error as Error).message}`);
    }
  }

  /**
   * Execute direct MCP method (like tools/list)
   */
  private async executeDirectMCPMethod(method: string, params: any): Promise<GitHubMCPResponse> {
    if (!this.mcpProcess || !this.mcpProcess.stdin || !this.mcpProcess.stdout) {
      throw new Error("MCP process not initialized");
    }

    const requestId = (++this.requestCounter).toString();
    const requestData = {
      jsonrpc: "2.0",
      id: requestId,
      method: method,
      params: params,
    };

    return new Promise((resolve, reject) => {
      if (!this.mcpProcess || !this.mcpProcess.stdin || !this.mcpProcess.stdout) {
        reject(new Error("MCP process not available"));
        return;
      }

      let responseData = "";

      // Set up response handler
      const onData = (data: Buffer) => {
        responseData += data.toString();
        
        // Check if we have a complete JSON response
        try {
          const lines = responseData.split('\n');
          for (const line of lines) {
            if (line.trim() && line.includes(requestId)) {
              const response = JSON.parse(line) as GitHubMCPResponse;
              if (response.id === requestId) {
                this.mcpProcess!.stdout!.off('data', onData);
                clearTimeout(timeoutHandle);
                
                if (response.error) {
                  reject(new Error(`MCP Error: ${response.error.message}`));
                } else {
                  resolve(response);
                }
                return;
              }
            }
          }
        } catch (parseError) {
          // Continue collecting data if JSON is incomplete
        }
      };

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.mcpProcess!.stdout!.off('data', onData);
        reject(new Error("MCP request timeout"));
      }, this.mcpConfig.timeout || 30000);

      // Start listening for response
      this.mcpProcess.stdout.on('data', onData);

      // Send request
      try {
        const requestJson = JSON.stringify(requestData) + '\n';
        this.mcpProcess.stdin.write(requestJson);
      } catch (error) {
        this.mcpProcess.stdout.off('data', onData);
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to send MCP request: ${(error as Error).message}`));
      }
    });
  }

  /**
   * Execute MCP tool via tools/call
   */
  private async executeMCPCommand(toolName: string, params: any): Promise<GitHubMCPResponse> {
    if (!this.mcpProcess || !this.mcpProcess.stdin || !this.mcpProcess.stdout) {
      throw new Error("MCP process not initialized");
    }

    const requestId = (++this.requestCounter).toString();
    const requestData = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: params,
      },
    };

    return new Promise((resolve, reject) => {
      if (!this.mcpProcess || !this.mcpProcess.stdin || !this.mcpProcess.stdout) {
        reject(new Error("MCP process not available"));
        return;
      }

      let responseData = "";

      // Set up response handler
      const onData = (data: Buffer) => {
        responseData += data.toString();
        
        // Check if we have a complete JSON response
        try {
          const lines = responseData.split('\n');
          for (const line of lines) {
            if (line.trim() && line.includes(requestId)) {
              const response = JSON.parse(line) as GitHubMCPResponse;
              if (response.id === requestId) {
                this.mcpProcess!.stdout!.off('data', onData);
                clearTimeout(timeoutHandle);
                
                if (response.error) {
                  reject(new Error(`MCP Error: ${response.error.message}`));
                } else {
                  resolve(response);
                }
                return;
              }
            }
          }
        } catch (parseError) {
          // Continue collecting data if JSON is incomplete
        }
      };

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.mcpProcess!.stdout!.off('data', onData);
        reject(new Error("MCP request timeout"));
      }, this.mcpConfig.timeout || 30000);

      // Start listening for response
      this.mcpProcess.stdout.on('data', onData);

      // Send request
      try {
        const requestJson = JSON.stringify(requestData) + '\n';
        this.mcpProcess.stdin.write(requestJson);
      } catch (error) {
        this.mcpProcess.stdout.off('data', onData);
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to send MCP request: ${(error as Error).message}`));
      }
    });
  }

  /**
   * Parse MCP response from GitHub MCP server
   */
  private parseMCPResponse<T>(response: GitHubMCPResponse): T {
    logger.debug(`Raw MCP response: ${JSON.stringify(response, null, 2)}`);
    
    // Handle error responses
    if (response.error) {
      throw new Error(`GitHub API Error: ${response.error.message}`);
    }

    // For tools/call responses, the result might be in result.content
    if (response.result && typeof response.result === 'object' && 'content' in response.result) {
      logger.debug(`Extracting content from MCP response: ${JSON.stringify(response.result.content, null, 2)}`);
      const content = (response.result as any).content;
      
      // Check if content is an array with text that might be JSON
      if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
        const textContent = content[0].text;
        try {
          // Try to parse as JSON if it looks like JSON
          if (textContent.startsWith('{') || textContent.startsWith('[')) {
            return JSON.parse(textContent) as T;
          }
        } catch (parseError) {
          // If JSON parsing fails, return the text content as-is
          logger.debug(`Failed to parse JSON from MCP response: ${parseError}`);
        }
        // Return the text content if it's not JSON
        return textContent as T;
      }
      
      return content as T;
    }

    // Return the result directly for other response types
    logger.debug(`Using direct result from MCP response: ${JSON.stringify(response.result, null, 2)}`);
    return response.result as T;
  }

  /**
   * Validate identifier to prevent injection attacks
   */
  private validateIdentifier(identifier: PRIdentifier): void {
    const { workspace, repository, branch, pullRequestId } = identifier;
    
    // Validate workspace (GitHub org/user name)
    if (workspace && !/^[a-zA-Z0-9]([a-zA-Z0-9-_]){0,38}$/.test(workspace)) {
      throw new ProviderError("Invalid workspace name format");
    }
    
    // Validate repository name
    if (repository && !/^[a-zA-Z0-9._-]+$/.test(repository)) {
      throw new ProviderError("Invalid repository name format");
    }
    
    // Validate branch name
    if (branch && !/^[a-zA-Z0-9._/-]+$/.test(branch)) {
      throw new ProviderError("Invalid branch name format");
    }
    
    // Validate pull request ID
    if (pullRequestId && (!/^\d+$/.test(pullRequestId.toString()) || Number(pullRequestId) <= 0)) {
      throw new ProviderError("Invalid pull request ID format");
    }
  }

  /**
   * Find PR for branch with intelligent caching
   */
  async findPRForBranch(identifier: PRIdentifier): Promise<PRInfo> {
    await this.initialize();
    this.validateIdentifier(identifier);

    const { workspace, repository, branch } = identifier;
    if (!branch) {
      throw new ProviderError("Branch name is required");
    }

    const cacheKey = Cache.keys.branchInfo(workspace, repository, branch);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(
          `Finding PR for branch: ${workspace}/${repository}@${branch}`,
        );

        // GitHub MCP: List pull requests for branch
        const rawPRData = await this.executeMCPCommand("list_pull_requests", {
          owner: workspace,
          repo: repository,
          state: "open",
        });

        const prData = this.parseMCPResponse(rawPRData);

        // GitHub returns an array of PRs - filter by branch
        if (Array.isArray(prData) && prData.length > 0) {
          // Find PR that matches the branch
          const matchingPR = prData.find((pr: any) => 
            pr.head?.ref === branch || pr.head?.ref === `${workspace}:${branch}`
          );
          
          if (matchingPR) {
            return this.mapGitHubPRToInfo(matchingPR);
          }
        }

        throw new ProviderError(`No open PR found for branch: ${branch}`);
      },
      3600, // Cache for 1 hour
    );
  }

  /**
   * Get PR details with enhanced caching
   */
  async getPRDetails(identifier: PRIdentifier): Promise<PRInfo> {
    await this.initialize();
    this.validateIdentifier(identifier);

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError("Pull request ID is required");
    }

    const cacheKey = Cache.keys.prInfo(workspace, repository, pullRequestId);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(
          `Getting PR details: ${workspace}/${repository}#${pullRequestId}`,
        );

        // GitHub MCP: Get pull request details
        const rawPRDetails = await this.executeMCPCommand("get_pull_request", {
          owner: workspace,
          repo: repository,
          pullNumber: parseInt(pullRequestId.toString(), 10),
        });

        const prData = this.parseMCPResponse(rawPRDetails);
        logger.debug(`Parsed PR data before mapping: ${JSON.stringify(prData, null, 2)}`);

        const mappedPR = this.mapGitHubPRToInfo(prData as any);
        logger.debug(`Mapped PR info: ${JSON.stringify(mappedPR, null, 2)}`);
        
        return mappedPR;
      },
      1800, // Cache for 30 minutes
    );
  }

  /**
   * Map GitHub PR data to our PRInfo interface
   */
  private mapGitHubPRToInfo(githubPR: any): PRInfo {
    logger.debug(`Mapping GitHub PR data: ${JSON.stringify(githubPR, null, 2)}`);
    logger.debug(`GitHub PR number: ${githubPR.number}, type: ${typeof githubPR.number}`);
    
    return {
      id: githubPR.number,
      title: githubPR.title,
      description: githubPR.body || "",
      author: githubPR.user?.login || "Unknown",
      state: this.mapGitHubState(githubPR.state),
      sourceRef: githubPR.head?.ref || "",
      targetRef: githubPR.base?.ref || "",
      createdDate: githubPR.created_at || new Date().toISOString(),
      updatedDate: githubPR.updated_at || new Date().toISOString(),
      reviewers: githubPR.requested_reviewers?.map((reviewer: any) => ({
        user: {
          name: reviewer.login,
          emailAddress: reviewer.email || "",
          displayName: reviewer.name || reviewer.login,
        },
        approved: false,
        status: "UNAPPROVED",
      })) || [],
      comments: [], // Will be populated separately if needed
      fileChanges: [], // Will be populated from diff data
    } as PRInfo;
  }

  /**
   * Map GitHub PR state to our standard format
   */
  private mapGitHubState(githubState: string): "OPEN" | "MERGED" | "DECLINED" | "CLOSED" {
    switch (githubState?.toLowerCase()) {
      case "open":
        return "OPEN";
      case "closed":
        return "CLOSED"; // GitHub uses "closed" for both merged and declined
      default:
        return "OPEN";
    }
  }

  /**
   * Get PR diff with smart caching and filtering
   */
  async getPRDiff(
    identifier: PRIdentifier,
    contextLines = 3,
    excludePatterns: string[] = ["*.lock", "*.svg"],
    includePatterns?: string[],
  ): Promise<PRDiff> {
    await this.initialize();
    this.validateIdentifier(identifier);

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError("Pull request ID is required");
    }

    // Create a cache key that includes include patterns if specified
    const cacheKey =
      includePatterns && includePatterns.length === 1
        ? `file-diff:${workspace}:${repository}:${pullRequestId}:${includePatterns[0]}`
        : Cache.keys.prDiff(workspace, repository, pullRequestId);

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(
          `Getting PR diff: ${workspace}/${repository}#${pullRequestId}`,
        );
        if (includePatterns) {
          logger.debug(`Include patterns: ${includePatterns.join(", ")}`);
        }

        // GitHub MCP: Get pull request files
        const rawDiff = await this.executeMCPCommand("get_pull_request_files", {
          owner: workspace,
          repo: repository,
          pullNumber: parseInt(pullRequestId.toString(), 10),
        });

        const diffData = this.parseMCPResponse(rawDiff);
        
        // Filter files based on patterns
        let files = (diffData as any) || [];
        
        if (excludePatterns?.length) {
          files = files.filter((file: any) => 
            !this.matchesPatterns(file.filename, excludePatterns)
          );
        }
        
        if (includePatterns?.length) {
          files = files.filter((file: any) => 
            this.matchesPatterns(file.filename, includePatterns)
          );
        }

        // Convert GitHub files format to our PRDiff format
        const fileChanges = files.map((file: any) => ({
          path: file.filename,
          changeType: this.mapGitHubFileStatus(file.status),
          additions: file.additions || 0,
          deletions: file.deletions || 0,
          hunks: [], // Would need patch parsing for detailed hunks
        }));

        const totalAdditions = files.reduce((sum: number, file: any) => sum + (file.additions || 0), 0);
        const totalDeletions = files.reduce((sum: number, file: any) => sum + (file.deletions || 0), 0);

        // Construct unified diff from patches
        const diff = files
          .map((file: any) => file.patch || "")
          .filter((patch: string) => patch.length > 0)
          .join("\n");

        return {
          diff,
          fileChanges,
          totalAdditions,
          totalDeletions,
        } as PRDiff;
      },
      1800, // Cache for 30 minutes
    );
  }

  /**
   * Map GitHub file status to our format
   */
  private mapGitHubFileStatus(status: string): "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" {
    switch (status?.toLowerCase()) {
      case "added":
        return "ADDED";
      case "modified":
        return "MODIFIED";
      case "removed":
        return "DELETED";
      case "renamed":
        return "RENAMED";
      default:
        return "MODIFIED";
    }
  }

  /**
   * Check if filename matches any of the given patterns
   */
  private matchesPatterns(filename: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      // Simple glob pattern matching
      const regex = new RegExp(
        pattern
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
      );
      return regex.test(filename);
    });
  }

  /**
   * Get file content with caching
   */
  async getFileContent(
    workspace: string,
    repository: string,
    filePath: string,
    branch: string,
  ): Promise<string> {
    await this.initialize();

    const cacheKey = Cache.keys.fileContent(
      workspace,
      repository,
      filePath,
      branch,
    );

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(
          `Getting file content: ${workspace}/${repository}/${filePath}@${branch}`,
        );

        // GitHub MCP: Get file content
        const result = await this.executeMCPCommand("get_file_contents", {
          owner: workspace,
          repo: repository,
          path: filePath,
          ref: branch,
        });

        const fileData = this.parseMCPResponse(result);
        
        // GitHub returns base64 encoded content
        if ((fileData as any).content) {
          // Decode base64 content manually without Buffer dependency
          const base64Content = (fileData as any).content;
          try {
            return atob(base64Content);
          } catch (error) {
            // Fallback for Node.js environments
            return base64Content; // Return as-is if decode fails
          }
        }

        return "";
      },
      7200, // Cache for 2 hours (files change less frequently)
    );
  }

  /**
   * List directory content with caching
   */
  async listDirectoryContent(
    workspace: string,
    repository: string,
    path: string,
    branch: string,
  ): Promise<any[]> {
    await this.initialize();

    const cacheKey = Cache.keys.directoryContent(
      workspace,
      repository,
      path,
      branch,
    );

    return cache.getOrSet(
      cacheKey,
      async () => {
        logger.debug(
          `Listing directory: ${workspace}/${repository}/${path}@${branch}`,
        );

        // GitHub MCP: Get directory content
        const result = await this.executeMCPCommand("get_file_contents", {
          owner: workspace,
          repo: repository,
          path: path.endsWith('/') ? path : path + '/',  // Ensure directory path ends with /
          ref: branch,
        });

        const dirData = this.parseMCPResponse(result);
        return Array.isArray(dirData) ? dirData : [];
      },
      3600, // Cache for 1 hour
    );
  }

  /**
   * Update PR description
   */
  async updatePRDescription(
    identifier: PRIdentifier,
    description: string,
  ): Promise<{ success: boolean; message: string }> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError("Pull request ID is required");
    }

    try {
      logger.debug(
        `Updating PR description: ${workspace}/${repository}#${pullRequestId}`,
      );
      logger.debug(`Description length: ${description.length} characters`);

      // GitHub MCP: Update pull request
      const result = await this.executeMCPCommand("update_pull_request", {
        owner: workspace,
        repo: repository,
        pullNumber: parseInt(pullRequestId.toString(), 10),
        body: description,
      });

      const updateData = this.parseMCPResponse(result);

      // Invalidate related cache entries
      cache.del(Cache.keys.prInfo(workspace, repository, pullRequestId));

      return {
        success: true,
        message: "PR description updated successfully",
      };
    } catch (error) {
      logger.error(
        `Failed to update PR description: ${(error as Error).message}`,
      );
      throw new ProviderError(`Update failed: ${(error as Error).message}`);
    }
  }

  /**
   * Add comment to PR
   */
  async addComment(
    identifier: PRIdentifier,
    commentText: string,
    options: {
      filePath?: string;
      lineNumber?: number;
      lineType?: "ADDED" | "REMOVED" | "CONTEXT";
      codeSnippet?: string;
      searchContext?: {
        before: string[];
        after: string[];
      };
      matchStrategy?: "exact" | "best" | "strict";
      suggestion?: string;
    } = {},
  ): Promise<{ success: boolean; commentId?: number }> {
    await this.initialize();

    const { workspace, repository, pullRequestId } = identifier;
    if (!pullRequestId) {
      throw new ProviderError("Pull request ID is required");
    }

    try {
      logger.debug(
        `Adding comment to PR: ${workspace}/${repository}#${pullRequestId}`,
      );

      let result;

      if (options.filePath && (options.lineNumber || options.codeSnippet)) {
        // Add review comment (inline comment)
        const reviewData: any = {
          owner: workspace,
          repo: repository,
          pullNumber: parseInt(pullRequestId.toString(), 10),
          body: commentText,
          path: options.filePath,
        };

        if (options.lineNumber) {
          reviewData.line = options.lineNumber;
        }

        // GitHub MCP: Create review comment
        result = await this.executeMCPCommand("add_comment_to_pending_review", reviewData);
      } else {
        // Add general comment
        // GitHub MCP: Create issue comment (PRs are issues in GitHub)
        result = await this.executeMCPCommand("add_issue_comment", {
          owner: workspace,
          repo: repository,
          issueNumber: parseInt(pullRequestId.toString(), 10), // GitHub treats PR comments as issue comments
          body: commentText,
        });
      }

      const commentData = this.parseMCPResponse(result);

      return {
        success: true,
        commentId: (commentData as any).id,
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
    } = {},
  ): Promise<Array<{ success: boolean; data?: T; error?: string }>> {
    const {
      maxConcurrent = 5,
      delayBetween = 1000,
      continueOnError = true,
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
          const errorMessage =
            error instanceof Error ? (error as Error).message : String(error);
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
        await new Promise((resolve) => {
          const timer = globalThis.setTimeout(() => resolve(undefined), delayBetween);
          // Ensure cleanup on error
          timer.unref?.();
        });
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
      // GitHub MCP: Get current user
      const testResult = await this.executeMCPCommand("get_me", {});

      return {
        healthy: true,
        details: {
          initialized: this.initialized,
          baseUrl: this.baseUrl,
          username: this.credentials.username,
          apiConnected: !!testResult,
        },
      };
    } catch (error) {
      return {
        healthy: false,
        details: {
          initialized: this.initialized,
          error: (error as Error).message,
        },
      };
    }
  }

  /**
   * Get provider statistics and cache metrics
   */
  getStats(): any {
    return {
      provider: "github",
      initialized: this.initialized,
      baseUrl: this.baseUrl,
      cacheStats: cache.stats(),
      cacheHitRatio: cache.getHitRatio(),
    };
  }

  /**
   * Clear provider-related cache entries
   */
  clearCache(): void {
    // Clear all cache entries (could be made more specific)
    cache.clear();
    logger.debug("GitHubProvider cache cleared");
  }

  /**
   * Cleanup MCP process when provider is destroyed
   */
  async cleanup(): Promise<void> {
    if (this.mcpProcess) {
      logger.debug("Shutting down GitHub MCP server process gracefully");
      
      // Try graceful shutdown first
      this.mcpProcess.kill('SIGTERM');
      
      // Wait up to 5 seconds for graceful shutdown
      const shutdownTimeout = setTimeout(() => {
        if (this.mcpProcess && !this.mcpProcess.killed) {
          logger.warn("Force killing GitHub MCP server process");
          this.mcpProcess.kill('SIGKILL');
        }
      }, 5000);
      
      // Clean up when process exits
      this.mcpProcess.on('exit', () => {
        clearTimeout(shutdownTimeout);
        this.mcpProcess = null;
        logger.debug("GitHub MCP server process shut down successfully");
      });
      
      // Handle immediate exit
      if (this.mcpProcess.killed) {
        clearTimeout(shutdownTimeout);
        this.mcpProcess = null;
      }
    }
  }
}

// Export factory function
export function createGitHubProvider(
  credentials: GitCredentials,
): GitHubProvider {
  return new GitHubProvider(credentials);
}