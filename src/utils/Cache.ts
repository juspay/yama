/**
 * Enhanced Cache utility for Yama
 * Provides intelligent caching for PR data, file contents, and AI responses
 */

import NodeCache from "node-cache";
import { Cache as ICache, CacheOptions } from "../types/index.js";
import { logger } from "./Logger.js";

export class Cache implements ICache {
  private cache: NodeCache;
  private statsData = {
    hits: 0,
    misses: 0,
  };

  constructor(options: CacheOptions = {}) {
    const {
      ttl = 3600, // 1 hour default
      maxSize = 100, // 100 keys max
      checkPeriod = 600, // Check every 10 minutes
    } = options;

    this.cache = new NodeCache({
      stdTTL: ttl,
      maxKeys: maxSize,
      checkperiod: checkPeriod,
      useClones: false,
      deleteOnExpire: true,
    });

    this.cache.on("set", (key: string, _value: any) => {
      logger.debug(`Cache SET: ${key}`);
    });

    this.cache.on("expired", (key: string, _value: any) => {
      logger.debug(`Cache EXPIRED: ${key}`);
    });

    this.cache.on("del", (key: string, _value: any) => {
      logger.debug(`Cache DELETE: ${key}`);
    });
  }

  /**
   * Get value from cache
   */
  get<T>(key: string): T | undefined {
    const value = this.cache.get<T>(key);

    if (value !== undefined) {
      this.statsData.hits++;
      logger.debug(`Cache HIT: ${key}`);
      return value;
    } else {
      this.statsData.misses++;
      logger.debug(`Cache MISS: ${key}`);
      return undefined;
    }
  }

  /**
   * Set value in cache with optional TTL
   */
  set<T>(key: string, value: T, ttl?: number): boolean {
    try {
      const success = this.cache.set(key, value, ttl || 0);
      if (success) {
        logger.debug(`Cache SET successful: ${key}`);
      } else {
        logger.warn(`Cache SET failed: ${key}`);
      }
      return success;
    } catch (error) {
      logger.error(`Cache SET error: ${key}`, error);
      return false;
    }
  }

  /**
   * Delete key from cache
   */
  del(key: string): number {
    const deleted = this.cache.del(key);
    logger.debug(`Cache DELETE: ${key}, deleted: ${deleted}`);
    return deleted;
  }

  /**
   * Check if key exists in cache
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.flushAll();
    this.statsData.hits = 0;
    this.statsData.misses = 0;
    logger.debug("Cache cleared");
  }

  /**
   * Get all cache keys
   */
  keys(): string[] {
    return this.cache.keys();
  }

  /**
   * Get cache statistics
   */
  stats(): { hits: number; misses: number; keys: number; size: number } {
    return {
      hits: this.statsData.hits,
      misses: this.statsData.misses,
      keys: this.cache.keys().length,
      size: this.cache.getStats().keys,
    };
  }

  /**
   * Get detailed cache statistics from node-cache
   */
  getDetailedStats(): any {
    return this.cache.getStats();
  }

  /**
   * Get or set pattern - common caching pattern
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    try {
      logger.debug(`Cache FETCH: ${key}`);
      const value = await fetchFn();
      this.set(key, value, ttl);
      return value;
    } catch (error) {
      logger.error(`Cache FETCH error: ${key}`, error);
      throw error;
    }
  }

  /**
   * Cache with tags for group invalidation
   */
  private tags: Map<string, Set<string>> = new Map();

  setWithTags<T>(key: string, value: T, tags: string[], ttl?: number): boolean {
    const success = this.set(key, value, ttl);

    if (success) {
      // Associate key with tags
      tags.forEach((tag) => {
        if (!this.tags.has(tag)) {
          this.tags.set(tag, new Set());
        }
        this.tags.get(tag)!.add(key);
      });
    }

    return success;
  }

  /**
   * Invalidate all keys with a specific tag
   */
  invalidateTag(tag: string): number {
    const keys = this.tags.get(tag);
    if (!keys) {return 0;}

    let deleted = 0;
    keys.forEach((key) => {
      deleted += this.del(key);
    });

    // Clean up tag associations
    this.tags.delete(tag);

    logger.debug(`Invalidated tag "${tag}": ${deleted} keys`);
    return deleted;
  }

  /**
   * Invalidate all keys matching a pattern
   */
  invalidatePattern(pattern: string): number {
    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    const allKeys = this.keys();
    let deleted = 0;

    allKeys.forEach((key) => {
      if (regex.test(key)) {
        deleted += this.del(key);
      }
    });

    logger.debug(`Invalidated pattern "${pattern}": ${deleted} keys`);
    return deleted;
  }

  /**
   * Cache key generators for common patterns
   */
  static keys = {
    prInfo: (workspace: string, repository: string, prId: string | number) =>
      `pr:${workspace}:${repository}:${prId}`,

    prDiff: (workspace: string, repository: string, prId: string | number) =>
      `diff:${workspace}:${repository}:${prId}`,

    fileContent: (
      workspace: string,
      repository: string,
      filePath: string,
      branch: string,
    ) => `file:${workspace}:${repository}:${branch}:${filePath}`,

    directoryContent: (
      workspace: string,
      repository: string,
      path: string,
      branch: string,
    ) => `dir:${workspace}:${repository}:${branch}:${path}`,

    branchInfo: (workspace: string, repository: string, branch: string) =>
      `branch:${workspace}:${repository}:${branch}`,

    aiResponse: (prompt: string, provider: string, model: string) => {
      // Create a hash of the prompt for consistent keys
      const hash = Buffer.from(prompt).toString("base64").slice(0, 16);
      return `ai:${provider}:${model}:${hash}`;
    },

    projectContext: (workspace: string, repository: string, branch: string) =>
      `context:${workspace}:${repository}:${branch}`,

    reviewResult: (
      workspace: string,
      repository: string,
      prId: string | number,
      configHash: string,
    ) => `review:${workspace}:${repository}:${prId}:${configHash}`,

    memoryBankFiles: (
      workspace: string,
      repository: string,
      branch: string,
      path: string,
    ) => `memory-bank:${workspace}:${repository}:${branch}:${path}`,
  };

  /**
   * Smart cache warming for common patterns
   */
  async warmPRCache(
    workspace: string,
    repository: string,
    prId: string | number,
  ): Promise<void> {
    logger.debug(`Warming cache for PR ${workspace}/${repository}#${prId}`);

    // Pre-generate cache keys that are likely to be needed
    const keys = [
      Cache.keys.prInfo(workspace, repository, prId),
      Cache.keys.prDiff(workspace, repository, prId),
    ];

    // This would be implemented by the calling code to actually fetch the data
    logger.debug(`Cache warming prepared for keys: ${keys.join(", ")}`);
  }

  /**
   * Cleanup expired entries and optimize memory
   */
  cleanup(): void {
    // Node-cache handles TTL cleanup automatically, but we can force it
    const beforeKeys = this.cache.keys().length;

    // Force check for expired keys
    this.cache.keys().forEach((key) => {
      this.cache.get(key); // This triggers expiry check
    });

    const afterKeys = this.cache.keys().length;
    const cleaned = beforeKeys - afterKeys;

    if (cleaned > 0) {
      logger.debug(`Cache cleanup: removed ${cleaned} expired entries`);
    }

    // Clean up tag associations for deleted keys
    this.tags.forEach((keys, tag) => {
      const validKeys = new Set([...keys].filter((key) => this.cache.has(key)));
      if (validKeys.size !== keys.size) {
        this.tags.set(tag, validKeys);
      }
    });
  }

  /**
   * Get cache hit ratio
   */
  getHitRatio(): number {
    const total = this.statsData.hits + this.statsData.misses;
    return total > 0 ? this.statsData.hits / total : 0;
  }

  /**
   * Export cache state for debugging
   */
  debug(): any {
    return {
      stats: this.stats(),
      hitRatio: this.getHitRatio(),
      detailedStats: this.getDetailedStats(),
      keys: this.keys(),
      tags: Object.fromEntries(this.tags.entries()),
    };
  }
}

// Export singleton instance
export const cache = new Cache();

// Export factory function
export function createCache(options?: CacheOptions): Cache {
  return new Cache(options);
}
