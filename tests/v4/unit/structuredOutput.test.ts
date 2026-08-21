import { z } from "zod";
import { generateStructured } from "../../../src/v4/core/StructuredCall.js";
import {
  mergeTurnOutcome,
  turnOutcomeSchema,
} from "../../../src/v4/agents/turnContract.js";
import { createInlineJudge } from "../../../src/v4/judge/inline.js";
import { excludedToolsForStage } from "../../../src/v4/core/ToolExposure.js";
import { createRunContext } from "../../../src/v4/core/RunContext.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  GenerateHost,
  IdentifiedFinding,
  ModelChain,
  ResolvedCapability,
  ResolvedConfig,
  RunContext,
  TurnProgress,
} from "../../../src/v4/types/index.js";

const schema = z.object({ answer: z.string() });

const chain: ModelChain = {
  members: [
    { provider: "alpha", model: "one" },
    { provider: "beta", model: "two" },
  ],
  pool: { strategy: "priority", cooldownMs: 0, maxAttempts: 1 },
};

function context(): RunContext {
  const config = {
    ...optionalDefaults(),
    version: 4,
    ai: { provider: "alpha" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
  } as unknown as ResolvedConfig;

  return createRunContext({
    config,
    identity: { provider: "test", owner: "acme", repo: "api" },
    mode: "dry-run",
  });
}

/** A host whose every call is scripted, so failover is observable. */
function host(responses: Array<Record<string, unknown> | Error>): {
  host: GenerateHost;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  return {
    calls,
    host: {
      generate: async (options: Record<string, unknown>) => {
        calls.push(options);
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (next instanceof Error) {
          throw next;
        }
        return next as never;
      },
    },
  };
}

describe("generateStructured", () => {
  it("returns validated data and passes the schema to the provider", async () => {
    const { host: h, calls } = host([
      { content: "ok", structuredData: { answer: "42" } },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "rubric",
      message: "question",
      schema,
      operation: "test-op",
    });

    expect(result.data).toEqual({ answer: "42" });
    expect(result.member).toBe("alpha/one");
    expect(result.warnings).toEqual([]);

    // The schema goes over the wire; the runtime enforces or coerces it.
    expect(calls[0].schema).toBe(schema);
    // Auxiliary passes are tool-free and must never write memory or enter the
    // review conversation.
    expect(calls[0].disableTools).toBe(true);
    expect(calls[0].memory).toEqual({ read: false, write: false });
    expect((calls[0].context as Record<string, string>).sessionId).toMatch(
      /:test-op$/,
    );
  });

  it("walks the chain when a member errors", async () => {
    const { host: h, calls } = host([
      new Error("503 service unavailable"),
      { content: "ok", structuredData: { answer: "second" } },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toEqual({ answer: "second" });
    expect(result.member).toBe("beta/two");
    expect(calls).toHaveLength(2);
  });

  it("walks the chain when a member answers off-schema", async () => {
    // The dangerous case: a 200 response that is not what was asked for. It is
    // a failed member, not a finished call.
    const { host: h } = host([
      { content: "I'd be happy to help!", structuredData: { wrong: true } },
      { content: "ok", structuredData: { answer: "recovered" } },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toEqual({ answer: "recovered" });
  });

  it("walks the chain when a member returns nothing at all", async () => {
    const { host: h } = host([
      { content: "", toolExecutions: [] },
      { content: "ok", structuredData: { answer: "later" } },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toEqual({ answer: "later" });
  });

  it("stops on a failure every member would share", async () => {
    const { host: h, calls } = host([new Error("invalid api key")]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/invalid api key/);
  });

  it("reports a truncated answer rather than trusting it", async () => {
    const { host: h } = host([
      {
        content: "ok",
        structuredData: { answer: "cut" },
        jsonTruncated: true,
      },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toEqual({ answer: "cut" });
    expect(result.warnings.join(" ")).toMatch(
      /cut off by the output token limit/,
    );
    expect(result.warnings.join(" ")).toMatch(/maxTokens/);
  });

  it("reports repaired JSON", async () => {
    const { host: h } = host([
      { content: "ok", structuredData: { answer: "x" }, jsonRepaired: true },
    ]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.warnings.join(" ")).toMatch(/malformed JSON/);
  });

  it("returns no data, and says so, when no member can answer", async () => {
    const { host: h } = host([new Error("503"), new Error("timeout")]);

    const result = await generateStructured({
      host: h,
      chain,
      context: context(),
      systemPrompt: "s",
      message: "m",
      schema,
      operation: "op",
    });

    expect(result.data).toBeUndefined();
    expect(result.warnings.join(" ")).toMatch(
      /no model in the chain returned a valid/,
    );
  });
});

describe("the turn contract", () => {
  const empty = (): TurnProgress => ({
    completedGroups: [],
    cleanGroups: [],
    claimedFindings: 0,
    descriptionSections: [],
    done: false,
  });

  it("accepts what the schema describes", () => {
    expect(
      turnOutcomeSchema.safeParse({
        summary: "reviewed the parser",
        completedGroups: ["g1"],
        done: true,
      }).success,
    ).toBe(true);
  });

  it("leaves progress untouched when the turn returned nothing structured", () => {
    const progress = { ...empty(), completedGroups: ["g1"] };
    expect(mergeTurnOutcome(progress, undefined)).toEqual(progress);
    expect(mergeTurnOutcome(progress, "some prose")).toEqual(progress);
  });

  it("unions the two channels rather than replacing either", () => {
    const merged = mergeTurnOutcome(
      { ...empty(), completedGroups: ["from-tool"] },
      { summary: "s", completedGroups: ["from-schema"] },
    );
    expect(merged.completedGroups.sort()).toEqual(["from-schema", "from-tool"]);
  });

  it("counts a group claimed in both channels once", () => {
    const merged = mergeTurnOutcome(
      { ...empty(), completedGroups: ["g1"] },
      { summary: "s", completedGroups: ["g1"] },
    );
    expect(merged.completedGroups).toEqual(["g1"]);
  });

  it("takes the larger claimed-findings count, never the sum", () => {
    // Summing would double-count a model that reported both ways and trip the
    // supervisor against a number that never existed.
    const merged = mergeTurnOutcome(
      { ...empty(), claimedFindings: 3 },
      { summary: "s", claimedFindings: 3 },
    );
    expect(merged.claimedFindings).toBe(3);
  });

  it("latches done from either channel", () => {
    expect(
      mergeTurnOutcome({ ...empty(), done: true }, { summary: "s" }).done,
    ).toBe(true);
    expect(mergeTurnOutcome(empty(), { summary: "s", done: true }).done).toBe(
      true,
    );
  });

  it("merges plans by group id", () => {
    const merged = mergeTurnOutcome(
      {
        ...empty(),
        plan: { groups: [{ id: "a", paths: ["one.ts"] }], declined: [] },
      },
      {
        summary: "s",
        plan: {
          groups: [
            { id: "a", paths: ["two.ts"] },
            { id: "b", paths: ["three.ts"] },
          ],
          declined: [{ path: "x.snap", reason: "generated" }],
        },
      },
    );

    expect(merged.plan?.groups).toEqual([
      { id: "a", paths: ["one.ts", "two.ts"] },
      { id: "b", paths: ["three.ts"] },
    ]);
    expect(merged.plan?.declined).toEqual([
      { path: "x.snap", reason: "generated" },
    ]);
  });

  it("carries resolved identifiers through", () => {
    const merged = mergeTurnOutcome(empty(), {
      summary: "s",
      resolved: { pullRequestId: 42, headSha: "abc" },
    });
    expect(merged.resolved).toEqual({ pullRequestId: 42, headSha: "abc" });
  });
});

describe("the inline judge", () => {
  const finding = (over: Partial<IdentifiedFinding> = {}): IdentifiedFinding =>
    ({
      id: "f1",
      severity: "MAJOR",
      title: "unbounded loop",
      source: "agent",
      ...over,
    }) as IdentifiedFinding;

  it("is absent when scoring is turned off", () => {
    const { host: h } = host([{}]);
    expect(
      createInlineJudge({
        host: h,
        chain,
        context: context(),
        instruction: "rubric",
        threshold: 0,
      }),
    ).toBeUndefined();
  });

  it("scores agent findings and ignores check findings", async () => {
    const { host: h, calls } = host([
      {
        content: "ok",
        structuredData: { scores: [{ id: "f1", score: 91, reason: "solid" }] },
      },
    ]);

    const judge = createInlineJudge({
      host: h,
      chain,
      context: context(),
      instruction: "THE RUBRIC",
      threshold: 80,
    });

    const result = await judge!([
      finding(),
      finding({ id: "f2", source: "check" }),
    ]);

    expect(result.scores.get("f1")).toBe(91);
    expect(result.scores.has("f2")).toBe(false);
    // The rubric the catalog supplied is the one that goes to the model.
    expect((calls[0].input as { text: string }).text).toContain("THE RUBRIC");
  });

  it("makes no call when nothing needs judging", async () => {
    const { host: h, calls } = host([{}]);
    const judge = createInlineJudge({
      host: h,
      chain,
      context: context(),
      instruction: "r",
      threshold: 80,
    });

    const result = await judge!([finding({ source: "check" })]);
    expect(calls).toHaveLength(0);
    expect(result.scores.size).toBe(0);
  });

  it("returns no scores rather than deleting findings when it cannot answer", async () => {
    // The critical failure direction: a judge that cannot answer must not be
    // able to silence a real finding.
    const { host: h } = host([new Error("503"), new Error("503")]);

    const judge = createInlineJudge({
      host: h,
      chain,
      context: context(),
      instruction: "r",
      threshold: 80,
    });

    const result = await judge!([finding()]);
    expect(result.scores.size).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/gated without it/);
  });

  it("raises a score when independent reporters agree", async () => {
    const { host: h } = host([
      {
        content: "ok",
        structuredData: { scores: [{ id: "f1", score: 70, reason: "maybe" }] },
      },
    ]);

    const judge = createInlineJudge({
      host: h,
      chain,
      context: context(),
      instruction: "r",
      threshold: 80,
      agreement: new Map([["f1", 3]]),
    });

    const result = await judge!([finding()]);
    // 70 + min(15, (3-1)*8) = 85 — over the bar, but only because independent
    // specialists found it. The bonus is capped so agreement can lift a
    // borderline finding and never rescue one scored near zero.
    expect(result.scores.get("f1")).toBe(85);
  });

  it("warns about findings the judge silently skipped", async () => {
    const { host: h } = host([
      { content: "ok", structuredData: { scores: [] } },
    ]);

    const judge = createInlineJudge({
      host: h,
      chain,
      context: context(),
      instruction: "r",
      threshold: 80,
    });

    const result = await judge!([finding()]);
    expect(result.warnings.join(" ")).toMatch(/did not score 1 finding/);
  });
});

describe("stage-scoped MCP exposure", () => {
  const capability = (
    name: string,
    tool: string,
    stages: string[],
  ): ResolvedCapability =>
    ({
      capability: name,
      toolName: tool,
      serverId: "vcs",
      stages,
      roles: ["main"],
    }) as unknown as ResolvedCapability;

  it("hides a posting tool during a review turn", () => {
    const excluded = excludedToolsForStage(
      [
        capability("readPullRequest", "pr_read", ["resolve", "review"]),
        capability("postSummary", "add_comment", ["verdict"]),
      ],
      "review",
      "main",
    );

    expect(excluded).toEqual(["add_comment"]);
  });

  it("keeps a tool whose other capability is available in this stage", () => {
    // One tool backs many capabilities. Excluding on the first non-matching one
    // would take the read path down with the write path.
    const excluded = excludedToolsForStage(
      [
        capability("readPullRequest", "pr_rw", ["review"]),
        capability("updateDescription", "pr_rw", ["enhance"]),
      ],
      "review",
      "main",
    );

    expect(excluded).toEqual([]);
  });

  it("hides everything a role may not use", () => {
    const readOnly = {
      capability: "postSummary",
      toolName: "add_comment",
      serverId: "vcs",
      stages: ["review"],
      roles: ["main"],
    } as unknown as ResolvedCapability;

    expect(excludedToolsForStage([readOnly], "review", "sub")).toEqual([
      "add_comment",
    ]);
  });

  it("excludes nothing when nothing is mapped", () => {
    expect(excludedToolsForStage([], "review", "main")).toEqual([]);
  });
});
