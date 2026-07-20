/**
 * Phase 2: cross-run review state — id stability, reconciliation semantics,
 * store roundtrips, prompt formatting.
 */
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileStateStore,
  InlineStateStore,
  buildFindingId,
  createStateStore,
  formatOpenFindingsForPrompt,
  reconcileFindings,
} from "../../../src/v2/state/ReviewStateStore.js";
import { ReviewState } from "../../../src/v2/types/index.js";

const finding = (over: Record<string, unknown> = {}) => ({
  id: buildFindingId({
    filePath: "src/a.ts",
    severity: "MAJOR",
    category: "bugs",
    title: "Null deref",
  }),
  filePath: "src/a.ts",
  line: 10,
  severity: "MAJOR" as const,
  title: "Null deref",
  ...over,
});

describe("buildFindingId", () => {
  it("is stable across runs and whitespace/case noise", () => {
    const a = buildFindingId({
      filePath: "src/a.ts",
      severity: "MAJOR",
      category: "bugs",
      title: "Null   Deref",
    });
    const b = buildFindingId({
      filePath: "src/a.ts",
      severity: "major",
      category: "Bugs",
      title: "null deref",
    });
    expect(a).toBe(b);
  });
  it("differs when the file or claim differs", () => {
    const a = buildFindingId({ filePath: "src/a.ts", title: "x" });
    const b = buildFindingId({ filePath: "src/b.ts", title: "x" });
    expect(a).not.toBe(b);
  });
});

describe("reconcileFindings", () => {
  it("first run: everything is new and open", () => {
    const { state, newFindingIds } = reconcileFindings({
      previous: null,
      key: "k",
      sha: "abc",
      decision: "CHANGES_REQUESTED",
      currentFindings: [finding()],
    });
    expect(newFindingIds.size).toBe(1);
    expect(state.findings[0].status).toBe("open");
    expect(state.findings[0].firstReportedRun).toBe(0);
    expect(state.runs).toHaveLength(1);
    expect(state.lastReviewedSha).toBe("abc");
  });

  it("re-reported finding is NOT new (no duplicate posting)", () => {
    const first = reconcileFindings({
      previous: null,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [finding()],
    });
    const second = reconcileFindings({
      previous: first.state,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [finding()],
    });
    expect(second.newFindingIds.size).toBe(0);
    expect(second.state.findings).toHaveLength(1);
    expect(second.state.findings[0].firstReportedRun).toBe(0);
  });

  it("agent-resolved ids become fixed; unmentioned ones are carried", () => {
    const open1 = finding();
    const open2 = finding({
      id: buildFindingId({ filePath: "src/b.ts", title: "Leak" }),
      filePath: "src/b.ts",
      title: "Leak",
    });
    const first = reconcileFindings({
      previous: null,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [open1, open2],
    });
    const second = reconcileFindings({
      previous: first.state,
      key: "k",
      decision: "APPROVED",
      currentFindings: [],
      resolvedIds: [open1.id],
    });
    const byId = new Map(second.state.findings.map((f) => [f.id, f]));
    expect(byId.get(open1.id)?.status).toBe("fixed");
    expect(byId.get(open2.id)?.status).toBe("carried");
    expect(second.resolvedFindingIds.has(open1.id)).toBe(true);
  });

  it("fixed findings stay fixed on later runs", () => {
    const f = finding();
    const r1 = reconcileFindings({
      previous: null,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [f],
    });
    const r2 = reconcileFindings({
      previous: r1.state,
      key: "k",
      decision: "APPROVED",
      currentFindings: [],
      resolvedIds: [f.id],
    });
    const r3 = reconcileFindings({
      previous: r2.state,
      key: "k",
      decision: "APPROVED",
      currentFindings: [],
    });
    expect(r3.state.findings[0].status).toBe("fixed");
    expect(r3.state.runs).toHaveLength(3);
  });
});

describe("state stores", () => {
  it("file store roundtrips and survives a fresh instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yama-state-"));
    const store = new FileStateStore(dir);
    const { state } = reconcileFindings({
      previous: null,
      key: "gh-o-r-pr-1",
      decision: "BLOCKED",
      currentFindings: [finding()],
    });
    await store.save("gh-o-r-pr-1", state);
    const reloaded = await new FileStateStore(dir).load("gh-o-r-pr-1");
    expect(reloaded?.findings).toHaveLength(1);
    expect(reloaded?.key).toBe("gh-o-r-pr-1");
  });

  it("file store returns null for missing/corrupt state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yama-state-"));
    const store = new FileStateStore(dir);
    expect(await store.load("nope")).toBeNull();
  });

  it("inline store loads provided content and exposes saves", async () => {
    const { state } = reconcileFindings({
      previous: null,
      key: "k",
      decision: "APPROVED",
      currentFindings: [],
    });
    const store = new InlineStateStore(JSON.stringify(state));
    const loaded = await store.load("k");
    expect(loaded?.key).toBe("k");
    await store.save("k", { ...loaded!, lastReviewedSha: "zzz" });
    expect(store.getSaved()?.lastReviewedSha).toBe("zzz");
  });

  it("factory honours enabled=false and defaults to file", () => {
    expect(createStateStore({ enabled: false })).toBeNull();
    expect(createStateStore(undefined)?.kind).toBe("file");
    expect(createStateStore({ store: "inline" })?.kind).toBe("inline");
    expect(createStateStore({ store: "github-artifact" })?.kind).toBe(
      "github-artifact",
    );
  });
});

describe("formatOpenFindingsForPrompt", () => {
  it("lists open and carried findings with ids, skips fixed", () => {
    const state: ReviewState = {
      schemaVersion: 1,
      key: "k",
      runs: [],
      findings: [
        { ...finding(), status: "open", firstReportedRun: 0 },
        {
          ...finding({
            id: "deadbeef00000000",
            filePath: "src/b.ts",
            title: "Leak",
          }),
          status: "fixed",
          firstReportedRun: 0,
        },
      ],
    };
    const block = formatOpenFindingsForPrompt(state);
    expect(block).toContain("Null deref");
    expect(block).toContain(finding().id);
    expect(block).not.toContain("Leak");
  });
});

describe("auto-suppression (Phase 5)", () => {
  it("increments dismissCount for carried findings and suppresses at 3", async () => {
    const { collectSuppressedIds } = await import(
      "../../../src/v2/state/ReviewStateStore.js"
    );
    const f = finding();
    let state = reconcileFindings({
      previous: null,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [f],
    }).state;
    for (let run = 0; run < 3; run++) {
      state = reconcileFindings({
        previous: state,
        key: "k",
        decision: "CHANGES_REQUESTED",
        currentFindings: [],
      }).state;
    }
    expect(state.findings[0].dismissCount).toBe(3);
    expect(collectSuppressedIds(state).has(f.id)).toBe(true);
  });

  it("does not suppress below the threshold", async () => {
    const { collectSuppressedIds } = await import(
      "../../../src/v2/state/ReviewStateStore.js"
    );
    const f = finding();
    let state = reconcileFindings({
      previous: null,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [f],
    }).state;
    state = reconcileFindings({
      previous: state,
      key: "k",
      decision: "CHANGES_REQUESTED",
      currentFindings: [],
    }).state;
    expect(collectSuppressedIds(state).size).toBe(0);
  });
});
