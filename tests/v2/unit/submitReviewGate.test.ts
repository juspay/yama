/**
 * Phase 3: the submit_review gate — dedup precedence, critic verdict
 * application, strict-mode policy, and agent instructions.
 */
import { describe, it, expect } from "@jest/globals";
import { gateFindings } from "../../../src/v2/harness/submitReviewGate.js";
import {
  CriticVerdict,
  SubmitReviewAccepted,
} from "../../../src/v2/types/index.js";

const finding = (
  id: string,
  over: Partial<SubmitReviewAccepted> = {},
): SubmitReviewAccepted => ({
  id,
  severity: "MAJOR",
  title: `finding ${id}`,
  filePath: "src/a.ts",
  line: 5,
  ...over,
});

const confirmed = (id: string): CriticVerdict => ({
  id,
  verdict: "confirmed",
  reason: "solid",
});

describe("gateFindings", () => {
  it("accepts confirmed new findings and records the posting instruction", () => {
    const result = gateFindings({
      findings: [finding("a")],
      verdicts: [confirmed("a")],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      mode: "basic",
      dryRun: false,
    });
    expect(result.accepted.map((f) => f.id)).toEqual(["a"]);
    expect(result.rejected).toHaveLength(0);
    expect(result.instruction).toContain("Post ONE inline comment");
  });

  it("rejects previously-reported findings before anything else", () => {
    const result = gateFindings({
      findings: [finding("a")],
      verdicts: [confirmed("a")],
      previouslyReportedIds: new Set(["a"]),
      alreadyAcceptedIds: new Set(),
      mode: "basic",
      dryRun: false,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("previous run");
  });

  it("rejects in-batch duplicates and same-run resubmissions", () => {
    const result = gateFindings({
      findings: [finding("a"), finding("a"), finding("b")],
      verdicts: [confirmed("a"), confirmed("b")],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(["b"]),
      mode: "basic",
      dryRun: false,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].id).toBe("a");
    expect(result.rejected).toHaveLength(2);
  });

  it("applies critic refutations with the critic's reason", () => {
    const result = gateFindings({
      findings: [finding("a")],
      verdicts: [{ id: "a", verdict: "refuted", reason: "style nit as MAJOR" }],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      mode: "basic",
      dryRun: false,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("style nit as MAJOR");
  });

  it("uncertain passes in basic mode but is rejected in strict mode", () => {
    const uncertain: CriticVerdict = {
      id: "a",
      verdict: "uncertain",
      reason: "no evidence",
    };
    const basic = gateFindings({
      findings: [finding("a")],
      verdicts: [uncertain],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      mode: "basic",
      dryRun: false,
    });
    expect(basic.accepted).toHaveLength(1);

    const strict = gateFindings({
      findings: [finding("a")],
      verdicts: [uncertain],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      mode: "strict",
      dryRun: false,
    });
    expect(strict.accepted).toHaveLength(0);
    expect(strict.rejected[0].reason).toContain("strict verification");
  });

  it("suppressed (learned false-positive) ids are rejected", () => {
    const result = gateFindings({
      findings: [finding("a")],
      verdicts: [confirmed("a")],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      suppressedIds: new Set(["a"]),
      mode: "off",
      dryRun: false,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toContain("false positive");
  });

  it("dry-run instruction forbids posting", () => {
    const result = gateFindings({
      findings: [finding("a")],
      verdicts: [confirmed("a")],
      previouslyReportedIds: new Set(),
      alreadyAcceptedIds: new Set(),
      mode: "basic",
      dryRun: true,
    });
    expect(result.instruction).toContain("do not post");
  });
});
