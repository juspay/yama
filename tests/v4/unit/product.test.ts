import {
  buildImpactContext,
  capabilitiesForChange,
  capabilitiesForPaths,
  dependentsOf,
  historicalRisk,
  historyFor,
  inferCorrections,
  linkCorrection,
  renderImpactReport,
} from "../../../src/v4/product/Capabilities.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import type {
  ImpactLogEntry,
  ImpactReport,
  ProductCapability,
} from "../../../src/v4/types/index.js";

const capabilities: ProductCapability[] = [
  {
    id: "review.posting",
    name: "Findings reach the pull request",
    paths: ["src/v4/tools/posting.ts", "src/v4/findings/**"],
    userVisible: true,
    failureMode:
      "Findings are computed but never posted — fails silently, looks like a clean review",
    dependsOn: ["review.gate"],
    criticality: "high",
  },
  {
    id: "review.gate",
    name: "Finding gate",
    paths: ["src/v4/findings/Gate.ts"],
    criticality: "high",
  },
  {
    id: "review.verdict",
    name: "Verdict",
    paths: ["src/v4/core/verdict.ts"],
    dependsOn: ["review.posting"],
  },
  {
    id: "everything",
    name: "The whole product",
    paths: ["src/**"],
    criticality: "low",
  },
];

const diffFor = (paths: string[]): string =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n a\n+b\n`,
    )
    .join("");

const changeSetFor = (paths: string[]) =>
  buildChangeSet({ diff: diffFor(paths), excludePatterns: [], maxFiles: 100 });

const log: ImpactLogEntry[] = [
  {
    pullRequestId: 100,
    mergedAt: "2026-01-01",
    capabilities: ["review.posting"],
    changeKind: "behavior-change",
    summary: "Gate rejects findings outside the diff",
    laterCorrectedBy: [104],
  },
  {
    pullRequestId: 102,
    mergedAt: "2026-02-01",
    capabilities: ["review.posting"],
    changeKind: "internal",
    summary: "Refactor",
  },
  {
    pullRequestId: 104,
    mergedAt: "2026-03-01",
    capabilities: ["review.posting"],
    changeKind: "fix",
    summary: "Fix the rejection",
    corrects: [100],
  },
];

describe("capability resolution", () => {
  it("matches capabilities by path", () => {
    const matched = capabilitiesForPaths(capabilities, [
      "src/v4/findings/Gate.ts",
    ]);
    expect(matched.map((entry) => entry.id)).toContain("review.gate");
  });

  it("puts the most specific capability first", () => {
    const matched = capabilitiesForPaths(capabilities, [
      "src/v4/core/verdict.ts",
    ]);
    expect(matched[0].id).toBe("review.verdict");
    expect(matched[matched.length - 1].id).toBe("everything");
  });

  it("resolves from a change set, including excluded files", () => {
    const matched = capabilitiesForChange(
      capabilities,
      changeSetFor(["src/v4/tools/posting.ts"]),
    );
    expect(matched.map((entry) => entry.id)).toContain("review.posting");
  });

  it("returns nothing when no capability covers the change", () => {
    expect(capabilitiesForPaths(capabilities, ["docs/readme.md"])).toEqual([]);
  });
});

describe("dependents", () => {
  it("finds what depends on a capability, transitively", () => {
    const dependents = dependentsOf(capabilities, "review.gate");
    expect(dependents.map((entry) => entry.id).sort()).toEqual([
      "review.posting",
      "review.verdict",
    ]);
  });

  it("returns nothing for a leaf", () => {
    expect(dependentsOf(capabilities, "review.verdict")).toEqual([]);
  });

  it("tolerates a cycle rather than rejecting the map", () => {
    const cyclic: ProductCapability[] = [
      { id: "a", name: "A", paths: [], dependsOn: ["b"] },
      { id: "b", name: "B", paths: [], dependsOn: ["a"] },
    ];
    expect(dependentsOf(cyclic, "a").map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("history and risk", () => {
  it("returns a capability's history newest first", () => {
    expect(
      historyFor(log, "review.posting").map((entry) => entry.pullRequestId),
    ).toEqual([104, 102, 100]);
  });

  it("computes how often changes here needed correcting", () => {
    const risk = historicalRisk(log, "review.posting");
    expect(risk).toEqual({
      totalChanges: 3,
      corrected: 1,
      recentCorrections: [104],
    });
  });

  it("returns undefined when a capability has no history", () => {
    expect(historicalRisk(log, "review.gate")).toBeUndefined();
  });

  it("looks at a recent window, not all history", () => {
    const long: ImpactLogEntry[] = Array.from({ length: 20 }, (_, index) => ({
      pullRequestId: index,
      mergedAt: `2026-01-${String(index + 1).padStart(2, "0")}`,
      capabilities: ["x"],
      changeKind: "internal" as const,
      summary: "s",
      // Only the oldest entries were ever corrected.
      ...(index < 5 ? { laterCorrectedBy: [999] } : {}),
    }));
    const risk = historicalRisk(long, "x", 10);
    expect(risk?.totalChanges).toBe(10);
    expect(risk?.corrected).toBe(0);
  });
});

describe("correction linking", () => {
  it("backfills the corrected entry", () => {
    const updated = linkCorrection(
      [
        {
          pullRequestId: 200,
          mergedAt: "d",
          capabilities: [],
          changeKind: "internal",
          summary: "s",
        },
      ],
      { pullRequestId: 201, corrects: [200] },
    );
    expect(updated[0].laterCorrectedBy).toEqual([201]);
  });

  it("does not duplicate an existing link", () => {
    const updated = linkCorrection(
      [
        {
          pullRequestId: 200,
          mergedAt: "d",
          capabilities: [],
          changeKind: "internal",
          summary: "s",
          laterCorrectedBy: [201],
        },
      ],
      { pullRequestId: 201, corrects: [200] },
    );
    expect(updated[0].laterCorrectedBy).toEqual([201]);
  });

  it("leaves unrelated entries untouched", () => {
    const original: ImpactLogEntry[] = [
      {
        pullRequestId: 1,
        mergedAt: "d",
        capabilities: [],
        changeKind: "internal",
        summary: "s",
      },
    ];
    expect(
      linkCorrection(original, { pullRequestId: 2, corrects: [99] })[0],
    ).toBe(original[0]);
  });
});

describe("inferCorrections", () => {
  it("detects a git revert and what it reverted", () => {
    const result = inferCorrections('Revert "feat: new gate (#142)"');
    expect(result.kind).toBe("revert");
    expect(result.corrects).toContain(142);
  });

  it("detects a conventional revert", () => {
    expect(inferCorrections("revert: undo the gate change (#142)").kind).toBe(
      "revert",
    );
  });

  it("detects a fix referencing what it fixes", () => {
    const result = inferCorrections(
      "fix(gate): stop dropping findings\n\nFixes #142",
    );
    expect(result.kind).toBe("fix");
    expect(result.corrects).toEqual([142]);
  });

  it("classifies ordinary commit kinds", () => {
    expect(inferCorrections("perf: cache tool results").kind).toBe("perf");
    expect(inferCorrections("refactor: split the orchestrator").kind).toBe(
      "internal",
    );
    expect(inferCorrections("chore(deps): bump").kind).toBe("internal");
  });

  it("does not guess for a plain feature commit", () => {
    const result = inferCorrections("feat: add impact analysis");
    expect(result.kind).toBeUndefined();
    expect(result.corrects).toEqual([]);
  });

  it("does not treat a stray issue reference in a feature commit as a correction", () => {
    expect(inferCorrections("feat: add thing for #7").corrects).toEqual([]);
  });
});

describe("buildImpactContext", () => {
  it("assembles what the impact specialist starts from", () => {
    const context = buildImpactContext(
      capabilities,
      log,
      changeSetFor(["src/v4/findings/Gate.ts"]),
    );

    expect(context.touched.map((entry) => entry.id)).toContain("review.gate");
    expect(context.dependents.map((entry) => entry.id)).toContain(
      "review.verdict",
    );
  });

  it("surfaces silent failure modes — the thing a diff never says", () => {
    const context = buildImpactContext(
      capabilities,
      log,
      changeSetFor(["src/v4/tools/posting.ts"]),
    );
    expect(context.silentFailureModes[0]).toMatch(/fails silently/i);
  });

  it("attaches historical risk per touched capability", () => {
    const context = buildImpactContext(
      capabilities,
      log,
      changeSetFor(["src/v4/tools/posting.ts"]),
    );
    const posting = context.risk.find(
      (entry) => entry.capabilityId === "review.posting",
    );
    expect(posting?.risk?.corrected).toBe(1);
  });

  it("does not list a touched capability as its own dependent", () => {
    const context = buildImpactContext(
      capabilities,
      log,
      changeSetFor(["src/v4/findings/Gate.ts", "src/v4/tools/posting.ts"]),
    );
    const touchedIds = new Set(context.touched.map((entry) => entry.id));
    expect(context.dependents.every((entry) => !touchedIds.has(entry.id))).toBe(
      true,
    );
  });

  it("deduplicates recent changes across capabilities", () => {
    const context = buildImpactContext(
      capabilities,
      log,
      changeSetFor(["src/v4/tools/posting.ts", "src/v4/findings/Gate.ts"]),
    );
    const ids = context.recentChanges.map((entry) => entry.pullRequestId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderImpactReport", () => {
  const report: ImpactReport = {
    capabilities: [
      {
        id: "review.posting",
        name: "Findings reach the pull request",
        criticality: "high",
      },
    ],
    changeKind: "behavior-change",
    blastRadius: "every review run; 2 dependent capabilities",
    userVisibleEffect: "Comments on unmodified lines stop appearing",
    silentFailureModes: ["Posting: fails silently, looks like a clean review"],
    historicalRisk: {
      totalChanges: 8,
      corrected: 3,
      recentCorrections: [104, 118, 130],
    },
    suggestedTests: ["finding on an unchanged line is rejected"],
    unresolved: ["the Bitbucket posting path was not traced"],
  };

  it("leads with what it touches and how it fails", () => {
    const body = renderImpactReport(report);
    expect(body).toMatch(
      /\*\*Touches:\*\* Findings reach the pull request \(high\)/,
    );
    expect(body).toMatch(/\*\*Fails silently:\*\*/);
  });

  it("states the historical risk in plain numbers", () => {
    expect(renderImpactReport(report)).toMatch(
      /needed correction in 3 of the last 8 changes \(#104, #118, #130\)/,
    );
  });

  it("omits historical risk when nothing has needed correcting", () => {
    const body = renderImpactReport({
      ...report,
      historicalRisk: { totalChanges: 5, corrected: 0, recentCorrections: [] },
    });
    expect(body).not.toMatch(/Historical risk/);
  });

  it("lists suggested tests and what it could not trace", () => {
    const body = renderImpactReport(report);
    expect(body).toMatch(/Worth testing/);
    expect(body).toMatch(/Not traced/);
    expect(body).toMatch(/Bitbucket posting path/);
  });

  it("renders a minimal report without empty sections", () => {
    const body = renderImpactReport({
      capabilities: [],
      changeKind: "internal",
      blastRadius: "none",
      silentFailureModes: [],
      suggestedTests: [],
      unresolved: [],
    });
    expect(body).not.toMatch(/Touches/);
    expect(body).not.toMatch(/Worth testing/);
    expect(body).toMatch(/\*\*Change kind:\*\* internal/);
  });
});
