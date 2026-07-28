/**
 * DefaultConfig — locks the bounded-by-work (not time) review defaults.
 */

import { describe, it, expect } from "@jest/globals";
import { DefaultConfig } from "../../../src/v2/config/DefaultConfig.js";

describe("DefaultConfig", () => {
  it("sets no default review wall clock — the loop is bounded by steps, not time", () => {
    const config = DefaultConfig.get();
    expect(config.performance.maxReviewDuration).toBeUndefined();
    expect(config.performance.loop?.turnTimeoutMs).toBeUndefined();
    // Hang protection stays: per-tool timeout and a step ceiling.
    expect(config.performance.loop?.maxSteps).toBe(100);
    expect(config.performance.loop?.toolTimeoutMs).toBe(300_000);
  });

  it("enables the per-run report artifact by default", () => {
    const config = DefaultConfig.get();
    expect(config.monitoring.report?.enabled).toBe(true);
    expect(config.monitoring.report?.path).toBe(".yama/reports");
  });
});
