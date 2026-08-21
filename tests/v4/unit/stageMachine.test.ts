import {
  describeOutcomes,
  missing,
  passed,
  renderRemediation,
  runStages,
  type StageDefinition,
} from "../../../src/v4/core/StageMachine.js";
import {
  coverageGap,
  detectDuplicateCalls,
  longestStreak,
  renderRulesFor,
  supervise,
  type TurnObservation,
} from "../../../src/v4/core/Supervisor.js";
import type { RecallEntry } from "../../../src/v4/tools/recall.js";

const clock = () => {
  let time = 0;
  return () => {
    time += 10;
    return time;
  };
};

function stage(
  name: StageDefinition["name"],
  overrides: Partial<StageDefinition> = {},
): StageDefinition {
  return {
    name,
    run: async () => {},
    check: () => passed,
    ...overrides,
  };
}

describe("stage machine", () => {
  it("runs stages in order and passes a clean run", async () => {
    const order: string[] = [];
    const result = await runStages(
      [
        stage("orient", { run: async () => void order.push("orient") }),
        stage("review", { run: async () => void order.push("review") }),
      ],
      { maxAttemptsPerStage: 2, now: clock() },
    );

    expect(order).toEqual(["orient", "review"]);
    expect(result.partial).toBe(false);
    expect(
      result.outcomes.every((outcome) => outcome.status === "passed"),
    ).toBe(true);
  });

  it("skips a disabled stage without marking the run partial", async () => {
    const result = await runStages(
      [
        stage("checks", {
          enabled: false,
          run: async () => {
            throw new Error("no");
          },
        }),
      ],
      { maxAttemptsPerStage: 2, now: clock() },
    );
    expect(result.outcomes[0].status).toBe("skipped");
    expect(result.partial).toBe(false);
  });

  it("remediates a failing predicate and passes once it is satisfied", async () => {
    let posted = false;
    let remediations = 0;

    const result = await runStages(
      [
        stage("post", {
          check: () =>
            posted
              ? passed
              : missing(["finding a1"], "Post the accepted findings."),
          remediate: async () => {
            remediations += 1;
            posted = true;
          },
        }),
      ],
      { maxAttemptsPerStage: 3, now: clock() },
    );

    expect(remediations).toBe(1);
    expect(result.outcomes[0].status).toBe("passed");
    expect(result.outcomes[0].attempts).toBe(2);
  });

  it("gives up after maxAttempts and marks the stage DEGRADED, not passed", async () => {
    let remediations = 0;
    const result = await runStages(
      [
        stage("post", {
          check: () => missing(["a1", "a7"], "Post the accepted findings."),
          remediate: async () => void (remediations += 1),
        }),
      ],
      { maxAttemptsPerStage: 3, now: clock() },
    );

    expect(remediations).toBe(2);
    expect(result.outcomes[0].status).toBe("degraded");
    expect(result.outcomes[0].missing).toEqual(["a1", "a7"]);
    expect(result.partial).toBe(true);
    expect(result.degradedStages).toEqual(["post"]);
  });

  it("degrades immediately when a stage cannot remediate", async () => {
    const result = await runStages(
      [
        stage("post", {
          check: () => missing(["a1"], "Cannot fix this here."),
        }),
      ],
      { maxAttemptsPerStage: 5, now: clock() },
    );
    expect(result.outcomes[0].attempts).toBe(1);
    expect(result.outcomes[0].status).toBe("degraded");
  });

  it("CONTINUES after a stage throws — findings already posted still matter", async () => {
    const ran: string[] = [];
    const result = await runStages(
      [
        stage("checks", {
          run: async () => {
            throw new Error("lint binary missing");
          },
        }),
        stage("verdict", { run: async () => void ran.push("verdict") }),
      ],
      { maxAttemptsPerStage: 2, now: clock() },
    );

    expect(result.outcomes[0].status).toBe("failed");
    expect(result.outcomes[0].detail).toBe("lint binary missing");
    expect(ran).toEqual(["verdict"]);
    expect(result.partial).toBe(true);
  });

  it("stops cleanly when the run is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const ran: string[] = [];

    const result = await runStages(
      [stage("review", { run: async () => void ran.push("review") })],
      { maxAttemptsPerStage: 2, now: clock(), signal: controller.signal },
    );

    expect(ran).toEqual([]);
    expect(result.outcomes[0].status).toBe("failed");
    expect(result.outcomes[0].detail).toMatch(/cancelled/);
  });

  it("reports each stage as it completes", async () => {
    const seen: string[] = [];
    await runStages([stage("orient"), stage("review")], {
      maxAttemptsPerStage: 1,
      now: clock(),
      onStage: (outcome) => seen.push(`${outcome.stage}:${outcome.status}`),
    });
    expect(seen).toEqual(["orient:passed", "review:passed"]);
  });
});

describe("remediation messages name specifics, never counts", () => {
  it("lists the exact missing items", () => {
    const message = renderRemediation("post", {
      ok: false,
      missing: ["a1 — src/app.ts:11", "a7 — src/pay.ts:3"],
      guidance: "These findings were accepted but have no comment.",
    });
    expect(message).toMatch(/a1 — src\/app\.ts:11/);
    expect(message).toMatch(/a7 — src\/pay\.ts:3/);
    expect(message).not.toMatch(/2 findings/);
  });

  it("still reads sensibly with no itemised list", () => {
    expect(
      renderRemediation("enhance", {
        ok: false,
        missing: [],
        guidance: "Add the Testing section.",
      }),
    ).toMatch(/Add the Testing section/);
  });

  it("describes outcomes for the run report", () => {
    expect(
      describeOutcomes([
        {
          stage: "post",
          status: "degraded",
          attempts: 3,
          durationMs: 5,
          detail: "unposted",
        },
        { stage: "verdict", status: "passed", attempts: 1, durationMs: 1 },
      ]),
    ).toBe(
      "post: degraded (3 attempts) — unposted\nverdict: passed (1 attempt)",
    );
  });
});

describe("supervisor waste detection", () => {
  const call = (name: string, params = "{}", extra = {}) => ({
    name,
    params,
    ...extra,
  });

  it("detects a repeated identical call", () => {
    expect(
      detectDuplicateCalls([
        call("read", "a"),
        call("read", "a"),
        call("read", "a"),
      ]),
    ).toEqual(["read(a)"]);
  });

  it("does not flag varied calls", () => {
    expect(
      detectDuplicateCalls([
        call("read", "a"),
        call("read", "b"),
        call("read", "c"),
      ]),
    ).toEqual([]);
  });

  it("measures the longest consecutive streak, not the total", () => {
    const calls = [
      call("s", "1", { empty: true }),
      call("s", "2", { empty: true }),
      call("s", "3"),
      call("s", "4", { empty: true }),
    ];
    expect(longestStreak(calls, (entry) => entry.empty === true)).toBe(2);
  });

  it("finds the coverage gap between plan and reality", () => {
    expect(
      coverageGap({
        plannedPaths: ["a.ts", "b.ts", "c.ts"],
        examinedPaths: ["a.ts"],
      } as TurnObservation),
    ).toEqual(["b.ts", "c.ts"]);
  });
});

describe("supervise", () => {
  const entries: RecallEntry[] = [
    {
      id: "sec.no-eval",
      title: "Never eval external input",
      summary: "RCE",
      kind: "rule",
      paths: ["src/**"],
      blocking: true,
    },
  ];

  const observation = (
    overrides: Partial<TurnObservation> = {},
  ): TurnObservation => ({
    turn: 1,
    plannedPaths: ["src/a.ts"],
    examinedPaths: ["src/a.ts"],
    gateSubmissions: 1,
    unpostedFindingIds: [],
    toolCalls: [],
    compacted: false,
    claimedFindings: 0,
    ...overrides,
  });

  it("stays quiet when the turn went fine", () => {
    const verdict = supervise({
      observation: observation(),
      entries,
      moreTurnsExpected: true,
    });
    expect(verdict.intervene).toBe(false);
  });

  it("flags a coverage gap and re-injects the rules for what is left", () => {
    const verdict = supervise({
      observation: observation({
        plannedPaths: ["src/a.ts", "src/b.ts"],
        examinedPaths: ["src/a.ts"],
      }),
      entries,
      moreTurnsExpected: true,
    });

    expect(verdict.signals).toContain("coverage-gap");
    expect(verdict.guidance).toMatch(/src\/b\.ts/);
    expect(verdict.guidance).toMatch(/\[sec\.no-eval\]/);
    expect(verdict.guidance).toMatch(/BLOCKING/);
  });

  it("does not nag about coverage when no turns remain", () => {
    const verdict = supervise({
      observation: observation({
        plannedPaths: ["src/a.ts", "src/b.ts"],
        examinedPaths: ["src/a.ts"],
      }),
      entries,
      moreTurnsExpected: false,
    });
    expect(verdict.signals).not.toContain("coverage-gap");
  });

  it("catches findings described in prose but never gated", () => {
    const verdict = supervise({
      observation: observation({ claimedFindings: 3, gateSubmissions: 0 }),
      entries,
      moreTurnsExpected: true,
    });
    expect(verdict.signals).toContain("gate-skipped");
    expect(verdict.guidance).toMatch(/Nothing reaches the pull request/);
  });

  it("names the specific unposted findings", () => {
    const verdict = supervise({
      observation: observation({ unpostedFindingIds: ["a1", "a7"] }),
      entries,
      moreTurnsExpected: true,
    });
    expect(verdict.guidance).toMatch(/a1, a7/);
  });

  it("calls out a stuck loop", () => {
    const verdict = supervise({
      observation: observation({
        toolCalls: Array.from({ length: 3 }, () => ({
          name: "read",
          params: "x",
        })),
      }),
      entries,
      moreTurnsExpected: true,
    });
    expect(verdict.signals).toContain("duplicate-calls");
  });

  it("calls out empty and error streaks", () => {
    const empty = supervise({
      observation: observation({
        toolCalls: Array.from({ length: 4 }, (_, index) => ({
          name: "search",
          params: String(index),
          empty: true,
        })),
      }),
      entries,
      moreTurnsExpected: true,
    });
    expect(empty.signals).toContain("empty-streak");

    const errors = supervise({
      observation: observation({
        toolCalls: Array.from({ length: 3 }, (_, index) => ({
          name: "read",
          params: String(index),
          error: true,
        })),
      }),
      entries,
      moreTurnsExpected: true,
    });
    expect(errors.signals).toContain("error-streak");
  });

  it("RESTATES THE CONTRACT after a compaction, when it may have fallen out of view", () => {
    const verdict = supervise({
      observation: observation({ compacted: true }),
      entries,
      moreTurnsExpected: true,
    });
    expect(verdict.signals).toContain("compaction");
    expect(verdict.guidance).toMatch(/submit_finding/);
    expect(verdict.guidance).toMatch(/refused without a concrete fix/);
    expect(verdict.guidance).toMatch(/lines this pull request changed/);
  });

  it("renders nothing when no rule governs the remaining files", () => {
    expect(renderRulesFor(entries, ["docs/readme.md"])).toBe("");
  });
});
