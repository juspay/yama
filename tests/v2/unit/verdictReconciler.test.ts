/**
 * Verdict reconciliation — the gate anchor that stops fabricated verdicts
 * (observed: a partial run's tools-off verdict recovery invented an issues
 * list from the rules prompt and BLOCKED a PR on findings nobody verified).
 */

import { describe, it, expect } from "@jest/globals";
import { reconcileVerdictWithGate } from "../../../src/v2/harness/verdictReconciler.js";
import { LocalReviewFinding } from "../../../src/v2/types/index.js";

const finding = (
  over: Partial<LocalReviewFinding> = {},
): LocalReviewFinding => ({
  id: "id-1",
  severity: "MAJOR",
  category: "correctness",
  title: "Truncation drops the closing brace",
  description: "short",
  filePath: "src/core/utils/json.ts",
  line: 42,
  ...over,
});

describe("reconcileVerdictWithGate", () => {
  it("keeps every gated finding and quarantines verdict issues that match none", () => {
    const gated = [finding()];
    const fabricated = finding({
      id: "issue-1",
      title: "interface keyword used instead of type",
      filePath: "src/features/tara/tools/commands/index.ts",
      line: undefined,
    });
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [fabricated],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].title).toBe("Truncation drops the closing brace");
    expect(ungatedIssues).toHaveLength(1);
    expect(ungatedIssues[0].title).toBe(
      "interface keyword used instead of type",
    );
  });

  it("matches a rephrased verdict issue by file+line+severity and enriches prose", () => {
    const gated = [finding({ description: "short" })];
    const rephrased = finding({
      id: "issue-1",
      title: "JSON truncation loses the terminating brace of the envelope",
      description:
        "A much longer, richer description written after deeper analysis of the change.",
      suggestion: "Close containers from the salvage stack.",
    });
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [rephrased],
    });

    expect(ungatedIssues).toHaveLength(0);
    expect(issues[0].description).toContain("richer description");
    expect(issues[0].suggestion).toBe(
      "Close containers from the salvage stack.",
    );
    // Gate stays authoritative for identity and severity.
    expect(issues[0].id).toBe("id-1");
    expect(issues[0].severity).toBe("MAJOR");
  });

  it("matches by file+title when the line moved", () => {
    const gated = [finding({ line: 42 })];
    const moved = finding({ id: "issue-9", line: 58 });
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [moved],
    });
    expect(issues).toHaveLength(1);
    expect(ungatedIssues).toHaveLength(0);
  });

  it("never matches when either side lacks a filePath", () => {
    const gated = [finding({ filePath: undefined })];
    const sameTitleNoFile = finding({ id: "issue-3", filePath: undefined });
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [sameTitleNoFile],
    });
    // The gated finding survives untouched; the location-less verdict issue
    // must not glue onto it by title alone.
    expect(issues).toHaveLength(1);
    expect(ungatedIssues).toHaveLength(1);
  });

  it("never matches across files", () => {
    const gated = [finding()];
    const otherFile = finding({ id: "issue-2", filePath: "src/other.ts" });
    const { ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [otherFile],
    });
    expect(ungatedIssues).toHaveLength(1);
  });

  it("returns gated findings untouched when the verdict is empty", () => {
    const gated = [finding(), finding({ id: "id-2", title: "Second" })];
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: [],
    });
    expect(issues).toHaveLength(2);
    expect(ungatedIssues).toHaveLength(0);
  });

  it("claims each verdict issue at most once", () => {
    const gated = [
      finding({ id: "id-1", title: "Same title", line: 10 }),
      finding({ id: "id-2", title: "Same title", line: 20 }),
    ];
    const verdict = [finding({ id: "issue-1", title: "Same title", line: 10 })];
    const { issues, ungatedIssues } = reconcileVerdictWithGate({
      gatedFindings: gated,
      verdictIssues: verdict,
    });
    expect(issues).toHaveLength(2);
    expect(ungatedIssues).toHaveLength(0);
  });
});
