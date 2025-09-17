/**
 * Parallel Processing Utilities for Batch Processing
 * Provides concurrency control and resource management for parallel batch execution
 */

import {
  SemaphoreInterface,
  TokenBudgetManagerInterface,
} from "../types/index.js";
import { logger } from "./Logger.js";

/**
 * Semaphore for controlling concurrent access to resources
 * Limits the number of concurrent operations that can run simultaneously
 */
export class Semaphore implements SemaphoreInterface {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    if (permits <= 0) {
      throw new Error("Semaphore permits must be greater than 0");
    }
    this.permits = permits;
    logger.debug(`Semaphore created with ${permits} permits`);
  }

  /**
   * Acquire a permit from the semaphore
   * If no permits are available, the caller will wait until one becomes available
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      logger.debug(`Semaphore permit acquired, ${this.permits} remaining`);
      return;
    }

    logger.debug(
      `Semaphore permit requested, waiting in queue (${this.waiting.length} waiting)`,
    );
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /**
   * Release a permit back to the semaphore
   * This will allow waiting operations to proceed
   */
  release(): void {
    this.permits++;
    logger.debug(`Semaphore permit released, ${this.permits} available`);

    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      this.permits--;
      logger.debug(
        `Semaphore permit granted to waiting operation, ${this.permits} remaining`,
      );
      resolve();
    }
  }

  /**
   * Get the number of available permits
   */
  getAvailablePermits(): number {
    return this.permits;
  }

  /**
   * Get the number of operations waiting for permits
   */
  getWaitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Get semaphore status for debugging
   */
  getStatus(): { available: number; waiting: number } {
    return {
      available: this.permits,
      waiting: this.waiting.length,
    };
  }
}

/**
 * Token Budget Manager for controlling AI token usage across parallel batches
 * Ensures that the total token usage doesn't exceed the configured limits
 */
export class TokenBudgetManager implements TokenBudgetManagerInterface {
  private totalBudget: number;
  private usedTokens: number = 0;
  private batchAllocations: Map<number, number> = new Map();
  private reservedTokens: number = 0; // Tokens allocated but not yet used

  constructor(totalBudget: number) {
    if (totalBudget <= 0) {
      throw new Error("Token budget must be greater than 0");
    }
    this.totalBudget = totalBudget;
    logger.debug(
      `TokenBudgetManager created with budget of ${totalBudget} tokens`,
    );
  }

  /**
   * Allocate tokens for a specific batch
   * Returns true if allocation was successful, false if insufficient budget
   */
  allocateForBatch(batchIndex: number, estimatedTokens: number): boolean {
    if (estimatedTokens <= 0) {
      logger.warn(
        `Invalid token estimate for batch ${batchIndex}: ${estimatedTokens}`,
      );
      return false;
    }

    // Check if we already have an allocation for this batch
    if (this.batchAllocations.has(batchIndex)) {
      logger.warn(`Batch ${batchIndex} already has token allocation`);
      return false;
    }

    // Check if we have enough budget
    const totalAllocated =
      this.usedTokens + this.reservedTokens + estimatedTokens;
    if (totalAllocated > this.totalBudget) {
      logger.debug(
        `Insufficient token budget for batch ${batchIndex}: ` +
          `need ${estimatedTokens}, available ${this.getAvailableBudget()}`,
      );
      return false;
    }

    // Allocate the tokens
    this.reservedTokens += estimatedTokens;
    this.batchAllocations.set(batchIndex, estimatedTokens);

    logger.debug(
      `Allocated ${estimatedTokens} tokens for batch ${batchIndex} ` +
        `(${this.getAvailableBudget()} remaining)`,
    );

    return true;
  }

  /**
   * Release tokens allocated to a batch
   * This should be called when a batch completes (successfully or with error)
   */
  releaseBatch(batchIndex: number): void {
    const allocated = this.batchAllocations.get(batchIndex);
    if (!allocated) {
      logger.warn(`No token allocation found for batch ${batchIndex}`);
      return;
    }

    // Move from reserved to used (assuming the tokens were actually used)
    this.reservedTokens -= allocated;
    this.usedTokens += allocated;
    this.batchAllocations.delete(batchIndex);

    logger.debug(
      `Released ${allocated} tokens from batch ${batchIndex} ` +
        `(${this.getAvailableBudget()} now available)`,
    );
  }

  /**
   * Get the available token budget (not yet allocated or used)
   */
  getAvailableBudget(): number {
    return this.totalBudget - this.usedTokens - this.reservedTokens;
  }

  /**
   * Get the total token budget
   */
  getTotalBudget(): number {
    return this.totalBudget;
  }

  /**
   * Get the number of tokens actually used (completed batches)
   */
  getUsedTokens(): number {
    return this.usedTokens;
  }

  /**
   * Get the number of tokens reserved (allocated but not yet used)
   */
  getReservedTokens(): number {
    return this.reservedTokens;
  }

  /**
   * Get the number of active batch allocations
   */
  getActiveBatches(): number {
    return this.batchAllocations.size;
  }

  /**
   * Get detailed budget status for monitoring
   */
  getBudgetStatus(): {
    total: number;
    used: number;
    reserved: number;
    available: number;
    activeBatches: number;
    utilizationPercent: number;
  } {
    const utilizationPercent =
      ((this.usedTokens + this.reservedTokens) / this.totalBudget) * 100;

    return {
      total: this.totalBudget,
      used: this.usedTokens,
      reserved: this.reservedTokens,
      available: this.getAvailableBudget(),
      activeBatches: this.batchAllocations.size,
      utilizationPercent: Math.round(utilizationPercent * 100) / 100,
    };
  }

  /**
   * Reset the budget manager (for testing or reuse)
   */
  reset(): void {
    this.usedTokens = 0;
    this.reservedTokens = 0;
    this.batchAllocations.clear();
    logger.debug("TokenBudgetManager reset");
  }

  /**
   * Update the total budget (useful for dynamic adjustment)
   */
  updateBudget(newBudget: number): void {
    if (newBudget <= 0) {
      throw new Error("Token budget must be greater than 0");
    }

    const oldBudget = this.totalBudget;
    this.totalBudget = newBudget;

    logger.debug(`Token budget updated from ${oldBudget} to ${newBudget}`);

    // Log warning if new budget is less than current usage
    if (newBudget < this.usedTokens + this.reservedTokens) {
      logger.warn(
        `New budget (${newBudget}) is less than current usage (${this.usedTokens + this.reservedTokens})`,
      );
    }
  }
}

/**
 * Factory function to create a Semaphore with validation
 */
export function createSemaphore(permits: number): Semaphore {
  return new Semaphore(permits);
}

/**
 * Factory function to create a TokenBudgetManager with validation
 */
export function createTokenBudgetManager(
  totalBudget: number,
): TokenBudgetManager {
  return new TokenBudgetManager(totalBudget);
}

/**
 * Utility function to calculate optimal concurrency based on available resources
 */
export function calculateOptimalConcurrency(
  totalBatches: number,
  maxConcurrent: number,
  averageTokensPerBatch: number,
  totalTokenBudget: number,
): number {
  // Don't exceed the configured maximum
  let optimal = Math.min(maxConcurrent, totalBatches);

  // Don't exceed what the token budget can support
  const tokenBasedLimit = Math.floor(totalTokenBudget / averageTokensPerBatch);
  optimal = Math.min(optimal, tokenBasedLimit);

  // Ensure at least 1
  optimal = Math.max(1, optimal);

  logger.debug(
    `Calculated optimal concurrency: ${optimal} ` +
      `(max: ${maxConcurrent}, batches: ${totalBatches}, token-limited: ${tokenBasedLimit})`,
  );

  return optimal;
}
