/**
 * Retry Manager for Yama
 * Provides intelligent retry logic with exponential backoff for handling transient failures
 */

import { logger } from "./Logger.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterMs?: number;
  retryableErrors?: string[];
}

export interface RetryContext {
  operation: string;
  attempt: number;
  maxAttempts: number;
  lastError?: Error;
  totalElapsed: number;
}

export class RetryManager {
  private static readonly DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2.0,
    jitterMs: 100,
    retryableErrors: [
      "provider_error",
      "network",
      "timeout",
      "connection",
      "econnreset",
      "etimedout",
      "enotfound",
      "econnrefused",
      "socket hang up",
      "request timeout",
      "service unavailable",
      "bad gateway",
      "gateway timeout",
      "temporary failure",
      "rate limit",
    ],
  };

  /**
   * Execute an operation with retry logic
   */
  static async withRetry<T>(
    operation: () => Promise<T>,
    context: string,
    options: RetryOptions = {},
  ): Promise<T> {
    const opts = { ...RetryManager.DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      try {
        const result = await operation();

        if (attempt > 1) {
          const elapsed = Date.now() - startTime;
          logger.info(
            `${context} succeeded on attempt ${attempt} after ${elapsed}ms`,
          );
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        const isLastAttempt = attempt === opts.maxAttempts;
        const isRetryable = RetryManager.isRetryableError(
          lastError,
          opts.retryableErrors,
        );
        const elapsed = Date.now() - startTime;

        const retryContext: RetryContext = {
          operation: context,
          attempt,
          maxAttempts: opts.maxAttempts,
          lastError,
          totalElapsed: elapsed,
        };

        if (isLastAttempt || !isRetryable) {
          if (isLastAttempt) {
            logger.error(
              `${context} failed after ${opts.maxAttempts} attempts (${elapsed}ms total):`,
              lastError,
            );
          } else {
            logger.error(
              `${context} failed with non-retryable error:`,
              lastError,
            );
          }
          throw lastError;
        }

        const delay = RetryManager.calculateDelay(attempt, opts);
        logger.warn(
          `${context} failed (attempt ${attempt}/${opts.maxAttempts}), retrying in ${delay}ms:`,
          lastError.message,
        );

        await RetryManager.sleep(delay);
      }
    }

    // This should never be reached, but TypeScript requires it
    throw (
      lastError ||
      new Error(`${context} failed after ${opts.maxAttempts} attempts`)
    );
  }

  /**
   * Check if an error is retryable based on error patterns
   */
  private static isRetryableError(
    error: Error,
    retryablePatterns: string[],
  ): boolean {
    if (!error) {
      return false;
    }

    const errorMessage = error.message?.toLowerCase() || "";
    const errorCode = (error as any).code?.toLowerCase() || "";
    const errorName = error.name?.toLowerCase() || "";

    // Check if any retryable pattern matches the error
    return retryablePatterns.some((pattern) => {
      const lowerPattern = pattern.toLowerCase();
      return (
        errorMessage.includes(lowerPattern) ||
        errorCode.includes(lowerPattern) ||
        errorName.includes(lowerPattern)
      );
    });
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private static calculateDelay(
    attempt: number,
    options: Required<RetryOptions>,
  ): number {
    // Exponential backoff: baseDelay * (multiplier ^ (attempt - 1))
    const exponentialDelay =
      options.baseDelayMs * Math.pow(options.backoffMultiplier, attempt - 1);

    // Apply maximum delay cap
    const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * options.jitterMs;

    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Sleep for specified milliseconds
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create a retry wrapper function for a specific operation
   */
  static createRetryWrapper<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    context: string,
    options: RetryOptions = {},
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      return RetryManager.withRetry(() => fn(...args), context, options);
    };
  }

  /**
   * Batch retry operations with individual retry logic
   */
  static async batchWithRetry<T>(
    operations: Array<{ fn: () => Promise<T>; context: string }>,
    options: RetryOptions & { continueOnError?: boolean } = {},
  ): Promise<
    Array<{ success: boolean; data?: T; error?: Error; context: string }>
  > {
    const { continueOnError = true, ...retryOptions } = options;
    const results: Array<{
      success: boolean;
      data?: T;
      error?: Error;
      context: string;
    }> = [];

    for (const { fn, context } of operations) {
      try {
        const data = await RetryManager.withRetry(fn, context, retryOptions);
        results.push({ success: true, data, context });
      } catch (error) {
        const err = error as Error;
        results.push({ success: false, error: err, context });

        if (!continueOnError) {
          throw error;
        }
      }
    }

    return results;
  }

  /**
   * Get retry statistics for monitoring
   */
  static getRetryStats(results: Array<{ success: boolean; context: string }>): {
    total: number;
    successful: number;
    failed: number;
    successRate: number;
    failuresByContext: Record<string, number>;
  } {
    const total = results.length;
    const successful = results.filter((r) => r.success).length;
    const failed = total - successful;
    const successRate = total > 0 ? successful / total : 0;

    const failuresByContext: Record<string, number> = {};
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        failuresByContext[r.context] = (failuresByContext[r.context] || 0) + 1;
      });

    return {
      total,
      successful,
      failed,
      successRate,
      failuresByContext,
    };
  }

  /**
   * Create a circuit breaker pattern (simple implementation)
   */
  static createCircuitBreaker<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    context: string,
    options: {
      failureThreshold?: number;
      recoveryTimeoutMs?: number;
      retryOptions?: RetryOptions;
    } = {},
  ): (...args: T) => Promise<R> {
    const {
      failureThreshold = 5,
      recoveryTimeoutMs = 30000,
      retryOptions = {},
    } = options;

    let failureCount = 0;
    let lastFailureTime = 0;
    let state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED";

    return async (...args: T): Promise<R> => {
      const now = Date.now();

      // Check if we should attempt recovery
      if (state === "OPEN" && now - lastFailureTime > recoveryTimeoutMs) {
        state = "HALF_OPEN";
        logger.debug(`Circuit breaker for ${context} entering HALF_OPEN state`);
      }

      // Reject immediately if circuit is open
      if (state === "OPEN") {
        throw new Error(
          `Circuit breaker OPEN for ${context} (${failureCount} failures)`,
        );
      }

      try {
        const result = await RetryManager.withRetry(
          () => fn(...args),
          context,
          retryOptions,
        );

        // Success - reset circuit breaker
        if (state === "HALF_OPEN") {
          state = "CLOSED";
          failureCount = 0;
          logger.info(
            `Circuit breaker for ${context} recovered to CLOSED state`,
          );
        }

        return result;
      } catch (error) {
        failureCount++;
        lastFailureTime = now;

        if (failureCount >= failureThreshold) {
          state = "OPEN";
          logger.error(
            `Circuit breaker OPEN for ${context} after ${failureCount} failures`,
          );
        }

        throw error;
      }
    };
  }
}
