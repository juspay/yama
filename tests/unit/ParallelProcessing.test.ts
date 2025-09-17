/**
 * Tests for Parallel Processing Utilities
 */

import {
  Semaphore,
  TokenBudgetManager,
  calculateOptimalConcurrency,
} from "../../src/utils/ParallelProcessing.js";

describe("ParallelProcessing", () => {
  describe("Semaphore", () => {
    it("should create semaphore with correct permits", () => {
      const semaphore = new Semaphore(3);
      expect(semaphore.getAvailablePermits()).toBe(3);
    });

    it("should throw error for invalid permits", () => {
      expect(() => new Semaphore(0)).toThrow(
        "Semaphore permits must be greater than 0",
      );
      expect(() => new Semaphore(-1)).toThrow(
        "Semaphore permits must be greater than 0",
      );
    });

    it("should acquire and release permits correctly", async () => {
      const semaphore = new Semaphore(2);

      // Acquire first permit
      await semaphore.acquire();
      expect(semaphore.getAvailablePermits()).toBe(1);

      // Acquire second permit
      await semaphore.acquire();
      expect(semaphore.getAvailablePermits()).toBe(0);

      // Release one permit
      semaphore.release();
      expect(semaphore.getAvailablePermits()).toBe(1);

      // Release second permit
      semaphore.release();
      expect(semaphore.getAvailablePermits()).toBe(2);
    });

    it("should handle waiting queue correctly", async () => {
      const semaphore = new Semaphore(1);

      // Acquire the only permit
      await semaphore.acquire();
      expect(semaphore.getAvailablePermits()).toBe(0);

      // Try to acquire another permit (should wait)
      let secondAcquireResolved = false;
      const secondAcquire = semaphore.acquire().then(() => {
        secondAcquireResolved = true;
      });

      // Should not resolve immediately
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondAcquireResolved).toBe(false);
      expect(semaphore.getWaitingCount()).toBe(1);

      // Release permit - should allow waiting operation to proceed
      semaphore.release();
      await secondAcquire;
      expect(secondAcquireResolved).toBe(true);
      expect(semaphore.getAvailablePermits()).toBe(0);
    });

    it("should provide correct status", () => {
      const semaphore = new Semaphore(3);
      const status = semaphore.getStatus();
      expect(status.available).toBe(3);
      expect(status.waiting).toBe(0);
    });
  });

  describe("TokenBudgetManager", () => {
    it("should create budget manager with correct budget", () => {
      const manager = new TokenBudgetManager(10000);
      expect(manager.getTotalBudget()).toBe(10000);
      expect(manager.getAvailableBudget()).toBe(10000);
      expect(manager.getUsedTokens()).toBe(0);
    });

    it("should throw error for invalid budget", () => {
      expect(() => new TokenBudgetManager(0)).toThrow(
        "Token budget must be greater than 0",
      );
      expect(() => new TokenBudgetManager(-100)).toThrow(
        "Token budget must be greater than 0",
      );
    });

    it("should allocate and release tokens correctly", () => {
      const manager = new TokenBudgetManager(10000);

      // Allocate tokens for batch 0
      const allocated = manager.allocateForBatch(0, 3000);
      expect(allocated).toBe(true);
      expect(manager.getAvailableBudget()).toBe(7000);
      expect(manager.getReservedTokens()).toBe(3000);
      expect(manager.getActiveBatches()).toBe(1);

      // Release tokens for batch 0
      manager.releaseBatch(0);
      expect(manager.getAvailableBudget()).toBe(7000); // Used tokens = 3000
      expect(manager.getReservedTokens()).toBe(0);
      expect(manager.getUsedTokens()).toBe(3000);
      expect(manager.getActiveBatches()).toBe(0);
    });

    it("should reject allocation when insufficient budget", () => {
      const manager = new TokenBudgetManager(5000);

      // Allocate most of the budget
      const allocated1 = manager.allocateForBatch(0, 4000);
      expect(allocated1).toBe(true);

      // Try to allocate more than remaining budget
      const allocated2 = manager.allocateForBatch(1, 2000);
      expect(allocated2).toBe(false);
      expect(manager.getActiveBatches()).toBe(1);
    });

    it("should handle multiple concurrent allocations", () => {
      const manager = new TokenBudgetManager(10000);

      // Allocate for multiple batches
      expect(manager.allocateForBatch(0, 2000)).toBe(true);
      expect(manager.allocateForBatch(1, 3000)).toBe(true);
      expect(manager.allocateForBatch(2, 2000)).toBe(true);

      expect(manager.getAvailableBudget()).toBe(3000);
      expect(manager.getReservedTokens()).toBe(7000);
      expect(manager.getActiveBatches()).toBe(3);

      // Release one batch
      manager.releaseBatch(1);
      expect(manager.getAvailableBudget()).toBe(3000); // Still 3000 available, 3000 used, 4000 reserved
      expect(manager.getReservedTokens()).toBe(4000);
      expect(manager.getUsedTokens()).toBe(3000);
      expect(manager.getActiveBatches()).toBe(2);
    });

    it("should provide detailed budget status", () => {
      const manager = new TokenBudgetManager(10000);
      manager.allocateForBatch(0, 3000);
      manager.allocateForBatch(1, 2000);

      const status = manager.getBudgetStatus();
      expect(status.total).toBe(10000);
      expect(status.used).toBe(0);
      expect(status.reserved).toBe(5000);
      expect(status.available).toBe(5000);
      expect(status.activeBatches).toBe(2);
      expect(status.utilizationPercent).toBe(50);
    });

    it("should handle invalid allocations gracefully", () => {
      const manager = new TokenBudgetManager(10000);

      // Invalid token amount
      expect(manager.allocateForBatch(0, 0)).toBe(false);
      expect(manager.allocateForBatch(1, -100)).toBe(false);

      // Duplicate batch allocation
      expect(manager.allocateForBatch(2, 1000)).toBe(true);
      expect(manager.allocateForBatch(2, 1000)).toBe(false);
    });

    it("should reset correctly", () => {
      const manager = new TokenBudgetManager(10000);
      manager.allocateForBatch(0, 3000);
      manager.releaseBatch(0);

      manager.reset();
      expect(manager.getUsedTokens()).toBe(0);
      expect(manager.getReservedTokens()).toBe(0);
      expect(manager.getActiveBatches()).toBe(0);
      expect(manager.getAvailableBudget()).toBe(10000);
    });

    it("should update budget correctly", () => {
      const manager = new TokenBudgetManager(10000);
      manager.allocateForBatch(0, 3000);

      manager.updateBudget(15000);
      expect(manager.getTotalBudget()).toBe(15000);
      expect(manager.getAvailableBudget()).toBe(12000);

      // Should warn if new budget is less than current usage
      manager.updateBudget(2000);
      expect(manager.getTotalBudget()).toBe(2000);
      expect(manager.getAvailableBudget()).toBe(-1000); // Negative available budget
    });
  });

  describe("calculateOptimalConcurrency", () => {
    it("should calculate optimal concurrency correctly", () => {
      // Normal case
      const optimal1 = calculateOptimalConcurrency(10, 5, 1000, 10000);
      expect(optimal1).toBe(5); // Limited by maxConcurrent

      // Token budget limited
      const optimal2 = calculateOptimalConcurrency(10, 5, 3000, 6000);
      expect(optimal2).toBe(2); // Limited by token budget (6000 / 3000 = 2)

      // Batch count limited
      const optimal3 = calculateOptimalConcurrency(2, 5, 1000, 10000);
      expect(optimal3).toBe(2); // Limited by total batches

      // Ensure minimum of 1
      const optimal4 = calculateOptimalConcurrency(10, 5, 20000, 10000);
      expect(optimal4).toBe(1); // Token budget allows 0, but minimum is 1
    });

    it("should handle edge cases", () => {
      // Zero batches
      const optimal1 = calculateOptimalConcurrency(0, 5, 1000, 10000);
      expect(optimal1).toBe(1); // Minimum is always 1

      // Very large token budget
      const optimal2 = calculateOptimalConcurrency(100, 3, 100, 1000000);
      expect(optimal2).toBe(3); // Limited by maxConcurrent

      // Very small token budget
      const optimal3 = calculateOptimalConcurrency(10, 5, 1000, 500);
      expect(optimal3).toBe(1); // Token budget allows 0, but minimum is 1
    });
  });
});
