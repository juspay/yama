import {
  buildSessionId,
  createRunContext,
  parseDurationMs,
  withResolvedIdentity,
} from "../../../src/v4/core/RunContext.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  ConcurrencyPower,
  ResolvedConfig,
  RunIdentity,
} from "../../../src/v4/types/index.js";

const identity: RunIdentity = {
  provider: "github",
  owner: "juspay",
  repo: "yama",
  pullRequestId: 142,
};

function configWith(
  power: ConcurrencyPower = "medium",
  deadline?: string,
): ResolvedConfig {
  const defaults = optionalDefaults();
  return {
    version: 4,
    ai: { provider: "vertex" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...defaults,
    review: {
      ...defaults.review,
      concurrency: { power },
      ...(deadline ? { deadline } : {}),
    },
  } as ResolvedConfig;
}

describe("parseDurationMs", () => {
  it.each([
    ["15m", 900_000],
    ["90s", 90_000],
    ["2h", 7_200_000],
    ["500ms", 500],
    ["1.5m", 90_000],
    [5_000, 5_000],
  ])("parses %p", (input, expected) => {
    expect(parseDurationMs(input as string | number)).toBe(expected);
  });

  it.each([undefined, "", "soon", "0m", "-5s", 0, -1, Number.NaN])(
    "returns undefined for %p rather than guessing",
    (input) => {
      expect(
        parseDurationMs(input as string | number | undefined),
      ).toBeUndefined();
    },
  );
});

describe("buildSessionId", () => {
  it("keys on the pull request when one is known", () => {
    expect(buildSessionId(identity)).toBe("yama:juspay:yama:pr142");
  });

  it("falls back to the branch before the PR is resolved", () => {
    expect(
      buildSessionId({
        ...identity,
        pullRequestId: undefined,
        branch: "feat/New_Gate",
      }),
    ).toBe("yama:juspay:yama:branch-feat-new_gate");
  });

  it("is stable and lowercase for artifact keying", () => {
    expect(
      buildSessionId({
        provider: "bitbucket",
        owner: "Team",
        repo: "Repo",
        pullRequestId: 7,
      }),
    ).toBe("yama:team:repo:pr7");
  });
});

describe("createRunContext", () => {
  it("sizes the pool from the concurrency tier", () => {
    expect(
      createRunContext({ config: configWith("high"), identity, mode: "live" })
        .pool.size,
    ).toBe(8);
    expect(
      createRunContext({ config: configWith("medium"), identity, mode: "live" })
        .pool.size,
    ).toBe(4);
    expect(
      createRunContext({ config: configWith("low"), identity, mode: "live" })
        .pool.size,
    ).toBe(1);
  });

  it("sets delegation caps from the same tier", () => {
    expect(
      createRunContext({ config: configWith("high"), identity, mode: "live" })
        .delegationsPerTurn,
    ).toBe(6);
    expect(
      createRunContext({ config: configWith("low"), identity, mode: "live" })
        .delegationsPerTurn,
    ).toBe(1);
  });

  it("has NO deadline unless one was configured", () => {
    const context = createRunContext({
      config: configWith(),
      identity,
      mode: "live",
    });
    expect(context.deadlineAt).toBeUndefined();
    expect(context.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  it("honours an explicitly configured deadline", () => {
    let clock = 1_000;
    const context = createRunContext({
      config: configWith("medium", "10m"),
      identity,
      mode: "live",
      now: () => clock,
    });
    expect(context.deadlineAt).toBe(601_000);
    clock += 60_000;
    expect(context.remainingMs()).toBe(540_000);
    clock += 10_000_000;
    expect(context.remainingMs()).toBe(0);
  });

  it("propagates a parent abort", () => {
    const parent = new AbortController();
    const context = createRunContext({
      config: configWith(),
      identity,
      mode: "live",
      parentSignal: parent.signal,
    });
    expect(context.signal.aborted).toBe(false);
    parent.abort("ctrl-c");
    expect(context.signal.aborted).toBe(true);
  });

  it("starts aborted when the parent already aborted", () => {
    const parent = new AbortController();
    parent.abort("too late");
    const context = createRunContext({
      config: configWith(),
      identity,
      mode: "live",
      parentSignal: parent.signal,
    });
    expect(context.signal.aborted).toBe(true);
  });
});

describe("concurrency pool", () => {
  it("grants up to the pool size immediately", async () => {
    const { pool } = createRunContext({
      config: configWith("medium"),
      identity,
      mode: "live",
    });
    const releases = await Promise.all([
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ]);
    expect(pool.available).toBe(0);
    releases.forEach((release) => release());
    expect(pool.available).toBe(4);
  });

  it("queues beyond the ceiling and hands the permit to the next waiter", async () => {
    const { pool } = createRunContext({
      config: configWith("low"),
      identity,
      mode: "live",
    });
    const first = await pool.acquire();
    let granted = false;
    const second = pool.acquire().then((release) => {
      granted = true;
      return release;
    });

    expect(granted).toBe(false);
    expect(pool.waiting).toBe(1);

    first();
    const release = await second;
    expect(granted).toBe(true);
    release();
    expect(pool.available).toBe(1);
  });

  it("never exceeds the ceiling when a caller releases twice", async () => {
    const { pool } = createRunContext({
      config: configWith("low"),
      identity,
      mode: "live",
    });
    const release = await pool.acquire();
    release();
    release();
    expect(pool.available).toBe(1);
  });

  it("rejects a waiter when the run is cancelled", async () => {
    const context = createRunContext({
      config: configWith("low"),
      identity,
      mode: "live",
    });
    const held = await context.pool.acquire();
    const pending = context.pool.acquire(context.signal);
    context.abort("cancelled");
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(context.pool.waiting).toBe(0);
    held();
  });

  it("refuses immediately when the run is already cancelled", async () => {
    const context = createRunContext({
      config: configWith(),
      identity,
      mode: "live",
    });
    context.abort("cancelled");
    await expect(context.pool.acquire(context.signal)).rejects.toThrow(
      /cancelled/,
    );
  });
});

describe("withResolvedIdentity", () => {
  it("merges discovered fields without changing the session id", () => {
    const context = createRunContext({
      config: configWith(),
      identity: {
        provider: "github",
        owner: "juspay",
        repo: "yama",
        branch: "feat/x",
      },
      mode: "live",
    });
    const updated = withResolvedIdentity(context, {
      pullRequestId: 9,
      headSha: "abc",
    });

    expect(updated.identity.pullRequestId).toBe(9);
    expect(updated.identity.headSha).toBe("abc");
    expect(updated.identity.branch).toBe("feat/x");
    expect(updated.sessionId).toBe(context.sessionId);
  });
});
