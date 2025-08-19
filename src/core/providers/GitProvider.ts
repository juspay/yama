/**
 * Git Provider Interface
 * Common interface for all git platform providers (Bitbucket, GitHub, GitLab, etc.)
 */

import {
  PRIdentifier,
  PRInfo,
  PRDiff,
  GitCredentials,
} from "../../types/index.js";

export interface GitProvider {
  /**
   * Initialize the provider with its dependencies
   */
  initialize(): Promise<void>;

  /**
   * Find PR for a given branch
   */
  findPRForBranch(identifier: PRIdentifier): Promise<PRInfo>;

  /**
   * Get detailed PR information
   */
  getPRDetails(identifier: PRIdentifier): Promise<PRInfo>;

  /**
   * Get PR diff with optional filtering
   */
  getPRDiff(
    identifier: PRIdentifier,
    contextLines?: number,
    excludePatterns?: string[],
    includePatterns?: string[],
  ): Promise<PRDiff>;

  /**
   * Get file content from the repository
   */
  getFileContent(
    workspace: string,
    repository: string,
    filePath: string,
    branch: string,
  ): Promise<string>;

  /**
   * List directory content
   */
  listDirectoryContent(
    workspace: string,
    repository: string,
    path: string,
    branch: string,
  ): Promise<any[]>;

  /**
   * Update PR description
   */
  updatePRDescription(
    identifier: PRIdentifier,
    description: string,
  ): Promise<{ success: boolean; message: string }>;

  /**
   * Add comment to PR
   */
  addComment(
    identifier: PRIdentifier,
    commentText: string,
    options?: {
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
    },
  ): Promise<{ success: boolean; commentId?: number }>;

  /**
   * Batch operations support
   */
  batchOperations<T>(
    operations: Array<() => Promise<T>>,
    options?: {
      maxConcurrent?: number;
      delayBetween?: number;
      continueOnError?: boolean;
    },
  ): Promise<Array<{ success: boolean; data?: T; error?: string }>>;

  /**
   * Health check for the provider
   */
  healthCheck(): Promise<{ healthy: boolean; details: any }>;

  /**
   * Get provider statistics
   */
  getStats(): any;

  /**
   * Clear provider cache
   */
  clearCache(): void;
}

/**
 * Base Git Provider Implementation
 * Provides common functionality that can be extended by specific providers
 */
export abstract class BaseGitProvider implements GitProvider {
  protected credentials: GitCredentials;
  protected baseUrl: string;
  protected initialized = false;

  constructor(credentials: GitCredentials) {
    this.credentials = credentials;
    this.baseUrl = credentials.baseUrl || this.getDefaultBaseUrl();
  }

  /**
   * Get the default base URL for this provider
   */
  protected abstract getDefaultBaseUrl(): string;

  /**
   * Get the provider name (for logging and stats)
   */
  protected abstract getProviderName(): string;

  // Abstract methods that must be implemented by each provider
  abstract initialize(): Promise<void>;
  abstract findPRForBranch(identifier: PRIdentifier): Promise<PRInfo>;
  abstract getPRDetails(identifier: PRIdentifier): Promise<PRInfo>;
  abstract getPRDiff(
    identifier: PRIdentifier,
    contextLines?: number,
    excludePatterns?: string[],
    includePatterns?: string[],
  ): Promise<PRDiff>;
  abstract getFileContent(
    workspace: string,
    repository: string,
    filePath: string,
    branch: string,
  ): Promise<string>;
  abstract listDirectoryContent(
    workspace: string,
    repository: string,
    path: string,
    branch: string,
  ): Promise<any[]>;
  abstract updatePRDescription(
    identifier: PRIdentifier,
    description: string,
  ): Promise<{ success: boolean; message: string }>;
  abstract addComment(
    identifier: PRIdentifier,
    commentText: string,
    options?: any,
  ): Promise<{ success: boolean; commentId?: number }>;
  abstract batchOperations<T>(
    operations: Array<() => Promise<T>>,
    options?: any,
  ): Promise<Array<{ success: boolean; data?: T; error?: string }>>;
  abstract healthCheck(): Promise<{ healthy: boolean; details: any }>;
  abstract getStats(): any;
  abstract clearCache(): void;

  /**
   * Common utility methods that can be used by all providers
   */
  protected isInitialized(): boolean {
    return this.initialized;
  }

  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.getProviderName()} provider not initialized`);
    }
  }
}