import {
  SLOT_ENFORCEMENT,
  buildInstanceConfig,
  describeSlotEnforcement,
  probeChain,
  resolveModelChains,
  toModelPool,
} from "../../../src/v4/core/NeurolinkFactory.js";
import { normalizeModelChain } from "../../../src/v4/config/ModelChain.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type { ResolvedConfig } from "../../../src/v4/types/index.js";

function configWith(ai: ResolvedConfig["ai"]): ResolvedConfig {
  return {
    version: 4,
    ai,
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...optionalDefaults(),
  } as ResolvedConfig;
}

describe("resolveModelChains", () => {
  it("gives every slot the base chain when none override", () => {
    const chains = resolveModelChains(
      configWith({ provider: ["vertex", "litellm"], model: ["a", "b"] }),
    );
    expect(chains.review.members).toEqual(chains.base.members);
    expect(chains.judge.members).toEqual(chains.base.members);
    expect(chains.compaction.members).toEqual(chains.base.members);
  });

  it("lets a slot declare its own chain", () => {
    const chains = resolveModelChains(
      configWith({
        provider: "vertex",
        model: "big",
        judge: { provider: ["vertex", "litellm"], model: ["small", "tiny"] },
      }),
    );
    expect(chains.review.members).toEqual([
      { provider: "vertex", model: "big" },
    ]);
    expect(chains.judge.members).toEqual([
      { provider: "vertex", model: "small" },
      { provider: "litellm", model: "tiny" },
    ]);
  });

  it("lets a slot tune only the call knobs and inherit the chain", () => {
    const chains = resolveModelChains(
      configWith({
        provider: ["vertex", "litellm"],
        model: ["a", "b"],
        temperature: 0.3,
        judge: { temperature: 0 },
      }),
    );
    expect(chains.judge.members).toEqual(chains.base.members);
    expect(chains.judge.temperature).toBe(0);
    expect(chains.review.temperature).toBe(0.3);
  });
});

describe("toModelPool", () => {
  it("maps a chain onto NeuroLink's pool shape", () => {
    const pool = toModelPool(
      normalizeModelChain({
        fallback: [
          { provider: "vertex", model: "a", region: "us-central1" },
          { provider: "litellm", model: "b", weight: 2 },
        ],
        pool: { strategy: "weighted", cooldownMs: 30_000 },
      }),
    );
    expect(pool).toEqual({
      members: [
        { provider: "vertex", model: "a", region: "us-central1" },
        { provider: "litellm", model: "b", weight: 2 },
      ],
      strategy: "weighted",
      cooldownMs: 30_000,
      maxAttempts: 2,
    });
  });

  it("omits absent optional fields rather than sending undefined", () => {
    const pool = toModelPool(normalizeModelChain({ provider: "vertex" }));
    expect(pool.members).toEqual([{ provider: "vertex" }]);
  });
});

describe("probeChain", () => {
  const chain = normalizeModelChain({
    provider: ["a", "b", "c"],
    model: ["x", "y", "z"],
  });

  it("returns the first reachable member", async () => {
    const result = await probeChain(
      chain,
      async (member) => member.provider === "b",
    );
    expect(result).toEqual({ index: 1, healthy: true });
  });

  it("stops probing once one succeeds", async () => {
    const probed: string[] = [];
    await probeChain(chain, async (member) => {
      probed.push(member.provider);
      return true;
    });
    expect(probed).toEqual(["a"]);
  });

  it("treats a throwing probe as a failed probe, not a failed run", async () => {
    const result = await probeChain(chain, async (member) => {
      if (member.provider === "a") {
        throw new Error("network down");
      }
      return member.provider === "c";
    });
    expect(result).toEqual({ index: 2, healthy: true });
  });

  it("falls back to the head and reports unhealthy when nothing responds", async () => {
    const result = await probeChain(chain, async () => false);
    expect(result).toEqual({ index: 0, healthy: false });
  });
});

describe("buildInstanceConfig", () => {
  const config = configWith({
    provider: ["vertex", "litellm"],
    model: ["big", "backup"],
    compaction: { provider: ["vertex", "litellm"], model: ["flash", "glm"] },
  });
  const chains = resolveModelChains(config);

  it("wires the slot's chain as the instance modelPool", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
    });
    const pool = instance.modelPool as { members: unknown[] };
    expect(pool.members).toEqual([
      { provider: "vertex", model: "big" },
      { provider: "litellm", model: "backup" },
    ]);
  });

  it("defers tool schemas and keeps bash off by default", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
    });
    expect(instance.tools).toEqual({ discovery: true, enableBashTool: false });
  });

  it("externalizes oversized tool output instead of flooding context", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
    });
    const mcp = instance.mcp as { outputLimits: { strategy: string } };
    expect(mcp.outputLimits.strategy).toBe("externalize");
  });

  it("maps the compaction chain onto the summarization pair, which compaction uses", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
    });
    const memory = instance.conversationMemory as Record<string, unknown>;
    expect(memory.summarizationProvider).toBe("vertex");
    expect(memory.summarizationModel).toBe("flash");
    expect(memory.contextCompaction).toEqual({ enabled: true, threshold: 0.8 });
  });

  it("uses the probed member index for the probe-only compaction slot", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
      compactionMemberIndex: 1,
    });
    const memory = instance.conversationMemory as Record<string, unknown>;
    expect(memory.summarizationProvider).toBe("litellm");
    expect(memory.summarizationModel).toBe("glm");
  });

  it("disables conversation memory entirely for stateless instances", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "judge",
      conversationMemory: false,
    });
    expect(instance.conversationMemory).toEqual({ enabled: false });
  });

  it("omits the memory SDK unless a memory slot was configured", () => {
    const instance = buildInstanceConfig({
      chains,
      config,
      slot: "review",
      conversationMemory: true,
    });
    const memory = instance.conversationMemory as Record<string, unknown>;
    expect(memory.memory).toBeUndefined();
  });

  it("wires the memory slot when one is configured", () => {
    const withMemory = configWith({
      provider: "vertex",
      model: "big",
      memory: { provider: "vertex", model: "flash" },
    });
    const instance = buildInstanceConfig({
      chains: resolveModelChains(withMemory),
      config: withMemory,
      slot: "review",
      conversationMemory: true,
    });
    const memory = instance.conversationMemory as Record<string, unknown>;
    expect(memory.memory).toEqual({
      enabled: true,
      neurolink: { provider: "vertex", model: "flash" },
    });
  });
});

describe("slot enforcement reporting", () => {
  it("marks compaction and memory as probe-only, everything else pooled", () => {
    expect(SLOT_ENFORCEMENT.review).toBe("pool");
    expect(SLOT_ENFORCEMENT.subAgent).toBe("pool");
    expect(SLOT_ENFORCEMENT.compaction).toBe("probe");
    expect(SLOT_ENFORCEMENT.memory).toBe("probe");
  });

  it("describes every slot for doctor output", () => {
    const rows = describeSlotEnforcement(
      resolveModelChains(
        configWith({ provider: ["vertex", "litellm"], model: ["a", "b"] }),
      ),
    );
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.slot === "review")).toEqual({
      slot: "review",
      enforcement: "pool",
      chain: "vertex/a → litellm/b",
    });
  });
});
