import {
  SessionRunner,
  isEmptyTurn,
  normalizeTurn,
  type GenerateHost,
  type GenerateResponse,
} from "../../../src/v4/core/SessionRunner.js";
import { createRunContext } from "../../../src/v4/core/RunContext.js";
import { normalizeModelChain } from "../../../src/v4/config/ModelChain.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  ResolvedConfig,
  RunIdentity,
  SessionOptions,
} from "../../../src/v4/types/index.js";
import type { YamaTool } from "../../../src/v4/tools/registry.js";

const identity: RunIdentity = {
  provider: "github",
  owner: "juspay",
  repo: "yama",
  pullRequestId: 1,
};

function config(deadline?: string): ResolvedConfig {
  const defaults = optionalDefaults();
  return {
    version: 4,
    ai: { provider: "vertex", model: "big" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...defaults,
    review: { ...defaults.review, ...(deadline ? { deadline } : {}) },
  } as ResolvedConfig;
}

class FakeHost implements GenerateHost {
  calls: Array<Record<string, unknown>> = [];
  registered: string[] = [];
  unregistered: string[] = [];
  toolContext?: Record<string, unknown>;

  // A turn with content: an entirely empty response now means "this model
  // produced nothing", which is a failover trigger, not a normal turn.
  constructor(
    private readonly responses: GenerateResponse[] = [{ content: "done" }],
  ) {}

  async generate(options: Record<string, unknown>) {
    this.calls.push(options);
    return this.responses[
      Math.min(this.calls.length - 1, this.responses.length - 1)
    ];
  }
  registerTool(name: string) {
    this.registered.push(name);
  }
  unregisterTool(name: string) {
    this.unregistered.push(name);
    return true;
  }
  setToolContext(context: Record<string, unknown>) {
    this.toolContext = context;
  }
  async getConversationHistory() {
    return [{ role: "user" }, { role: "assistant" }];
  }
}

function runnerWith(host: FakeHost, deadline?: string) {
  return new SessionRunner({
    host,
    context: createRunContext({
      config: config(deadline),
      identity,
      mode: "live",
    }),
    chain: normalizeModelChain({
      provider: "vertex",
      model: "big",
      temperature: 0.2,
    }),
    systemInstruction: "SYSTEM",
  });
}

describe("SessionRunner", () => {
  it("passes the system instruction on every turn, byte-identical", async () => {
    const host = new FakeHost();
    const runner = runnerWith(host);

    await runner.turn("first", { stage: "orient" });
    await runner.turn("second", { stage: "review" });

    expect(host.calls[0].systemPrompt).toBe("SYSTEM");
    expect(host.calls[1].systemPrompt).toBe("SYSTEM");
  });

  it("keeps one session id across turns so context is not re-sent", async () => {
    const host = new FakeHost();
    const runner = runnerWith(host);

    await runner.turn("a", { stage: "orient" });
    await runner.turn("b", { stage: "review" });

    const first = host.calls[0].context as { sessionId: string };
    const second = host.calls[1].context as { sessionId: string };
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.sessionId).toBe("yama:juspay:yama:pr1");
  });

  it("imposes NO step budget — the agent controls the flow", async () => {
    const host = new FakeHost();
    await runnerWith(host).turn("x", { stage: "review" });

    expect(host.calls[0].maxSteps).toBeUndefined();
    expect(host.calls[0].turnTimeoutMs).toBeUndefined();
  });

  it("keeps hang protection, which is not a budget", async () => {
    const host = new FakeHost();
    await runnerWith(host).turn("x", { stage: "review" });

    // A wedged tool or a hung model call is a different thing from a slow one.
    expect(host.calls[0].stallTimeoutMs).toBe(180_000);
    expect(host.calls[0].toolTimeoutMs).toBe(300_000);
  });

  it("passes a step cap ONLY when an operator configured one", async () => {
    const host = new FakeHost();
    await new SessionRunner({
      host,
      context: createRunContext({ config: config(), identity, mode: "live" }),
      chain: normalizeModelChain({ provider: "vertex" }),
      systemInstruction: "S",
      maxStepsPerTurn: 25,
    }).turn("x", { stage: "review" });

    expect(host.calls[0].maxSteps).toBe(25);
  });

  it("applies a turn deadline ONLY when an operator configured one", async () => {
    const host = new FakeHost();
    await runnerWith(host, "10m").turn("x", { stage: "review" });
    expect(host.calls[0].turnTimeoutMs).toBeGreaterThan(30_000);
  });

  it("never writes memory during a review — learning happens on merge", async () => {
    const host = new FakeHost();
    await runnerWith(host).turn("x", { stage: "review" });
    expect(host.calls[0].memory).toEqual({ read: true, write: false });
  });

  it("skips prompt-level tool injection", async () => {
    const host = new FakeHost();
    await runnerWith(host).turn("x", { stage: "review" });
    expect(host.calls[0].skipToolPromptInjection).toBe(true);
  });

  it("passes a schema and disables tools when asked", async () => {
    const host = new FakeHost();
    const runner = runnerWith(host);
    await runner.turn("verdict", {
      stage: "verdict",
      schema: { type: "object" },
      disableTools: true,
    });
    expect(host.calls[0].schema).toEqual({ type: "object" });
    expect(host.calls[0].disableTools).toBe(true);
  });

  it("wires the run's abort signal into every turn", async () => {
    const host = new FakeHost();
    await runnerWith(host).turn("x", { stage: "review" });
    expect(host.calls[0].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("counts turns", async () => {
    const host = new FakeHost();
    const runner = runnerWith(host);
    await runner.turn("a", { stage: "orient" });
    await runner.turn("b", { stage: "review" });
    expect(runner.turns).toBe(2);
  });

  it("reports each turn to the observer", async () => {
    const host = new FakeHost([{ content: "done", stopReason: "stop" }]);
    const seen: number[] = [];
    const runner = new SessionRunner({
      host,
      context: createRunContext({ config: config(), identity, mode: "live" }),
      chain: normalizeModelChain({ provider: "vertex" }),
      systemInstruction: "S",
      onTurn: (result) => seen.push(result.turn),
    });
    await runner.turn("x", { stage: "review" });
    expect(seen).toEqual([1]);
  });
});

describe("tool exposure", () => {
  const tool = (name: string): YamaTool => ({
    name,
    description: "d",
    inputSchema: { type: "object" },
    stages: ["review"],
    roles: ["main"],
    execute: async () => ({}),
  });

  it("registers a stage's tools and stamps the tool context", () => {
    const host = new FakeHost();
    runnerWith(host).setTools(
      [tool("recall"), tool("submit_finding")],
      "review",
    );

    expect(host.registered).toEqual(["recall", "submit_finding"]);
    expect(host.toolContext).toMatchObject({ stage: "review", dryRun: false });
  });

  it("unregisters tools so a later stage cannot reach them", () => {
    const host = new FakeHost();
    const runner = runnerWith(host);
    const tools = [tool("submit_finding")];
    runner.setTools(tools, "review");
    runner.clearTools(tools);
    expect(host.unregistered).toEqual(["submit_finding"]);
  });

  it("marks dry-run in the tool context", () => {
    const host = new FakeHost();
    new SessionRunner({
      host,
      context: createRunContext({
        config: config(),
        identity,
        mode: "dry-run",
      }),
      chain: normalizeModelChain({ provider: "vertex" }),
      systemInstruction: "S",
    }).setTools([tool("recall")], "review");
    expect(host.toolContext?.dryRun).toBe(true);
  });
});

describe("normalizeTurn", () => {
  it("treats a natural stop as complete", () => {
    expect(normalizeTurn(1, { stopReason: "stop" }).partial).toBe(false);
    expect(normalizeTurn(1, {}).partial).toBe(false);
  });

  it.each(["step-cap", "context-cap", "time-limit", "stalled", "aborted"])(
    "treats %s as a PARTIAL turn",
    (stopReason) => {
      expect(normalizeTurn(1, { stopReason }).partial).toBe(true);
    },
  );

  it("flattens tool executions for waste detection", () => {
    const result = normalizeTurn(1, {
      toolExecutions: [
        { toolName: "read", params: { path: "a" }, result: "content" },
        { toolName: "search", params: { q: "x" }, result: [] },
        {
          toolName: "read",
          params: { path: "b" },
          isError: true,
          result: null,
        },
      ],
    });

    expect(result.toolCalls[0]).toMatchObject({ name: "read", empty: false });
    expect(result.toolCalls[1].empty).toBe(true);
    expect(result.toolCalls[2].error).toBe(true);
  });

  it("detects an empty result across common shapes", () => {
    const result = normalizeTurn(1, {
      toolExecutions: [
        { toolName: "a", result: "" },
        { toolName: "b", result: {} },
        { toolName: "c", result: { entries: [] } },
        { toolName: "d", result: { count: 0 } },
        { toolName: "e", result: { count: 3 } },
      ],
    });
    expect(result.toolCalls.map((call) => call.empty)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("bounds serialized params so comparison stays cheap", () => {
    const result = normalizeTurn(1, {
      toolExecutions: [
        { toolName: "read", params: { blob: "x".repeat(5_000) } },
      ],
    });
    expect(result.toolCalls[0].params.length).toBeLessThanOrEqual(300);
  });

  it("survives params that cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      normalizeTurn(1, {
        toolExecutions: [{ toolName: "x", params: circular }],
      }),
    ).not.toThrow();
  });

  it("carries usage and structured output through", () => {
    const result = normalizeTurn(1, {
      structuredData: { decision: "BLOCKED" },
      usage: { input: 10, output: 5, total: 15 },
    });
    expect(result.structuredData).toEqual({ decision: "BLOCKED" });
    expect(result.usage?.total).toBe(15);
  });
});

describe("model chain failover — Yama's chain is authoritative", () => {
  const chain = {
    members: [
      { provider: "litellm", model: "primary" },
      { provider: "litellm", model: "backup" },
    ],
    pool: { strategy: "priority" as const, cooldownMs: 1000, maxAttempts: 2 },
  };

  const runner = (
    host: GenerateHost,
    onFailover?: SessionOptions["onFailover"],
  ) =>
    new SessionRunner({
      host,
      context: createRunContext({
        config: config(),
        identity: { provider: "github", owner: "o", repo: "r" },
        mode: "live",
      }),
      chain: chain as never,
      systemInstruction: "S",
      ...(onFailover ? { onFailover } : {}),
    });

  it("moves to the next model when one returns an empty turn", async () => {
    // An empty response with no tool calls: a reasoning model that spent its
    // whole budget thinking, or a gateway swallowing an upstream error.
    const host = new FakeHost([
      { content: "", stopReason: "completed", usage: { output: 10 } },
      { content: "real work" },
    ]);
    const events: string[] = [];
    const result = await runner(host, (event) =>
      events.push(`${event.from.model}->${event.to?.model}`),
    ).turn("go", { stage: "review" });

    expect(result.content).toBe("real work");
    expect(host.calls.map((call) => call.model)).toEqual(["primary", "backup"]);
    expect(events).toEqual(["primary->backup"]);
  });

  it("moves to the next model when one throws", async () => {
    let call = 0;
    const host = {
      async generate() {
        call += 1;
        if (call === 1) {
          throw new Error("503 service unavailable");
        }
        return { content: "recovered" };
      },
    } as unknown as GenerateHost;

    expect((await runner(host).turn("go", { stage: "review" })).content).toBe(
      "recovered",
    );
  });

  it("does not fail over a bad request — every member would fail the same way", async () => {
    const host = {
      async generate() {
        throw new Error("400 Bad Request: invalid request");
      },
    } as unknown as GenerateHost;

    await expect(runner(host).turn("go", { stage: "review" })).rejects.toThrow(
      /invalid request/,
    );
  });

  it("stays on the model that worked instead of re-trying the failed one", async () => {
    const host = new FakeHost([{ content: "" }, { content: "ok" }]);
    const session = runner(host);
    await session.turn("one", { stage: "review" });
    await session.turn("two", { stage: "review" });

    // primary, backup for turn 1; backup only for turn 2.
    expect(host.calls.map((call) => call.model)).toEqual([
      "primary",
      "backup",
      "backup",
    ]);
  });

  it("reports every member failing rather than returning an empty review", async () => {
    const host = new FakeHost([{ content: "" }]);
    await expect(runner(host).turn("go", { stage: "review" })).rejects.toThrow(
      /Every model in the chain failed/,
    );
  });

  it("pins the runtime's own fallback off, so it cannot pick an unconfigured provider", async () => {
    const host = new FakeHost([{ content: "ok" }]);
    await runner(host).turn("go", { stage: "review" });
    expect(host.calls[0]).toHaveProperty("providerFallback");
    await expect(
      (host.calls[0].providerFallback as () => Promise<unknown>)(),
    ).resolves.toBeNull();
  });
});

describe("isEmptyTurn", () => {
  it("is true only when there is neither content nor a tool call", () => {
    expect(isEmptyTurn({ content: "" })).toBe(true);
    expect(isEmptyTurn({ content: "   " })).toBe(true);
    expect(isEmptyTurn({})).toBe(true);
  });

  it("is false when the turn did work without narrating it", () => {
    expect(
      isEmptyTurn({ content: "", toolExecutions: [{ toolName: "read_file" }] }),
    ).toBe(false);
  });

  it("is false when the turn said something", () => {
    expect(isEmptyTurn({ content: "found a bug" })).toBe(false);
  });
});

/**
 * A dead chain does not recover within a run.
 *
 * The stage machine calls `turn` again for every remaining stage and every
 * remediation attempt. Unlatched, one unreachable provider becomes minutes of
 * identical failures across seven stages — the same error this design refuses
 * to repeat once per member, repeated once per stage instead.
 */
describe("an exhausted chain ends the run, not just the turn", () => {
  const chain = {
    members: [
      { provider: "alpha", model: "one" },
      { provider: "beta", model: "two" },
    ],
    pool: { strategy: "priority" as const, cooldownMs: 0, maxAttempts: 1 },
  };

  function runner(error: Error) {
    let calls = 0;
    const exhausted: Error[] = [];
    const session = new SessionRunner({
      host: {
        generate: async () => {
          calls += 1;
          throw error;
        },
      },
      context: createRunContext({ config: config(), identity, mode: "live" }),
      chain,
      systemInstruction: "s",
      onChainExhausted: (event) => exhausted.push(event),
    });
    return { session, exhausted, calls: () => calls };
  }

  it("tries every member once, then never calls a model again", async () => {
    const { session, calls, exhausted } = runner(new Error("503 unavailable"));

    await expect(session.turn("first", { stage: "review" })).rejects.toThrow(
      /Every model in the chain failed/,
    );
    expect(calls()).toBe(2);
    expect(exhausted).toHaveLength(1);

    // Four more stages' worth of turns. Not one reaches the network.
    for (const stage of ["post", "checks", "enhance", "verdict"] as const) {
      await expect(session.turn("again", { stage })).rejects.toThrow(
        /No further model calls will be attempted/,
      );
    }
    expect(calls()).toBe(2);
    // Reported once, not once per stage.
    expect(exhausted).toHaveLength(1);
  });

  it("latches a failure the whole chain shares without trying the rest", async () => {
    // A bad credential fails the same way on every member and every stage.
    const { session, calls } = runner(new Error("invalid api key"));

    await expect(session.turn("first", { stage: "review" })).rejects.toThrow(
      /invalid api key/,
    );
    expect(calls()).toBe(1);

    await expect(session.turn("second", { stage: "post" })).rejects.toThrow(
      /invalid api key/,
    );
    expect(calls()).toBe(1);
  });
});
