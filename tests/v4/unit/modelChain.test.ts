import {
  ModelChainError,
  describeChain,
  memberAt,
  normalizeModelChain,
  resolveSlot,
} from "../../../src/v4/config/ModelChain.js";

describe("normalizeModelChain — the five normalization rules", () => {
  it("scalar provider + scalar model yields one member (v3 configs unchanged)", () => {
    const chain = normalizeModelChain({
      provider: "vertex",
      model: "claude-sonnet-4-6",
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "claude-sonnet-4-6" },
    ]);
    expect(chain.pool.maxAttempts).toBe(1);
  });

  it("equal-length arrays pair by position", () => {
    const chain = normalizeModelChain({
      provider: ["vertex", "litellm", "anthropic"],
      model: ["claude-sonnet-4-6", "glm-4.6", "claude-opus-4-1"],
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "claude-sonnet-4-6" },
      { provider: "litellm", model: "glm-4.6" },
      { provider: "anthropic", model: "claude-opus-4-1" },
    ]);
  });

  it("one provider with many models broadcasts the provider", () => {
    const chain = normalizeModelChain({
      provider: "vertex",
      model: ["claude-sonnet-4-6", "gemini-2.5-pro"],
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "claude-sonnet-4-6" },
      { provider: "vertex", model: "gemini-2.5-pro" },
    ]);
  });

  it("many providers with one model broadcasts the model", () => {
    const chain = normalizeModelChain({
      provider: ["vertex", "litellm"],
      model: "claude-sonnet-4-6",
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "claude-sonnet-4-6" },
      { provider: "litellm", model: "claude-sonnet-4-6" },
    ]);
  });

  it("repeats a provider with different models — members are independent", () => {
    const chain = normalizeModelChain({
      provider: ["vertex", "vertex", "litellm"],
      model: ["claude-sonnet-4-6", "gemini-2.5-pro", "glm-4.6"],
    });
    expect(chain.members).toHaveLength(3);
    expect(chain.members[0]).toEqual({
      provider: "vertex",
      model: "claude-sonnet-4-6",
    });
    expect(chain.members[1]).toEqual({
      provider: "vertex",
      model: "gemini-2.5-pro",
    });
  });

  it("providers with no model at all are allowed (provider default model)", () => {
    const chain = normalizeModelChain({ provider: ["vertex", "litellm"] });
    expect(chain.members).toEqual([
      { provider: "vertex" },
      { provider: "litellm" },
    ]);
  });
});

describe("normalizeModelChain — loud failures", () => {
  it("rejects mismatched array lengths and names both counts plus the fix", () => {
    expect(() =>
      normalizeModelChain(
        { provider: ["vertex", "litellm", "anthropic"], model: ["a", "b"] },
        "ai.review",
      ),
    ).toThrow(/ai\.review\.provider has 3 entries but ai\.review\.model has 2/);
    expect(() =>
      normalizeModelChain({ provider: ["a", "b", "c"], model: ["x", "y"] }),
    ).toThrow(/ai\.fallback/);
  });

  it("rejects a missing provider", () => {
    expect(() => normalizeModelChain({ model: "gpt" }, "ai.judge")).toThrow(
      /ai\.judge\.provider is required/,
    );
  });

  it("rejects an empty entry rather than silently dropping it", () => {
    expect(() =>
      normalizeModelChain({ provider: ["vertex", "  "] }, "ai"),
    ).toThrow(/ai\.provider\[1\] is empty/);
  });

  it("rejects an unconfigured slot", () => {
    expect(() => normalizeModelChain(undefined, "ai.scorecard")).toThrow(
      ModelChainError,
    );
  });

  it("rejects a non-positive weight", () => {
    expect(() =>
      normalizeModelChain({
        fallback: [{ provider: "vertex", model: "a", weight: 0 }],
      }),
    ).toThrow(/weight must be greater than 0/);
  });

  it("rejects an empty explicit fallback list", () => {
    expect(() => normalizeModelChain({ fallback: [] })).toThrow(
      /non-empty list/,
    );
  });
});

describe("normalizeModelChain — explicit fallback form", () => {
  it("takes precedence over provider/model and carries region and weight", () => {
    const chain = normalizeModelChain({
      provider: ["ignored"],
      model: ["ignored"],
      fallback: [
        { provider: "vertex", model: "claude-sonnet-4-6" },
        {
          provider: "litellm",
          model: "glm-4.6",
          region: "asia-south1",
          weight: 2,
        },
      ],
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "claude-sonnet-4-6" },
      {
        provider: "litellm",
        model: "glm-4.6",
        region: "asia-south1",
        weight: 2,
      },
    ]);
  });
});

describe("normalizeModelChain — pool settings", () => {
  it("defaults to priority strategy and a 60s cooldown", () => {
    const chain = normalizeModelChain({ provider: "vertex" });
    expect(chain.pool.strategy).toBe("priority");
    expect(chain.pool.cooldownMs).toBe(60_000);
  });

  it("defaults maxAttempts to the member count", () => {
    const chain = normalizeModelChain({ provider: ["a", "b", "c"] });
    expect(chain.pool.maxAttempts).toBe(3);
  });

  it("honours explicit pool settings", () => {
    const chain = normalizeModelChain({
      provider: ["a", "b"],
      pool: { strategy: "weighted", cooldownMs: 5_000, maxAttempts: 7 },
    });
    expect(chain.pool).toEqual({
      strategy: "weighted",
      cooldownMs: 5_000,
      maxAttempts: 7,
    });
  });

  it("clamps a nonsensical maxAttempts to at least one", () => {
    const chain = normalizeModelChain({
      provider: "vertex",
      pool: { maxAttempts: 0 },
    });
    expect(chain.pool.maxAttempts).toBe(1);
  });
});

describe("normalizeModelChain — duplicate members", () => {
  it("drops an exact repeat so attempts are not spent on a known-down candidate", () => {
    const chain = normalizeModelChain({
      provider: ["vertex", "litellm", "vertex"],
      model: ["a", "b", "a"],
    });
    expect(chain.members).toEqual([
      { provider: "vertex", model: "a" },
      { provider: "litellm", model: "b" },
    ]);
    expect(chain.pool.maxAttempts).toBe(2);
  });

  it("keeps same provider+model when the region differs", () => {
    const chain = normalizeModelChain({
      fallback: [
        { provider: "vertex", model: "a", region: "us-central1" },
        { provider: "vertex", model: "a", region: "asia-south1" },
      ],
    });
    expect(chain.members).toHaveLength(2);
  });
});

describe("resolveSlot", () => {
  const base = normalizeModelChain({
    provider: ["vertex", "litellm"],
    model: ["claude-sonnet-4-6", "glm-4.6"],
    temperature: 0.2,
  });

  it("inherits the base chain when the slot is unset", () => {
    expect(resolveSlot(base, undefined, "ai.judge")).toBe(base);
  });

  it("inherits members but overrides call knobs when only knobs are given", () => {
    const slot = resolveSlot(
      base,
      { temperature: 0, maxTokens: 8_000 },
      "ai.judge",
    );
    expect(slot.members).toEqual(base.members);
    expect(slot.temperature).toBe(0);
    expect(slot.maxTokens).toBe(8_000);
  });

  it("replaces the chain entirely when the slot declares its own members", () => {
    const slot = resolveSlot(
      base,
      { provider: "vertex", model: "gemini-2.5-flash" },
      "ai.compaction",
    );
    expect(slot.members).toEqual([
      { provider: "vertex", model: "gemini-2.5-flash" },
    ]);
    expect(slot.temperature).toBeUndefined();
  });

  it("reports the slot path when an override is malformed", () => {
    expect(() =>
      resolveSlot(base, { provider: ["a", "b"], model: ["x"] }, "ai.subAgent"),
    ).not.toThrow();
    expect(() =>
      resolveSlot(
        base,
        { provider: ["a", "b", "c"], model: ["x", "y"] },
        "ai.subAgent",
      ),
    ).toThrow(/ai\.subAgent\.provider has 3 entries/);
  });
});

describe("helpers", () => {
  it("memberAt returns the head by default and undefined past the end", () => {
    const chain = normalizeModelChain({ provider: ["a", "b"] });
    expect(memberAt(chain)).toEqual({ provider: "a" });
    expect(memberAt(chain, 1)).toEqual({ provider: "b" });
    expect(memberAt(chain, 9)).toBeUndefined();
  });

  it("describeChain renders the fallback order for doctor output", () => {
    const chain = normalizeModelChain({
      fallback: [
        { provider: "vertex", model: "claude-sonnet-4-6" },
        { provider: "litellm", model: "glm-4.6", region: "asia-south1" },
      ],
    });
    expect(describeChain(chain)).toBe(
      "vertex/claude-sonnet-4-6 → litellm/glm-4.6/asia-south1",
    );
  });
});
