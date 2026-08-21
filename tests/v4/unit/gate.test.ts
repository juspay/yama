import {
  applySeverityFloor,
  gateFindings,
} from "../../../src/v4/findings/Gate.js";
import {
  buildFindingId,
  isBotAuthored,
  parseMarkers,
  renderMarker,
  scanMarkers,
  withMarker,
} from "../../../src/v4/findings/Markers.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import type {
  CandidateFinding,
  ExistingComment,
  GuardRule,
  IdentifiedFinding,
} from "../../../src/v4/types/index.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,5 @@
   const a = 1;
+  const b = eval(input);
+  const c = 3;
   return a;
`;

const changeSet = buildChangeSet({
  diff: DIFF,
  excludePatterns: [],
  maxFiles: 100,
});

const EMPTY = new Set<string>();

function candidate(
  overrides: Partial<CandidateFinding> = {},
): Omit<IdentifiedFinding, "id"> {
  return {
    severity: "MAJOR",
    title: "Unsafe eval on user input",
    filePath: "src/app.ts",
    line: 11,
    suggestion: "Use JSON.parse with validation instead of eval.",
    impact: "Remote code execution from any request body.",
    source: "agent",
    ...overrides,
  } as Omit<IdentifiedFinding, "id">;
}

function gate(
  findings: Array<Omit<IdentifiedFinding, "id"> & { id?: string }>,
  overrides: Partial<Parameters<typeof gateFindings>[0]> = {},
) {
  return gateFindings({
    findings,
    changeSet,
    alreadyReported: EMPTY,
    alreadyAccepted: EMPTY,
    suppressed: EMPTY,
    confidenceThreshold: 80,
    changedLinesOnly: true,
    dryRun: false,
    ...overrides,
  });
}

describe("buildFindingId", () => {
  it("is stable for the same finding", () => {
    expect(buildFindingId(candidate())).toBe(buildFindingId(candidate()));
  });

  it("ignores case and whitespace noise in the title", () => {
    expect(
      buildFindingId(candidate({ title: "  UNSAFE   eval on user input " })),
    ).toBe(buildFindingId(candidate()));
  });

  it("changes with severity, path, line, or title", () => {
    const base = buildFindingId(candidate());
    expect(buildFindingId(candidate({ severity: "CRITICAL" }))).not.toBe(base);
    expect(buildFindingId(candidate({ filePath: "src/other.ts" }))).not.toBe(
      base,
    );
    expect(buildFindingId(candidate({ line: 12 }))).not.toBe(base);
    expect(buildFindingId(candidate({ title: "Something else" }))).not.toBe(
      base,
    );
  });

  it("is unaffected by rephrased prose — the problem did not change", () => {
    expect(
      buildFindingId(candidate({ description: "a", suggestion: "x" })),
    ).toBe(buildFindingId(candidate({ description: "b", suggestion: "y" })));
  });

  it("handles a file-level finding with no line", () => {
    expect(buildFindingId(candidate({ line: null }))).toBeTruthy();
  });
});

describe("markers", () => {
  it("renders and parses each kind", () => {
    expect(renderMarker("finding", "abc123")).toBe(
      "<!-- yama:finding:abc123 -->",
    );
    expect(renderMarker("summary")).toBe("<!-- yama:summary -->");
    expect(parseMarkers("text <!-- yama:finding:abc123 -->")).toEqual([
      { kind: "finding", id: "abc123" },
    ]);
    expect(parseMarkers("<!-- yama:summary -->")).toEqual([
      { kind: "summary" },
    ]);
  });

  it("finds several markers in one body", () => {
    expect(
      parseMarkers("<!-- yama:finding:a --> and <!-- yama:finding:b -->"),
    ).toHaveLength(2);
  });

  it("is not stateful across calls", () => {
    const body = "<!-- yama:finding:a -->";
    expect(parseMarkers(body)).toHaveLength(1);
    expect(parseMarkers(body)).toHaveLength(1);
  });

  it("withMarker appends once and is idempotent", () => {
    const once = withMarker("body", "finding", "a");
    expect(once).toContain("<!-- yama:finding:a -->");
    expect(withMarker(once, "finding", "a")).toBe(once);
  });

  describe("trust", () => {
    it("only trusts the configured bot identity", () => {
      expect(
        isBotAuthored({ id: "1", body: "", author: "yama-bot" }, "yama-bot"),
      ).toBe(true);
      expect(
        isBotAuthored({ id: "1", body: "", author: "Yama-Bot" }, "yama-bot"),
      ).toBe(true);
      expect(
        isBotAuthored({ id: "1", body: "", author: "alice" }, "yama-bot"),
      ).toBe(false);
    });

    it("trusts nothing when no identity is configured", () => {
      expect(
        isBotAuthored({ id: "1", body: "", author: "yama-bot" }, undefined),
      ).toBe(false);
    });
  });

  describe("scanMarkers", () => {
    const comments: ExistingComment[] = [
      {
        id: "c1",
        author: "yama-bot",
        body: "finding one\n<!-- yama:finding:aaa -->",
      },
      { id: "c2", author: "yama-bot", body: "summary\n<!-- yama:summary -->" },
      { id: "c3", author: "alice", body: "quoting <!-- yama:finding:bbb -->" },
      { id: "c4", author: "yama-bot", body: "owners\n<!-- yama:owners -->" },
    ];

    it("collects finding ids from bot comments only", () => {
      const scan = scanMarkers(comments, "yama-bot");
      expect([...scan.reportedFindingIds]).toEqual(["aaa"]);
      expect(scan.commentByFinding.get("aaa")).toBe("c1");
    });

    it("counts but never trusts a marker quoted by a human", () => {
      const scan = scanMarkers(comments, "yama-bot");
      expect(scan.untrustedMarkers).toBe(1);
      expect(scan.reportedFindingIds.has("bbb")).toBe(false);
    });

    it("locates the summary and owners comments for in-place update", () => {
      const scan = scanMarkers(comments, "yama-bot");
      expect(scan.summaryCommentId).toBe("c2");
      expect(scan.ownersCommentId).toBe("c4");
    });

    it("converges on the newest summary when older runs left several", () => {
      const scan = scanMarkers(
        [
          { id: "old", author: "yama-bot", body: "<!-- yama:summary -->" },
          { id: "new", author: "yama-bot", body: "<!-- yama:summary -->" },
        ],
        "yama-bot",
      );
      expect(scan.summaryCommentId).toBe("new");
    });

    it("trusts nothing without a bot identity", () => {
      const scan = scanMarkers(comments, undefined);
      expect(scan.reportedFindingIds.size).toBe(0);
      expect(scan.summaryCommentId).toBeUndefined();
    });
  });
});

describe("gate invariants", () => {
  it("accepts a well-formed finding on a changed line", () => {
    const result = gate([candidate()]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("1 — rejects a duplicate inside one submission", () => {
    const result = gate([candidate(), candidate()]);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("duplicate-in-batch");
  });

  it("2 — rejects a finding already posted on the pull request", () => {
    const id = buildFindingId(candidate());
    const result = gate([candidate()], { alreadyReported: new Set([id]) });
    expect(result.rejected[0].reason).toBe("already-reported");
    expect(result.rejected[0].detail).toMatch(
      /already exists on the pull request/,
    );
  });

  it("3 — rejects a finding accepted earlier in this run", () => {
    const id = buildFindingId(candidate());
    const result = gate([candidate()], { alreadyAccepted: new Set([id]) });
    expect(result.rejected[0].reason).toBe("already-accepted");
  });

  it("4 — rejects a learned false positive", () => {
    const id = buildFindingId(candidate());
    const result = gate([candidate()], { suppressed: new Set([id]) });
    expect(result.rejected[0].reason).toBe("suppressed");
  });

  it("5a — rejects a finding about a file the PR did not touch", () => {
    const result = gate([candidate({ filePath: "src/untouched.ts" })]);
    expect(result.rejected[0].reason).toBe("file-not-in-change");
  });

  it("5b — rejects a finding on a line the PR did not change", () => {
    const result = gate([candidate({ line: 10 })]);
    expect(result.rejected[0].reason).toBe("line-not-changed");
    expect(result.rejected[0].detail).toMatch(/newly reachable/);
  });

  it("5b — allows unchanged lines when the project opts out", () => {
    const result = gate([candidate({ line: 10 })], { changedLinesOnly: false });
    expect(result.accepted).toHaveLength(1);
  });

  it("5 — exempts policy findings, which are about the change as a whole", () => {
    const result = gate([
      candidate({
        source: "policy",
        filePath: undefined,
        line: null,
        severity: "MAJOR",
        suggestion: "Get an approval.",
      }),
    ]);
    expect(result.accepted).toHaveLength(1);
  });

  it("6 — drops an agent finding a check already reported", () => {
    const result = gate([candidate()], {
      checkFlagged: new Set(["src/app.ts:11"]),
    });
    expect(result.rejected[0].reason).toBe("already-flagged-by-check");
  });

  it("6 — does not drop the check's own finding at that location", () => {
    const result = gate([candidate({ source: "check", checkId: "lint" })], {
      checkFlagged: new Set(["src/app.ts:11"]),
    });
    expect(result.accepted).toHaveLength(1);
  });

  it("7 — rejects a CRITICAL with no fix", () => {
    const result = gate([
      candidate({ severity: "CRITICAL", suggestion: undefined }),
    ]);
    expect(result.rejected[0].reason).toBe("missing-fix");
    expect(result.rejected[0].detail).toMatch(/must carry a concrete fix/);
  });

  it("7 — rejects a MAJOR whose fix is only whitespace", () => {
    const result = gate([candidate({ suggestion: "   " })]);
    expect(result.rejected[0].reason).toBe("missing-fix");
  });

  it("7 — does not demand a fix for MINOR or SUGGESTION", () => {
    const result = gate([
      candidate({
        severity: "MINOR",
        suggestion: undefined,
        title: "Naming nit",
      }),
      candidate({
        severity: "SUGGESTION",
        suggestion: undefined,
        title: "Could simplify",
      }),
    ]);
    expect(result.accepted).toHaveLength(2);
  });

  it("8 — rejects an agent finding below the confidence threshold", () => {
    const id = buildFindingId(candidate());
    const result = gate([candidate()], {
      confidence: new Map([[id, 62]]),
    });
    expect(result.rejected[0].reason).toBe("below-confidence");
    expect(result.rejected[0].detail).toMatch(/62\/100/);
  });

  it("8 — accepts at exactly the threshold", () => {
    const id = buildFindingId(candidate());
    const result = gate([candidate()], { confidence: new Map([[id, 80]]) });
    expect(result.accepted).toHaveLength(1);
  });

  it("8 — never judges a check finding: a compiler error is not probabilistic", () => {
    const finding = candidate({
      source: "check",
      checkId: "tsc",
      title: "TS2345",
    });
    const result = gate([finding], {
      confidence: new Map([[buildFindingId(finding), 5]]),
    });
    expect(result.accepted).toHaveLength(1);
  });

  it("8 — accepts an unjudged finding rather than assuming the worst", () => {
    const result = gate([candidate()], { confidence: new Map() });
    expect(result.accepted).toHaveLength(1);
  });
});

describe("severity floors", () => {
  const guards: GuardRule[] = [
    { id: "payments", paths: ["src/app.ts"], severityFloor: "MAJOR" },
    { id: "stricter", paths: ["src/app.ts"], severityFloor: "CRITICAL" },
  ];

  it("raises a finding to the highest matching floor", () => {
    const raised = applySeverityFloor(
      { ...candidate({ severity: "SUGGESTION" }), id: "x" },
      guards,
    );
    expect(raised.severity).toBe("CRITICAL");
  });

  it("re-derives the id so a promoted finding does not collide with its twin", () => {
    const raised = applySeverityFloor(
      { ...candidate({ severity: "MINOR" }), id: "stale" },
      guards,
    );
    expect(raised.id).not.toBe("stale");
    expect(raised.id).toBe(buildFindingId(raised));
  });

  it("never lowers a severity", () => {
    const unchanged = applySeverityFloor(
      { ...candidate({ severity: "CRITICAL" }), id: "x" },
      [{ id: "g", paths: ["src/app.ts"], severityFloor: "MINOR" }],
    );
    expect(unchanged.severity).toBe("CRITICAL");
  });

  it("ignores guards for other paths", () => {
    const unchanged = applySeverityFloor(
      { ...candidate({ severity: "MINOR" }), id: "x" },
      [{ id: "g", paths: ["other/**"], severityFloor: "CRITICAL" }],
    );
    expect(unchanged.severity).toBe("MINOR");
  });

  it("a floored finding must then also carry a fix", () => {
    const result = gate(
      [candidate({ severity: "SUGGESTION", suggestion: undefined })],
      {
        guards: [{ id: "g", paths: ["src/app.ts"], severityFloor: "MAJOR" }],
      },
    );
    expect(result.rejected[0].reason).toBe("missing-fix");
  });
});

describe("gate instruction", () => {
  it("tells the agent to post now, and to post nothing for rejections", () => {
    const result = gate([candidate(), candidate({ line: 10, title: "Other" })]);
    expect(result.instruction).toMatch(
      /Post exactly one inline comment for each, now/,
    );
    expect(result.instruction).toMatch(/Post nothing for the 1 rejected/);
  });

  it("tells a dry run not to post", () => {
    const result = gate([candidate()], { dryRun: true });
    expect(result.instruction).toMatch(/dry run: do not post anything/);
  });

  it("explains a wholly-rejected submission", () => {
    const result = gate([candidate({ filePath: "nope.ts" })]);
    expect(result.instruction).toMatch(/All 1 finding\(s\) were rejected/);
  });

  it("says plainly when nothing was submitted", () => {
    expect(gate([]).instruction).toBe("Nothing submitted.");
  });
});

describe("gate without a change set", () => {
  it("skips structural checks when no diff is available", () => {
    const result = gate([candidate({ filePath: "anything.ts", line: 999 })], {
      changeSet: undefined,
    });
    expect(result.accepted).toHaveLength(1);
  });
});
