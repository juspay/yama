import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_RUN_LOOKBACK,
  advanceWatermark,
  describeWindow,
  emptyWatermark,
  resolveWindow,
  windowFromCommits,
  windowFromProvider,
  type LearnWatermark,
  type WindowCommit,
  type WindowEntry,
} from "../../../src/v4/learn/Window.js";
import {
  loadWatermark,
  saveWatermark,
  watermarkRelativePath,
} from "../../../src/v4/learn/WatermarkStore.js";

const commit = (
  sha: string,
  subject: string,
  at: string,
  extra: Partial<WindowCommit> = {},
): WindowCommit => ({
  sha,
  subject,
  parentCount: 1,
  committedAt: at,
  ...extra,
});

describe("squash and merge-commit: the number is in the commit", () => {
  it("reads a squash subject", () => {
    const { entries } = windowFromCommits([
      commit("a1", "feat: thing (#142)", "2026-01-01T00:00:00Z"),
    ]);
    expect(entries).toEqual([
      {
        pullRequestId: 142,
        sha: "a1",
        mergedAt: "2026-01-01T00:00:00Z",
        via: "commit-subject",
      },
    ]);
  });

  it("reads a merge-commit subject", () => {
    const { entries } = windowFromCommits([
      commit(
        "m1",
        "Merge pull request #142 from feat/x",
        "2026-01-01T00:00:00Z",
        {
          parentCount: 2,
        },
      ),
    ]);
    expect(entries[0].pullRequestId).toBe(142);
  });

  it("reads an explicit trailer", () => {
    const { entries } = windowFromCommits([
      commit("c1", "chore: thing", "2026-01-01T00:00:00Z", {
        body: "PR: #99\n",
      }),
    ]);
    expect(entries[0].pullRequestId).toBe(99);
  });

  it("SKIPS a direct push rather than guessing", () => {
    const { entries, skipped } = windowFromCommits([
      commit("d1", "hotfix: typo", "2026-01-01T00:00:00Z"),
    ]);
    expect(entries).toEqual([]);
    expect(skipped[0].reason).toMatch(/no pull request reference/);
  });

  it("does not learn from one pull request twice in a window", () => {
    const { entries } = windowFromCommits([
      commit("a1", "feat: thing (#142)", "2026-01-01T00:00:00Z"),
      commit(
        "a2",
        "Merge pull request #142 from feat/x",
        "2026-01-02T00:00:00Z",
      ),
    ]);
    expect(entries).toHaveLength(1);
  });

  it("handles many merges in one window", () => {
    const { entries } = windowFromCommits([
      commit("a1", "feat: one (#1)", "2026-01-01T00:00:00Z"),
      commit("a2", "fix: two (#2)", "2026-01-02T00:00:00Z"),
      commit("a3", "feat: three (#3)", "2026-01-03T00:00:00Z"),
    ]);
    expect(entries.map((entry) => entry.pullRequestId)).toEqual([1, 2, 3]);
  });
});

describe("rebase: the provider knows what git does not", () => {
  const merged = [
    { id: 1, mergedAt: "2026-01-01T00:00:00Z", mergeCommitSha: "s1" },
    { id: 2, mergedAt: "2026-01-02T00:00:00Z" },
    { id: 3, mergedAt: "2026-01-03T00:00:00Z" },
  ];

  it("takes everything when there is no watermark yet", () => {
    expect(
      windowFromProvider(merged, undefined).map((e) => e.pullRequestId),
    ).toEqual([1, 2, 3]);
  });

  it("takes only what merged after the watermark", () => {
    expect(
      windowFromProvider(merged, "2026-01-01T00:00:00Z").map(
        (e) => e.pullRequestId,
      ),
    ).toEqual([2, 3]);
  });

  it("EXCLUDES the boundary — that one was already learned from", () => {
    const result = windowFromProvider(merged, "2026-01-02T00:00:00Z");
    expect(result.map((e) => e.pullRequestId)).toEqual([3]);
  });

  it("orders oldest first so corrections link to what they corrected", () => {
    const shuffled = [merged[2], merged[0], merged[1]];
    expect(
      windowFromProvider(shuffled, undefined).map((e) => e.pullRequestId),
    ).toEqual([1, 2, 3]);
  });
});

describe("resolveWindow", () => {
  const watermark = (
    overrides: Partial<LearnWatermark> = {},
  ): LearnWatermark => ({
    ...emptyWatermark("main"),
    lastLearnedSha: "base",
    lastLearnedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("catches up on several merges at once", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark(),
      commits: [
        commit("a1", "feat: one (#1)", "2026-01-02T00:00:00Z"),
        commit("a2", "fix: two (#2)", "2026-01-03T00:00:00Z"),
        commit("a3", "feat: three (#3)", "2026-01-04T00:00:00Z"),
      ],
    });

    expect(window.entries.map((e) => e.pullRequestId)).toEqual([1, 2, 3]);
    expect(window.warnings.join(" ")).toMatch(
      /Catching up on 3 merged pull requests/,
    );
    expect(window.warnings.join(" ")).toMatch(/oldest first/);
  });

  it("skips pull requests already learned from, even if the window overlaps", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark({
        processed: [{ pr: 1, at: "2026-01-02T00:00:00Z" }],
      }),
      commits: [
        commit("a1", "feat: one (#1)", "2026-01-02T00:00:00Z"),
        commit("a2", "fix: two (#2)", "2026-01-03T00:00:00Z"),
      ],
    });

    expect(window.entries.map((e) => e.pullRequestId)).toEqual([2]);
    expect(window.warnings.join(" ")).toMatch(/already learned from/);
  });

  it("uses the provider listing for a rebase repository", () => {
    const window = resolveWindow({
      strategy: "rebase",
      watermark: watermark(),
      commits: [commit("x1", "feat: no marker here", "2026-01-02T00:00:00Z")],
      providerMerged: [
        { id: 7, mergedAt: "2026-01-02T00:00:00Z" },
        { id: 8, mergedAt: "2026-01-03T00:00:00Z" },
      ],
    });

    expect(window.entries.map((e) => e.pullRequestId)).toEqual([7, 8]);
    expect(window.entries.every((e) => e.via === "provider-listing")).toBe(
      true,
    );
  });

  it("WARNS and falls back to the trigger when a rebase repo has no listing", () => {
    const window = resolveWindow({
      strategy: "rebase",
      watermark: watermark(),
      commits: [commit("x1", "feat: no marker", "2026-01-02T00:00:00Z")],
      triggerPullRequestId: 42,
      triggerMergedAt: "2026-01-02T00:00:00Z",
    });

    expect(window.entries.map((e) => e.pullRequestId)).toEqual([42]);
    expect(window.warnings.join(" ")).toMatch(
      /only the triggering pull request/,
    );
  });

  it("ALWAYS includes the trigger — the CI event is exact", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark(),
      commits: [],
      triggerPullRequestId: 99,
      triggerMergedAt: "2026-01-05T00:00:00Z",
    });

    expect(window.entries.map((e) => e.pullRequestId)).toEqual([99]);
    expect(window.entries[0].via).toBe("trigger");
  });

  it("does not duplicate the trigger when the strategy already found it", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark(),
      commits: [commit("a1", "feat: one (#1)", "2026-01-02T00:00:00Z")],
      triggerPullRequestId: 1,
    });
    expect(window.entries).toHaveLength(1);
    expect(window.entries[0].via).toBe("commit-subject");
  });

  it("NARROWS a first run instead of learning from all of history", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: emptyWatermark("main"),
      commits: Array.from({ length: 30 }, (_, index) =>
        commit(
          `a${index}`,
          `feat: thing (#${index})`,
          `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        ),
      ),
    });

    expect(window.firstRun).toBe(true);
    expect(window.entries).toHaveLength(FIRST_RUN_LOOKBACK);
    expect(window.warnings.join(" ")).toMatch(/yama bootstrap/);
  });

  it("reports commits it skipped rather than hiding them", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark(),
      commits: [
        commit("a1", "feat: one (#1)", "2026-01-02T00:00:00Z"),
        commit("d1", "hotfix pushed directly", "2026-01-03T00:00:00Z"),
      ],
    });
    expect(window.skipped).toHaveLength(1);
  });

  it("is empty when nothing merged since the watermark", () => {
    const window = resolveWindow({
      strategy: "squash",
      watermark: watermark(),
      commits: [],
    });
    expect(window.entries).toEqual([]);
  });
});

describe("advanceWatermark", () => {
  const base: LearnWatermark = {
    ...emptyWatermark("main"),
    lastLearnedSha: "old",
    lastLearnedAt: "2026-01-01T00:00:00Z",
  };
  const entry = (pr: number, at: string, sha?: string): WindowEntry => ({
    pullRequestId: pr,
    mergedAt: at,
    via: "commit-subject",
    ...(sha ? { sha } : {}),
  });

  it("advances to the newest learned pull request", () => {
    const next = advanceWatermark(base, [
      entry(1, "2026-01-02T00:00:00Z", "s1"),
      entry(2, "2026-01-03T00:00:00Z", "s2"),
    ]);
    expect(next.lastLearnedSha).toBe("s2");
    expect(next.lastLearnedAt).toBe("2026-01-03T00:00:00Z");
  });

  it("ONLY advances past what succeeded — a failure stays in the window", () => {
    // Three were in the window; only the first two were learned from.
    const next = advanceWatermark(base, [
      entry(1, "2026-01-02T00:00:00Z", "s1"),
      entry(2, "2026-01-03T00:00:00Z", "s2"),
    ]);
    expect(next.lastLearnedAt).toBe("2026-01-03T00:00:00Z");
    // PR 3 at 2026-01-04 is after the watermark, so the next window includes it.
    expect(next.lastLearnedAt < "2026-01-04T00:00:00Z").toBe(true);
  });

  it("does not move when nothing was learned", () => {
    expect(advanceWatermark(base, [])).toBe(base);
  });

  it("NEVER rewinds — an out-of-order re-run must not re-learn everything after it", () => {
    const next = advanceWatermark(
      {
        ...base,
        lastLearnedAt: "2026-06-01T00:00:00Z",
        lastLearnedSha: "recent",
      },
      [entry(1, "2026-01-02T00:00:00Z", "ancient")],
    );
    expect(next.lastLearnedAt).toBe("2026-06-01T00:00:00Z");
    expect(next.lastLearnedSha).toBe("recent");
    // It is still recorded as processed, so it is not learned from again.
    expect(next.processed.some((p) => p.pr === 1)).toBe(true);
  });

  it("records processed pull requests newest first", () => {
    const next = advanceWatermark(base, [
      entry(1, "2026-01-02T00:00:00Z"),
      entry(2, "2026-01-03T00:00:00Z"),
    ]);
    expect(next.processed.map((p) => p.pr)).toEqual([2, 1]);
  });

  it("bounds the processed list", () => {
    let watermark = base;
    for (let index = 0; index < 250; index += 1) {
      watermark = advanceWatermark(watermark, [
        entry(
          index,
          `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`,
        ),
      ]);
    }
    expect(watermark.processed.length).toBeLessThanOrEqual(200);
  });

  it("keeps the previous sha when the newest entry has none", () => {
    const next = advanceWatermark(base, [entry(1, "2026-01-02T00:00:00Z")]);
    expect(next.lastLearnedSha).toBe("old");
    expect(next.lastLearnedAt).toBe("2026-01-02T00:00:00Z");
  });
});

describe("watermark persistence", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yama-wm-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips", async () => {
    const watermark = advanceWatermark(emptyWatermark("main"), [
      {
        pullRequestId: 5,
        mergedAt: "2026-01-02T00:00:00Z",
        sha: "s5",
        via: "trigger",
      },
    ]);
    await saveWatermark(root, watermark);

    const loaded = await loadWatermark(root, "main");
    expect(loaded.existed).toBe(true);
    expect(loaded.watermark.lastLearnedSha).toBe("s5");
  });

  it("starts fresh when absent", async () => {
    const loaded = await loadWatermark(root, "main");
    expect(loaded.existed).toBe(false);
    expect(loaded.watermark.processed).toEqual([]);
  });

  it("REFUSES a watermark from a different branch", async () => {
    await saveWatermark(root, {
      ...emptyWatermark("release/1.x"),
      lastLearnedAt: "2026-01-01T00:00:00Z",
    });

    const loaded = await loadWatermark(root, "main");
    expect(loaded.existed).toBe(false);
    expect(loaded.warning).toMatch(
      /tracks "release\/1\.x" but this run is on "main"/,
    );
  });

  it("degrades on a corrupt file rather than throwing", async () => {
    mkdirSync(join(root, ".yama", "knowledge"), { recursive: true });
    writeFileSync(
      join(root, ".yama", "knowledge", "learn-watermark.json"),
      "{ broken",
    );

    const loaded = await loadWatermark(root, "main");
    expect(loaded.existed).toBe(false);
    expect(loaded.warning).toMatch(/Could not read/);
  });

  it("lives under the knowledge base so it commits with what it tracks", () => {
    expect(watermarkRelativePath()).toBe(
      ".yama/knowledge/learn-watermark.json",
    );
  });
});

describe("describeWindow", () => {
  it("lists what will be learned from and why each was found", () => {
    const text = describeWindow(
      resolveWindow({
        strategy: "squash",
        watermark: {
          ...emptyWatermark("main"),
          lastLearnedAt: "2026-01-01T00:00:00Z",
          lastLearnedSha: "b",
        },
        commits: [
          commit("a1", "feat: one (#1)", "2026-01-02T00:00:00Z"),
          commit("d1", "direct push", "2026-01-03T00:00:00Z"),
        ],
      }),
    );

    expect(text).toMatch(/Learning from 1 pull request/);
    expect(text).toMatch(/#1 \(2026-01-02T00:00:00Z, via commit-subject\)/);
    expect(text).toMatch(/1 commit\(s\) carried no pull request reference/);
  });

  it("says plainly when there is nothing to do", () => {
    expect(
      describeWindow(
        resolveWindow({
          strategy: "squash",
          watermark: { ...emptyWatermark("main"), lastLearnedSha: "b" },
          commits: [],
        }),
      ),
    ).toMatch(/Nothing new to learn from/);
  });
});

describe("the trigger's timestamp must not poison the watermark", () => {
  it("stamps the trigger with NOW, not the epoch", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const window = resolveWindow({
      strategy: "rebase",
      watermark: emptyWatermark("main"),
      commits: [],
      triggerPullRequestId: 42,
      now: () => now,
    });

    expect(window.entries[0].mergedAt).toBe("2026-08-21T12:00:00.000Z");
  });

  it("an epoch stamp would make the next rebase window ask for ALL of history", () => {
    const now = new Date("2026-08-21T12:00:00.000Z");
    const first = resolveWindow({
      strategy: "rebase",
      watermark: emptyWatermark("main"),
      commits: [],
      triggerPullRequestId: 42,
      now: () => now,
    });
    const advanced = advanceWatermark(emptyWatermark("main"), first.entries);

    // The provider listing is filtered by this boundary. At the epoch it would
    // match every pull request the repository has ever merged.
    const merged = [
      { id: 1, mergedAt: "2020-01-01T00:00:00Z" },
      { id: 2, mergedAt: "2026-08-22T00:00:00Z" },
    ];
    expect(
      windowFromProvider(merged, advanced.lastLearnedAt).map(
        (e) => e.pullRequestId,
      ),
    ).toEqual([2]);
  });

  it("prefers a real trigger timestamp when the event supplied one", () => {
    const window = resolveWindow({
      strategy: "rebase",
      watermark: emptyWatermark("main"),
      commits: [],
      triggerPullRequestId: 42,
      triggerMergedAt: "2026-05-05T00:00:00Z",
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });
    expect(window.entries[0].mergedAt).toBe("2026-05-05T00:00:00Z");
  });
});
