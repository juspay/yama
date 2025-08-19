/**
 * Memory Bank Manager - Handles configurable memory bank operations
 * Provides abstraction for memory bank file access with fallback support
 */

import { MemoryBankConfig, PRIdentifier, ConfigurationError } from "../types/index.js";
import { GitProvider } from "../core/providers/GitProvider.js";
import { logger } from "./Logger.js";
import { cache, Cache } from "./Cache.js";

export interface MemoryBankFile {
  name: string;
  content: string;
  path: string;
}

export interface MemoryBankResult {
  files: MemoryBankFile[];
  resolvedPath: string;
  filesProcessed: number;
  fallbackUsed: boolean;
}

export class MemoryBankManager {
  private config: MemoryBankConfig;
  private gitProvider: GitProvider;

  constructor(config: MemoryBankConfig, gitProvider: GitProvider) {
    this.config = config;
    this.gitProvider = gitProvider;
    this.validateConfig();
  }

  /**
   * Get memory bank files from the configured path with fallback support
   */
  async getMemoryBankFiles(
    identifier: PRIdentifier,
    forceRefresh = false,
  ): Promise<MemoryBankResult> {
    if (!this.config.enabled) {
      logger.debug("Memory bank is disabled in configuration");
      return {
        files: [],
        resolvedPath: "",
        filesProcessed: 0,
        fallbackUsed: false,
      };
    }

    const cacheKey = Cache.keys.memoryBankFiles(
      identifier.workspace,
      identifier.repository,
      identifier.branch || "main",
      this.config.path,
    );

    if (!forceRefresh && cache.has(cacheKey)) {
      logger.debug("Using cached memory bank files");
      return cache.get<MemoryBankResult>(cacheKey)!;
    }

    logger.debug(`Gathering memory bank files from configured paths...`);

    // Try primary path first
    const primaryResult = await this.tryGetFilesFromPath(
      identifier,
      this.config.path,
    );

    if (primaryResult.files.length > 0) {
      const result: MemoryBankResult = {
        ...primaryResult,
        resolvedPath: this.config.path,
        fallbackUsed: false,
      };

      // Cache the result
      cache.set(cacheKey, result, 7200); // 2 hours
      return result;
    }

    // Try fallback paths if primary path failed
    if (this.config.fallbackPaths && this.config.fallbackPaths.length > 0) {
      logger.debug(
        `Primary path '${this.config.path}' not found, trying fallback paths...`,
      );

      for (const fallbackPath of this.config.fallbackPaths) {
        logger.debug(`Trying fallback path: ${fallbackPath}`);
        const fallbackResult = await this.tryGetFilesFromPath(
          identifier,
          fallbackPath,
        );

        if (fallbackResult.files.length > 0) {
          logger.info(
            `Memory bank found at fallback path: ${fallbackPath} (${fallbackResult.files.length} files)`,
          );

          const result: MemoryBankResult = {
            ...fallbackResult,
            resolvedPath: fallbackPath,
            fallbackUsed: true,
          };

          // Cache the result
          cache.set(cacheKey, result, 7200); // 2 hours
          return result;
        }
      }
    }

    // No memory bank found anywhere
    logger.debug(
      `No memory bank found in primary path '${this.config.path}' or fallback paths`,
    );

    const emptyResult: MemoryBankResult = {
      files: [],
      resolvedPath: "",
      filesProcessed: 0,
      fallbackUsed: false,
    };

    // Cache empty result for shorter time to allow for quick retry
    cache.set(cacheKey, emptyResult, 1800); // 30 minutes
    return emptyResult;
  }

  /**
   * Try to get files from a specific path
   */
  private async tryGetFilesFromPath(
    identifier: PRIdentifier,
    path: string,
  ): Promise<{ files: MemoryBankFile[]; filesProcessed: number }> {
    try {
      // Get directory listing
      const directoryFiles = await this.gitProvider.listDirectoryContent(
        identifier.workspace,
        identifier.repository,
        path,
        identifier.branch || "main",
      );

      if (!directoryFiles.length) {
        logger.debug(`No files found in directory: ${path}`);
        return { files: [], filesProcessed: 0 };
      }

      // Filter to only files (not directories)
      const files = directoryFiles.filter((f) => f.type === "file");
      logger.debug(`Found ${files.length} files in ${path}`);

      // Get content of each file
      const memoryBankFiles: MemoryBankFile[] = [];

      for (const file of files) {
        try {
          const content = await this.gitProvider.getFileContent(
            identifier.workspace,
            identifier.repository,
            `${path}/${file.name}`,
            identifier.branch || "main",
          );

          memoryBankFiles.push({
            name: file.name,
            content,
            path: `${path}/${file.name}`,
          });

          logger.debug(`✓ Loaded content for: ${file.name}`);
        } catch (error) {
          logger.debug(
            `Could not read file ${file.name}: ${(error as Error).message}`,
          );
          // Continue with other files even if one fails
        }
      }

      return {
        files: memoryBankFiles,
        filesProcessed: memoryBankFiles.length,
      };
    } catch (error) {
      logger.debug(
        `Failed to access path '${path}': ${(error as Error).message}`,
      );
      return { files: [], filesProcessed: 0 };
    }
  }

  /**
   * Get the effective memory bank path (resolved after fallback logic)
   */
  async getEffectiveMemoryBankPath(
    identifier: PRIdentifier,
  ): Promise<string | null> {
    const result = await this.getMemoryBankFiles(identifier);
    return result.resolvedPath || null;
  }

  /**
   * Check if memory bank exists at any configured path
   */
  async hasMemoryBank(identifier: PRIdentifier): Promise<boolean> {
    const result = await this.getMemoryBankFiles(identifier);
    return result.files.length > 0;
  }

  /**
   * Get memory bank configuration
   */
  getConfig(): MemoryBankConfig {
    return { ...this.config };
  }

  /**
   * Update memory bank configuration
   */
  updateConfig(newConfig: Partial<MemoryBankConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.validateConfig();
    logger.debug("Memory bank configuration updated");
  }

  /**
   * Validates that a path is safe for use as a relative path
   * Protects against path traversal attacks including encoded variants
   */
  private static isSafeRelativePath(path: string): boolean {
    if (!path || typeof path !== "string") {
      return false;
    }

    // Reject empty or whitespace-only paths
    if (path.trim().length === 0) {
      return false;
    }

    // Reject excessively long paths
    if (path.length > 1000) {
      return false;
    }

    // Reject absolute paths (Unix-style)
    if (path.startsWith("/")) {
      return false;
    }

    // Reject absolute paths (Windows-style)
    if (/^[a-zA-Z]:/.test(path)) {
      return false;
    }

    // Reject UNC paths (Windows network paths)
    if (path.startsWith("\\\\") || path.startsWith("//")) {
      return false;
    }

    // Decode URL-encoded characters to catch encoded traversal attempts
    let decodedPath = path;
    try {
      // Multiple rounds of decoding to catch double-encoded attacks
      for (let i = 0; i < 3; i++) {
        const previousPath = decodedPath;
        decodedPath = decodeURIComponent(decodedPath);
        if (decodedPath === previousPath) {
          break; // No more decoding needed
        }
      }
    } catch {
      // If decoding fails, treat as suspicious
      return false;
    }

    // Normalize Unicode characters
    decodedPath = decodedPath.normalize("NFC");

    // Check for null bytes (can be used to bypass filters)
    if (decodedPath.includes("\0") || decodedPath.includes("%00")) {
      return false;
    }

    // Normalize path separators to forward slashes
    const normalizedPath = decodedPath.replace(/\\/g, "/");

    // Check for path traversal sequences after normalization
    if (normalizedPath.includes("../") || normalizedPath.includes("/..")) {
      return false;
    }

    // Check for path traversal at the beginning or end
    if (normalizedPath.startsWith("..") || normalizedPath.endsWith("..")) {
      return false;
    }

    // Check for hidden traversal patterns
    if (normalizedPath.includes("./..") || normalizedPath.includes("../.")) {
      return false;
    }

    // Split path into segments and validate each
    const segments = normalizedPath.split("/").filter(segment => segment.length > 0);
    
    for (const segment of segments) {
      // Reject any segment that is exactly ".."
      if (segment === "..") {
        return false;
      }
      
      // Reject segments that contain ".." anywhere
      if (segment.includes("..")) {
        return false;
      }
      
      // Allow segments that start with a single dot (like .memory-bank, .config)
      // but reject multiple dots or suspicious patterns
      if (segment.startsWith(".") && segment !== ".") {
        // Allow single dot followed by alphanumeric/dash/underscore
        if (!/^\.[\w-]+$/.test(segment)) {
          return false;
        }
      }
      
      // Reject segments with control characters
      // Check for control characters (0x00-0x1F and 0x7F)
      for (let i = 0; i < segment.length; i++) {
        const charCode = segment.charCodeAt(i);
        if ((charCode >= 0 && charCode <= 31) || charCode === 127) {
          return false;
        }
      }
    }

    // Additional check: ensure the resolved path doesn't escape the base
    // This is a final safety check using path resolution logic
    const pathParts = segments.filter(part => part !== ".");
    let depth = 0;
    
    for (const part of pathParts) {
      if (part === "..") {
        depth--;
        if (depth < 0) {
          return false; // Would escape the base directory
        }
      } else {
        depth++;
      }
    }

    return true;
  }

  /**
   * Validate memory bank configuration
   */
  private validateConfig(): void {
    if (!this.config.path) {
      throw new ConfigurationError(
        "Memory bank path must be specified when memory bank is enabled",
      );
    }

    if (!MemoryBankManager.isSafeRelativePath(this.config.path)) {
      throw new ConfigurationError(
        `Memory bank path is unsafe or contains path traversal: ${this.config.path}`,
      );
    }

    // Validate fallback paths
    if (this.config.fallbackPaths) {
      for (const fallbackPath of this.config.fallbackPaths) {
        if (!MemoryBankManager.isSafeRelativePath(fallbackPath)) {
          throw new ConfigurationError(
            `Memory bank fallback path is unsafe or contains path traversal: ${fallbackPath}`,
          );
        }
      }
    }

    logger.debug("Memory bank configuration validated successfully");
  }

  /**
   * Clear memory bank cache for a specific repository
   */
  clearCache(identifier: PRIdentifier): void {
    const patterns = [
      `memory-bank:${identifier.workspace}:${identifier.repository}:*`,
      `project-context:${identifier.workspace}:${identifier.repository}:*`,
    ];

    patterns.forEach((pattern) => {
      cache.invalidatePattern(pattern);
    });

    logger.debug(
      `Memory bank cache cleared for ${identifier.workspace}/${identifier.repository}`,
    );
  }

  /**
   * Get memory bank statistics
   */
  async getStats(identifier: PRIdentifier): Promise<{
    enabled: boolean;
    primaryPath: string;
    fallbackPaths: string[];
    hasMemoryBank: boolean;
    resolvedPath: string | null;
    fileCount: number;
    cacheHits: number;
  }> {
    const result = await this.getMemoryBankFiles(identifier);
    const cacheStats = cache.stats();

    return {
      enabled: this.config.enabled,
      primaryPath: this.config.path,
      fallbackPaths: this.config.fallbackPaths || [],
      hasMemoryBank: result.files.length > 0,
      resolvedPath: result.resolvedPath || null,
      fileCount: result.files.length,
      cacheHits: cacheStats.hits,
    };
  }
}

// Export factory function
export function createMemoryBankManager(
  config: MemoryBankConfig,
  gitProvider: GitProvider,
): MemoryBankManager {
  return new MemoryBankManager(config, gitProvider);
}
