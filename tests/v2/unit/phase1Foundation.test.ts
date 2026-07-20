/**
 * Phase 1 foundation: duration parsing, partial-review decision policy, and
 * honest completion metadata from NeuroLink responses.
 */
import { describe, it, expect } from "@jest/globals";
import { parseDurationMs } from "../../../src/v2/utils/duration.js";
import { deriveDecision } from "../../../src/v2/core/reviewDecision.js";
import { ReviewResultParser } from "../../../src/v2/core/ReviewResultParser.js";
import { SessionManager } from "../../../src/v2/core/SessionManager.js";
import { IssuesBySeverity } from "../../../src/v2/types/index.js";

const none: IssuesBySeverity = {
  critical: 0,
  major: 0,
  minor: 0,
  suggestions: 0,
};

describe("parseDurationMs", () => {
  it("parses unit suffixes", () => {
    expect(parseDurationMs("15m")).toBe(900_000);
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("500ms")).toBe(500);
  });
  it("accepts bare numbers as ms", () => {
    expect(parseDurationMs(1500)).toBe(1500);
    expect(parseDurationMs("250")).toBe(250);
  });
  it("returns undefined for invalid input", () => {
    expect(parseDurationMs(undefined)).toBeUndefined();
    expect(parseDurationMs("")).toBeUndefined();
    expect(parseDurationMs("soon")).toBeUndefined();
    expect(parseDurationMs(-5)).toBeUndefined();
    expect(parseDurationMs("0m")).toBeUndefined();
  });
});

describe("deriveDecision partial policy", () => {
  it("downgrades an approval when the review is partial", () => {
    expect(deriveDecision("APPROVED", none, { partial: true })).toBe(
      "CHANGES_REQUESTED",
    );
  });
  it("leaves non-approvals unchanged when partial", () => {
    expect(deriveDecision("CHANGES_REQUESTED", none, { partial: true })).toBe(
      "CHANGES_REQUESTED",
    );
    expect(deriveDecision("BLOCKED", none, { partial: true })).toBe("BLOCKED");
  });
  it("still blocks on criticals regardless of partial", () => {
    expect(
      deriveDecision("APPROVED", { ...none, critical: 1 }, { partial: true }),
    ).toBe("BLOCKED");
  });
  it("approves cleanly when complete", () => {
    expect(deriveDecision("APPROVED", none, { partial: false })).toBe(
      "APPROVED",
    );
  });
});

describe("ReviewResultParser completion metadata", () => {
  const makeParser = () => {
    const sessions = new SessionManager("test");
    const sessionId = sessions.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
      pullRequestId: 1,
    } as never);
    return { parser: new ReviewResultParser(sessions), sessionId };
  };

  const verdict = (extra: Record<string, unknown>) => ({
    structuredData: { decision: "APPROVED", summary: "ok", issues: [] },
    usage: { input: 1, output: 1, total: 2 },
    ...extra,
  });

  it("treats a missing stopReason as completed", () => {
    const { parser, sessionId } = makeParser();
    const result = parser.parseReviewResult(verdict({}), Date.now(), sessionId);
    expect(result.completion?.stopReason).toBe("completed");
    expect(result.completion?.partial).toBe(false);
    expect(result.decision).toBe("APPROVED");
  });

  it("marks step-cap runs partial and refuses to approve", () => {
    const { parser, sessionId } = makeParser();
    const result = parser.parseReviewResult(
      verdict({ stopReason: "step-cap", stepsUsed: 100 }),
      Date.now(),
      sessionId,
    );
    expect(result.completion?.partial).toBe(true);
    expect(result.completion?.stepsUsed).toBe(100);
    expect(result.decision).toBe("CHANGES_REQUESTED");
  });

  it("marks truncated JSON partial even when stopReason is completed", () => {
    const { parser, sessionId } = makeParser();
    const result = parser.parseReviewResult(
      verdict({ stopReason: "completed", jsonTruncated: true }),
      Date.now(),
      sessionId,
    );
    expect(result.completion?.partial).toBe(true);
    expect(result.decision).toBe("CHANGES_REQUESTED");
  });

  it("maps unknown stop reasons conservatively to partial", () => {
    const { parser, sessionId } = makeParser();
    const result = parser.parseReviewResult(
      verdict({ stopReason: "mystery-new-reason" }),
      Date.now(),
      sessionId,
    );
    expect(result.completion?.stopReason).toBe("unknown");
    expect(result.completion?.partial).toBe(true);
  });
});
