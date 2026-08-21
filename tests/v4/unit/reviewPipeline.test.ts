import {
  reviewPredicate,
  runReviewPipeline,
  type PipelineDependencies,
} from "../../../src/v4/core/ReviewPipeline.js";
import { FindingLedger } from "../../../src/v4/findings/Ledger.js";
import { createRunContext } from "../../../src/v4/core/RunContext.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import { CapabilityResolver } from "../../../src/v4/connections/Capabilities.js";
import type {
  CapabilityReport,
  CheckRunResult,
  IdentifiedFinding,
  ResolvedConfig,
  ReviewState,
  RunMode,
  TurnReport,
} from "../../../src/v4/types/index.js";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,1 +10,2 @@
 const a = 1;
+const b = 2;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 x
+y
`;

const changeSet = buildChangeSet({
  diff: DIFF,
  excludePatterns: [],
  maxFiles: 100,
});

const capabilities: CapabilityReport = {
  resolved: [
    {
      capability: "postInlineComment",
      serverId: "v",
      toolName: "add_comment",
      stages: ["post"],
      roles: ["main"],
    },
    {
      capability: "postSummary",
      serverId: "v",
      toolName: "add_summary",
      stages: ["verdict", "checks"],
      roles: ["main"],
    },
    {
      capability: "setStatus",
      serverId: "v",
      toolName: "set_status",
      stages: ["verdict"],
      roles: ["main"],
    },
  ],
  missing: [],
  registrations: [],
};

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const defaults = optionalDefaults();
  return {
    version: 4,
    ai: { provider: "litellm" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...defaults,
    review: { ...defaults.review, stages: { checks: true, enhance: false } },
    ...overrides,
  } as ResolvedConfig;
}

/** A turn that resolves the PR — what S0 needs. */
const resolveTurn = (): TurnReport => ({
  resolved: { pullRequestId: 1, headSha: "head", baseSha: "base" },
  toolCalls: [],
  partial: false,
});

/** A plan covering both files as one group. */
const planTurn = (): TurnReport => ({
  plan: {
    groups: [
      {
        id: "g1",
        paths: ["src/a.ts", "src/b.ts"],
        reviewed: false,
        gated: false,
      },
    ],
    declined: [],
  },
  toolCalls: [],
  partial: false,
});

const finishTurn = (): TurnReport => ({
  completedGroups: ["g1"],
  gatedGroups: ["g1"],
  done: true,
  toolCalls: [],
  partial: false,
});

type Harness = {
  deps: PipelineDependencies;
  ledger: FindingLedger;
  turns: Array<{ message: string; stage: string }>;
  invocations: string[];
};

function harness(
  script: (turn: number, stage: string) => TurnReport,
  options: { mode?: RunMode; configOverrides?: Partial<ResolvedConfig> } = {},
): Harness {
  const resolved = config(options.configOverrides);
  const ledger = new FindingLedger();
  const turns: Array<{ message: string; stage: string }> = [];
  const invocations: string[] = [];
  let count = 0;

  const deps: PipelineDependencies = {
    config: resolved,
    context: createRunContext({
      config: resolved,
      identity: { provider: "github", owner: "o", repo: "r" },
      mode: options.mode ?? "live",
    }),
    ledger,
    comments: [],
    entries: [],
    posting: {
      resolver: new CapabilityResolver(capabilities),
      invoke: async (tool) => {
        invocations.push(tool);
        return { id: `c-${invocations.length}` };
      },
      mode: options.mode ?? "live",
      stage: "post",
      botIdentity: "yama-bot",
      target: {},
    },
    turn: async (message, stage) => {
      turns.push({ message, stage });
      count += 1;
      return script(count, stage);
    },
    buildChangeSet: async () => changeSet,
    runChecks: async () => [],
    readComments: async () => [],
  };

  return { deps, ledger, turns, invocations };
}

/** The default happy script: resolve, plan, then finish in one review turn. */
const happy = (_turn: number, stage: string): TurnReport => {
  if (stage === "resolve") {
    return resolveTurn();
  }
  if (stage === "orient") {
    return planTurn();
  }
  if (stage === "enhance") {
    return { descriptionUpdated: true, toolCalls: [], partial: false };
  }
  return finishTurn();
};

const finding = (id: string): IdentifiedFinding => ({
  id,
  severity: "MAJOR",
  title: `finding ${id}`,
  filePath: "src/a.ts",
  line: 11,
  suggestion: "fix it",
  source: "agent",
});

describe("S0–S6, as the architecture specifies", () => {
  it("runs every stage in order", async () => {
    const { deps } = harness(happy);
    const result = await runReviewPipeline(deps);

    expect(result.stages.outcomes.map((outcome) => outcome.stage)).toEqual([
      "resolve",
      "orient",
      "review",
      "post",
      "checks",
      "enhance",
      "verdict",
    ]);
    expect(result.stages.partial).toBe(false);
    expect(result.verdict.decision).toBe("APPROVED");
  });

  it("S0 degrades when the pull request cannot be identified", async () => {
    const { deps } = harness((_turn, stage) =>
      stage === "resolve"
        ? { toolCalls: [], partial: false }
        : happy(_turn, stage),
    );

    const result = await runReviewPipeline(deps);
    const resolve = result.stages.outcomes[0];

    expect(resolve.status).toBe("degraded");
    expect(resolve.missing).toContain("pull request number");
    expect(result.verdict.decision).not.toBe("APPROVED");
  });

  it("S1 degrades when a changed file is in no group", async () => {
    const { deps, turns } = harness((_turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return {
          plan: {
            groups: [
              { id: "g1", paths: ["src/a.ts"], reviewed: false, gated: false },
            ],
            declined: [],
          },
          toolCalls: [],
          partial: false,
        };
      }
      return finishTurn();
    });

    const result = await runReviewPipeline(deps);
    const orient = result.stages.outcomes.find((o) => o.stage === "orient");

    expect(orient?.status).toBe("degraded");
    expect(orient?.missing).toEqual(["src/b.ts"]);
    expect(turns.some((t) => t.message.includes("src/b.ts"))).toBe(true);
  });

  it("S1 accepts an explicitly declined file", async () => {
    const { deps } = harness((_turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return {
          plan: {
            groups: [
              { id: "g1", paths: ["src/a.ts"], reviewed: false, gated: false },
            ],
            declined: [{ path: "src/b.ts", reason: "generated fixture" }],
          },
          toolCalls: [],
          partial: false,
        };
      }
      return finishTurn();
    });

    const result = await runReviewPipeline(deps);
    expect(
      result.stages.outcomes.find((o) => o.stage === "orient")?.status,
    ).toBe("passed");
  });

  it("S3 posts what the agent left behind and names it when it cannot", async () => {
    const { deps, ledger, invocations } = harness(happy);
    ledger.recordGate({ accepted: [finding("f1")], rejected: [] });

    const result = await runReviewPipeline(deps);

    expect(invocations).toContain("add_comment");
    expect(ledger.unposted).toEqual([]);
    expect(result.stages.outcomes.find((o) => o.stage === "post")?.status).toBe(
      "passed",
    );
  });

  it("S3 degrades naming the specific unposted finding", async () => {
    const { deps, ledger } = harness(happy);
    deps.posting.invoke = async () => ({});
    ledger.recordGate({ accepted: [finding("f1")], rejected: [] });

    const result = await runReviewPipeline(deps);
    const post = result.stages.outcomes.find((o) => o.stage === "post");

    expect(post?.status).toBe("degraded");
    expect(post?.missing?.[0]).toMatch(/f1 — MAJOR/);
  });

  it("S4 degrades when a configured check never ran", async () => {
    const defaults = optionalDefaults();
    const { deps } = harness(happy, {
      configOverrides: {
        review: {
          ...defaults.review,
          stages: { checks: true, enhance: false },
        },
        checks: {
          enabled: true,
          allowForks: false,
          checks: [
            { id: "lint", run: "x" },
            { id: "tsc", run: "y" },
          ],
        },
      },
    });
    deps.runChecks = async () =>
      [
        {
          checkId: "lint",
          status: "passed",
          durationMs: 1,
          findings: [],
          droppedFindings: 0,
        },
      ] as CheckRunResult[];

    const result = await runReviewPipeline(deps);
    const checks = result.stages.outcomes.find((o) => o.stage === "checks");
    expect(checks?.status).toBe("degraded");
    expect(checks?.missing).toEqual(["tsc"]);
  });

  it("S5 is skipped when enhancement is off", async () => {
    const { deps } = harness(happy);
    const result = await runReviewPipeline(deps);
    expect(
      result.stages.outcomes.find((o) => o.stage === "enhance")?.status,
    ).toBe("skipped");
  });

  it("S6 posts the summary and records the status", async () => {
    const { deps, invocations } = harness(happy);
    const result = await runReviewPipeline(deps);

    expect(invocations).toContain("add_summary");
    expect(invocations).toContain("set_status");
    expect(result.summaryPosted).toBe(true);
    expect(result.statusRecorded).toBe(true);
  });

  it("remediation is bounded by maxAttemptsPerStage, from config", async () => {
    const defaults = optionalDefaults();
    let orientTurns = 0;
    const { deps } = harness(
      (_turn, stage) => {
        if (stage === "resolve") {
          return resolveTurn();
        }
        if (stage === "orient") {
          orientTurns += 1;
          return { toolCalls: [], partial: false };
        }
        return finishTurn();
      },
      {
        configOverrides: {
          review: {
            ...defaults.review,
            remediation: { maxAttemptsPerStage: 3 },
          },
        },
      },
    );

    await runReviewPipeline(deps);
    expect(orientTurns).toBe(3);
  });
});

describe("S2 — the agent drives, no turn budget", () => {
  it("ends when the agent says it is done", async () => {
    const { deps } = harness(happy);
    const result = await runReviewPipeline(deps);
    expect(result.review.turnLoopEnd).toBe("predicate-satisfied");
    expect(result.review.turns).toBe(1);
  });

  it("lets the agent take as many turns as it needs — no cap", async () => {
    const { deps } = harness((turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return planTurn();
      }
      // Fifty working turns. Nothing in the loop counts them.
      if (turn < 52) {
        return {
          toolCalls: [{ name: "read", params: `f${turn}` }],
          partial: false,
        };
      }
      return finishTurn();
    });

    const result = await runReviewPipeline(deps);
    expect(result.review.turns).toBeGreaterThan(40);
    expect(result.review.turnLoopEnd).toBe("predicate-satisfied");
  });

  it("does not dictate group order", async () => {
    const { deps } = harness((turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return {
          plan: {
            groups: [
              { id: "g1", paths: ["src/a.ts"], reviewed: false, gated: false },
              { id: "g2", paths: ["src/b.ts"], reviewed: false, gated: false },
            ],
            declined: [],
          },
          toolCalls: [],
          partial: false,
        };
      }
      // The agent does g2 first. Nothing objects.
      return turn === 3
        ? {
            completedGroups: ["g2"],
            gatedGroups: ["g2"],
            toolCalls: [],
            partial: false,
          }
        : {
            completedGroups: ["g1"],
            gatedGroups: ["g1"],
            toolCalls: [],
            partial: false,
          };
    });

    const result = await runReviewPipeline(deps);
    expect(result.review.turnLoopEnd).toBe("predicate-satisfied");
  });

  it("the supervisor steers on waste, then stops the loop if it repeats", async () => {
    const { deps } = harness((turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return planTurn();
      }
      return {
        toolCalls: [
          { name: "read", params: "same" },
          { name: "read", params: "same" },
          { name: "read", params: "same" },
        ],
        partial: false,
      };
    });

    const result = await runReviewPipeline(deps);
    expect(result.review.interventions[0]).toMatch(/duplicate-calls/);
    expect(result.review.turnLoopEnd).toBe("waste");
  });

  it("stops when the runtime cut a turn short", async () => {
    const { deps } = harness((_turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return planTurn();
      }
      return { toolCalls: [], partial: true };
    });

    const result = await runReviewPipeline(deps);
    expect(result.review.turnLoopEnd).toBe("stalled");
  });

  it("restates the contract after a compaction", async () => {
    const { deps, turns } = harness((turn, stage) => {
      if (stage === "resolve") {
        return resolveTurn();
      }
      if (stage === "orient") {
        return planTurn();
      }
      if (turn === 3) {
        return { compacted: true, toolCalls: [], partial: false };
      }
      return finishTurn();
    });

    const result = await runReviewPipeline(deps);
    expect(result.review.interventions.join(" ")).toMatch(/compaction/);
    expect(turns.some((t) => t.message.includes("submit_finding"))).toBe(true);
  });
});

describe("S2 exit predicate", () => {
  const state = (groups: ReviewState["plan"]["groups"]): ReviewState => ({
    plan: { groups, declined: [] },
    claimedFindings: 0,
    gateSubmissions: 0,
    descriptionUpdated: false,
    descriptionSections: [],
    unposted: [],
  });

  it("passes when every group is reviewed and gated", () => {
    expect(
      reviewPredicate(
        state([{ id: "g1", paths: ["a"], reviewed: true, gated: true }]),
      ).ok,
    ).toBe(true);
  });

  it("names an unreviewed group", () => {
    const result = reviewPredicate(
      state([{ id: "g1", paths: ["a.ts"], reviewed: false, gated: false }]),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing[0]).toMatch(
      /g1 \(a\.ts\) — not reviewed/,
    );
  });

  it("names a group reviewed without a gate submission", () => {
    const result = reviewPredicate(
      state([{ id: "g1", paths: ["a.ts"], reviewed: true, gated: false }]),
    );
    expect(result.ok === false && result.missing[0]).toMatch(
      /no gate submission/,
    );
  });

  it("accepts a group the agent declared clean without gating", () => {
    expect(
      reviewPredicate(
        state([
          {
            id: "g1",
            paths: ["a.ts"],
            reviewed: true,
            gated: false,
            declaredClean: true,
          },
        ]),
      ).ok,
    ).toBe(true);
  });
});

describe("dry run", () => {
  it("writes nothing and requires no posting", async () => {
    const { deps, invocations, ledger } = harness(happy, { mode: "dry-run" });
    ledger.recordGate({ accepted: [finding("f1")], rejected: [] });

    const result = await runReviewPipeline(deps);

    expect(invocations).toEqual([]);
    expect(result.stages.partial).toBe(false);
  });
});

describe("cancellation", () => {
  it("stops between stages", async () => {
    const { deps } = harness(happy);
    deps.context.abort("cancelled");

    const result = await runReviewPipeline(deps);
    expect(result.stages.outcomes.every((o) => o.status === "failed")).toBe(
      true,
    );
    expect(result.verdict.decision).not.toBe("APPROVED");
  });
});

describe("S2 predicate — an absent plan is not a satisfied predicate", () => {
  it("refuses an empty plan instead of passing vacuously", () => {
    // Every filter in the predicate is vacuously true over an empty group list.
    // Without an explicit guard a review that never planned would pass S2 having
    // reviewed nothing, which is the exact silence the stage machine prevents.
    const result = reviewPredicate({
      plan: { groups: [], declined: [] },
      claimedFindings: 0,
      gateSubmissions: 0,
      descriptionUpdated: false,
      descriptionSections: [],
      unposted: [],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing).toEqual(["a review plan"]);
    expect(result.ok === false && result.guidance).toMatch(/report_progress/);
  });

  it("accepts a plan that declined every file, which is a real decision", () => {
    expect(
      reviewPredicate({
        plan: {
          groups: [],
          declined: [{ path: "dist/bundle.js", reason: "generated" }],
        },
        claimedFindings: 0,
        gateSubmissions: 0,
        descriptionUpdated: false,
        descriptionSections: [],
        unposted: [],
      }).ok,
    ).toBe(true);
  });
});

describe("the agent is told how to reach the harness", () => {
  it("names report_progress when asking for a plan", async () => {
    const { deps, turns } = harness(happy);
    await runReviewPipeline(deps);
    const orient = turns.find((turn) => turn.stage === "orient");
    expect(orient?.message).toMatch(/report_progress/);
  });
});

/**
 * S5's exit predicate must verify against the pull request, not against the
 * agent's claim to have written a description. That claim is exactly the kind
 * of self-report the finding ledger exists to replace for comments.
 */
describe("S5 verifies the description it was told about", () => {
  const enhanceOn = {
    configOverrides: {
      review: {
        ...optionalDefaults().review,
        stages: { checks: true, enhance: true },
      },
    } as Partial<ResolvedConfig>,
  };

  function withDescription(
    after: string | undefined,
    options: {
      baseline?: string;
      claim?: boolean;
      sections?: Array<{ title: string; required?: boolean }>;
    } = {},
  ) {
    const { deps } = harness(
      (turn, stage) =>
        stage === "enhance"
          ? {
              descriptionUpdated: options.claim ?? true,
              toolCalls: [],
              partial: false,
            }
          : happy(turn, stage),
      {
        configOverrides: {
          review: {
            ...optionalDefaults().review,
            stages: { checks: true, enhance: true },
            ...(options.sections
              ? { description: { sections: options.sections } }
              : {}),
          },
        } as Partial<ResolvedConfig>,
      },
    );

    return runReviewPipeline({
      ...deps,
      readDescription: async () => after,
      ...(options.baseline !== undefined
        ? { baselineDescription: options.baseline }
        : {}),
    });
  }

  const enhanceOutcome = (
    result: Awaited<ReturnType<typeof runReviewPipeline>>,
  ) => result.stages.outcomes.find((outcome) => outcome.stage === "enhance");

  it("passes when the description actually changed", async () => {
    const result = await withDescription(
      "## What changed\nA real description.",
      {
        baseline: "",
      },
    );
    expect(enhanceOutcome(result)?.status).toBe("passed");
  });

  it("degrades when the agent claims a description the pull request does not have", async () => {
    const result = await withDescription("", { claim: true });
    expect(enhanceOutcome(result)?.status).toBe("degraded");
    expect(enhanceOutcome(result)?.detail).toMatch(/empty description/);
  });

  it("degrades when the description is unchanged from before the run", async () => {
    const result = await withDescription("same text", {
      baseline: "same text",
    });
    expect(enhanceOutcome(result)?.status).toBe("degraded");
    expect(enhanceOutcome(result)?.detail).toMatch(/unchanged/);
  });

  it("names a required section that is missing", async () => {
    const result = await withDescription("## What changed\nsomething", {
      baseline: "",
      sections: [
        { title: "What changed", required: true },
        { title: "Testing Strategy", required: true },
      ],
    });
    expect(enhanceOutcome(result)?.status).toBe("degraded");
    expect(enhanceOutcome(result)?.missing?.join(" ")).toMatch(
      /missing section: Testing Strategy/,
    );
  });

  it("ignores sections that are not required", async () => {
    const result = await withDescription("## What changed\nsomething", {
      baseline: "",
      sections: [{ title: "Rollback Plan" }],
    });
    expect(enhanceOutcome(result)?.status).toBe("passed");
  });

  it("falls back to the agent's claim when there is no way to read it back", async () => {
    // No readDescription: the capability is not mapped. Failing a stage that
    // cannot be verified either way would be worse than saying so.
    const { deps } = harness(happy, enhanceOn);
    const result = await runReviewPipeline(deps);
    expect(enhanceOutcome(result)?.status).toBe("passed");
  });

  it("says the capability is missing when the claim is absent too", async () => {
    const { deps } = harness(
      (turn, stage) =>
        stage === "enhance"
          ? { toolCalls: [], partial: false }
          : happy(turn, stage),
      enhanceOn,
    );
    const result = await runReviewPipeline(deps);
    expect(enhanceOutcome(result)?.detail).toMatch(
      /updateDescription capability/,
    );
  });
});

/**
 * Architecture §10: a check result is evidence the agent reads AND a finding in
 * its own right. The second half was built and never connected — a linter error
 * was visible to the reviewer and invisible to the author.
 */
describe("S4 posts what the checks found", () => {
  // The checks stage only runs when a check is configured.
  const withChecks = {
    configOverrides: {
      checks: {
        ...optionalDefaults().checks,
        checks: [{ id: "lint", run: "npx eslint ." }],
      },
    } as Partial<ResolvedConfig>,
  };

  const checkResult = () => ({
    checkId: "lint",
    status: "failed" as const,
    durationMs: 5,
    droppedFindings: 0,
    findings: [
      {
        checkId: "lint",
        severity: "MAJOR" as const,
        message: "no-unused-vars",
        filePath: "src/a.ts",
        line: 11,
      },
    ],
  });

  it("hands the results to the publisher and reports the count", async () => {
    const { deps } = harness(happy, withChecks);
    const seen: CheckRunResult[][] = [];

    const result = await runReviewPipeline({
      ...deps,
      runChecks: async () => [checkResult()],
      publishCheckFindings: async (results) => {
        seen.push(results);
        return { posted: 1, rejected: 0 };
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0][0].checkId).toBe("lint");
    expect(
      result.stages.outcomes.find((outcome) => outcome.stage === "checks")
        ?.status,
    ).toBe("passed");
  });

  it("degrades when an accepted check finding never got a comment", async () => {
    const { deps, ledger } = harness(happy, withChecks);

    const result = await runReviewPipeline({
      ...deps,
      runChecks: async () => [checkResult()],
      publishCheckFindings: async () => {
        // Accepted by the gate, never confirmed posted — the exact accounting
        // gap that made "accepted 1, posted 0" survivable in v3.
        ledger.recordGate({
          accepted: [finding("check-1")],
          rejected: [],
          instruction: "",
        });
        return { posted: 0, rejected: 0 };
      },
    });

    const checks = result.stages.outcomes.find(
      (outcome) => outcome.stage === "checks",
    );
    expect(checks?.status).toBe("degraded");
    expect(checks?.detail).toMatch(/no comment on the pull request/);
  });

  it("runs without a publisher at all", async () => {
    const { deps } = harness(happy, withChecks);
    const result = await runReviewPipeline({
      ...deps,
      runChecks: async () => [checkResult()],
    });
    expect(
      result.stages.outcomes.find((outcome) => outcome.stage === "checks")
        ?.status,
    ).toBe("passed");
  });
});
