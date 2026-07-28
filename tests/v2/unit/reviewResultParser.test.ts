/**
 * Characterization tests for ReviewResultParser — locks the behaviour that was
 * extracted out of YamaOrchestrator (PR verdict reconciliation + local JSON
 * parsing), including the code-derived approval override (security M2).
 */

import { describe, it, expect } from "@jest/globals";
import { ReviewResultParser } from "../../../src/v2/core/ReviewResultParser.js";
import { SessionManager } from "../../../src/v2/core/SessionManager.js";
import { LocalReviewRequest } from "../../../src/v2/types/index.js";
import { LocalDiffContext } from "../../../src/v2/types/index.js";

const diffContext = (
  over: Partial<LocalDiffContext> = {},
): LocalDiffContext => ({
  changedFiles: ["src/a.ts"],
  additions: 10,
  deletions: 2,
  repoPath: "/repo",
  diffSource: "uncommitted",
  baseRef: undefined,
  headRef: undefined,
  truncated: false,
  diff: "",
  ...over,
});

const localRequest = (): LocalReviewRequest => ({
  mode: "local",
  outputSchemaVersion: "1.0",
});

describe("ReviewResultParser.parseReviewResult (PR verdict)", () => {
  it("reconciles an AI APPROVED verdict to BLOCKED when a CRITICAL finding is reported (M2)", () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
      pullRequestId: 42,
    });

    // The verdict now derives from the STRUCTURED findings the agent returns,
    // not from scanning posted comments: the model self-reported APPROVED but
    // also listed a CRITICAL issue, so Yama must enforce BLOCKED.
    const result = parser.parseReviewResult(
      {
        structuredData: {
          decision: "APPROVED",
          summary: "looks fine",
          issues: [
            {
              severity: "critical",
              category: "security",
              title: "SQL injection",
              description: "user input concatenated into query",
              filePath: "src/a.ts",
              line: 10,
            },
          ],
        },
        usage: { input: 1, output: 2, total: 3 },
      },
      Date.now() - 1000,
      sessionId,
    );

    expect(result.decision).toBe("BLOCKED");
    expect(result.statistics.issuesFound.critical).toBe(1);
    expect(result.prId).toBe(42);
  });

  it("fails safe to CHANGES_REQUESTED when the verdict is not parseable (no APPROVED-by-default)", () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
      pullRequestId: 42,
    });

    // Prose instead of the structured JSON verdict — the model may still have
    // posted CRITICAL comments via tools, so this must never yield APPROVED.
    const result = parser.parseReviewResult(
      { content: "I reviewed the PR and left comments.", usage: {} },
      Date.now(),
      sessionId,
    );

    expect(result.decision).toBe("CHANGES_REQUESTED");
  });

  it("keeps a clean approval when there are no findings", () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
    });

    const result = parser.parseReviewResult(
      {
        structuredData: { decision: "APPROVED", summary: "clean", issues: [] },
        usage: {},
      },
      Date.now(),
      sessionId,
    );

    expect(result.decision).toBe("APPROVED");
    expect(result.statistics.issuesFound.critical).toBe(0);
  });
});

describe("ReviewResultParser.parseLocalReviewResult", () => {
  const parser = new ReviewResultParser(new SessionManager());

  it("parses structured JSON findings and derives a decision", () => {
    const ai = {
      structuredData: {
        decision: "BLOCKED",
        summary: "found issues",
        issues: [
          {
            id: "i1",
            severity: "critical",
            category: "security",
            title: "bad",
            description: "d",
          },
        ],
        enhancements: [],
      },
      usage: { input: 5, output: 5, total: 10 },
    };

    const result = parser.parseLocalReviewResult(
      ai,
      "sid",
      Date.now(),
      localRequest(),
      diffContext(),
    );

    expect(result.decision).toBe("BLOCKED");
    expect(result.issues).toHaveLength(1);
    expect(result.statistics.issuesBySeverity.critical).toBe(1);
  });

  it("emits an OUTPUT_TRUNCATED finding when the model was cut off", () => {
    const result = parser.parseLocalReviewResult(
      { content: "not json", jsonTruncated: true, usage: {} },
      "sid",
      Date.now(),
      localRequest(),
      diffContext(),
    );

    expect(result.issues[0].id).toBe("OUTPUT_TRUNCATED");
    expect(result.decision).toBe("CHANGES_REQUESTED");
  });

  it("applies severityOverrides by rule key", () => {
    const ai = {
      structuredData: {
        decision: "APPROVED",
        issues: [
          {
            id: "x",
            rule: "no-console",
            severity: "minor",
            title: "t",
            description: "d",
          },
        ],
      },
      usage: {},
    };

    const result = parser.parseLocalReviewResult(
      ai,
      "sid",
      Date.now(),
      localRequest(),
      diffContext(),
      { "no-console": "CRITICAL" },
    );

    expect(result.issues[0].severity).toBe("CRITICAL");
    expect(result.statistics.issuesBySeverity.critical).toBe(1);
  });

  it("reconciles a local APPROVED verdict to BLOCKED when findings are CRITICAL (F18)", () => {
    const ai = {
      structuredData: {
        decision: "APPROVED",
        issues: [
          {
            id: "i1",
            severity: "critical",
            category: "security",
            title: "bad",
            description: "d",
          },
        ],
      },
      usage: {},
    };
    const result = parser.parseLocalReviewResult(
      ai,
      "sid",
      Date.now(),
      localRequest(),
      diffContext(),
    );
    expect(result.decision).toBe("BLOCKED");
  });
});

describe("ReviewResultParser regression guards", () => {
  it("derives the verdict ONLY from structured findings, not from posted comments (F17)", () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
    });
    // Even a posted comment whose body starts with a CRITICAL marker must NOT
    // affect the verdict — only the structured `issues` array does. The agent
    // reported no structured issues, so the result is a clean approval.
    sm.recordToolCall(
      sessionId,
      "add_comment",
      { comment_text: "🔒 CRITICAL: this text is ignored by the parser" },
      null,
      0,
    );

    const result = parser.parseReviewResult(
      {
        structuredData: { decision: "APPROVED", summary: "clean", issues: [] },
        usage: {},
      },
      Date.now(),
      sessionId,
    );

    expect(result.statistics.issuesFound.critical).toBe(0);
    expect(result.decision).toBe("APPROVED");
  });

  it("correlates repeated same-name tool calls by id, not by name (F7)", () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
    });
    parser.recordToolCallsFromResponse(sessionId, {
      toolCalls: [
        { toolName: "add_comment", toolCallId: "c1" },
        { toolName: "add_comment", toolCallId: "c2" },
      ],
      toolResults: [
        { toolCallId: "c2", value: "second" },
        { toolCallId: "c1", value: "first" },
      ],
    });

    const calls = sm.getSession(sessionId).toolCalls;
    expect(calls[0].result?.value).toBe("first"); // c1 → first, not "second"
    expect(calls[1].result?.value).toBe("second");
  });
});

describe("ReviewResultParser.parseReviewResult (gate anchoring)", () => {
  const session = () => {
    const sm = new SessionManager();
    const parser = new ReviewResultParser(sm);
    const sessionId = sm.createSession({
      mode: "pr",
      workspace: "w",
      repository: "r",
      pullRequestId: 496,
    });
    return { parser, sessionId };
  };

  it("quarantines fabricated verdict issues on a partial run — they must not drive BLOCKED", () => {
    const { parser, sessionId } = session();

    // Reproduces the observed failure: the loop died on a limit, the verdict
    // recovery restated four project rules as MAJOR "findings" about files
    // that were never gated. Only ONE finding actually passed submit_review.
    const fabricated = (title: string) => ({
      severity: "MAJOR",
      category: "conventions",
      title,
      description: "restated project rule",
      filePath: "src/features/tara/tools/commands/index.ts",
    });
    const result = parser.parseReviewResult(
      {
        structuredData: {
          decision: "CHANGES_REQUESTED",
          summary: "This PR adds a new Slack slash command...",
          issues: [
            fabricated("interface keyword used instead of type"),
            fabricated("types outside src/types/"),
            fabricated("env var instead of feature flag"),
            fabricated("missing matching AI tool"),
          ],
        },
        stopReason: "step-cap",
        usage: {},
      },
      Date.now(),
      sessionId,
      undefined,
      {
        invoked: true,
        accepted: [
          {
            id: "gated-1",
            severity: "MAJOR",
            title: "Envelope may still exceed maxBytes",
            filePath: "src/features/tara/services/mcp.ts",
            line: 122,
          },
        ],
      },
    );

    // 1 verified MAJOR < threshold → not BLOCKED; the 4 fabrications are
    // quarantined, not counted, not persisted.
    expect(result.decision).toBe("CHANGES_REQUESTED");
    expect(result.statistics.issuesFound.major).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0].title).toBe("Envelope may still exceed maxBytes");
    expect(result.ungatedIssues).toHaveLength(4);
    expect(result.statistics.totalComments).toBe(1);
    // Partial-run summary is rebuilt from verified findings, not model prose.
    expect(result.summary).toContain("gate-verified");
    expect(result.summary).not.toContain("Slack slash command");
  });

  it("caps APPROVED at CHANGES_REQUESTED when unverified CRITICAL claims exist", () => {
    const { parser, sessionId } = session();
    const result = parser.parseReviewResult(
      {
        structuredData: {
          decision: "APPROVED",
          summary: "ok",
          issues: [
            {
              severity: "CRITICAL",
              category: "security",
              title: "Possible secret in config",
              description: "never gated",
              filePath: "src/x.ts",
            },
          ],
        },
        stopReason: "completed",
        usage: {},
      },
      Date.now(),
      sessionId,
      undefined,
      { invoked: true, accepted: [] },
    );

    expect(result.decision).toBe("CHANGES_REQUESTED");
    expect(result.statistics.issuesFound.critical).toBe(0);
    expect(result.ungatedIssues).toHaveLength(1);
  });

  it("still blocks on gate-accepted CRITICALs even if the verdict omits them", () => {
    const { parser, sessionId } = session();
    const result = parser.parseReviewResult(
      {
        structuredData: { decision: "APPROVED", summary: "ok", issues: [] },
        stopReason: "completed",
        usage: {},
      },
      Date.now(),
      sessionId,
      undefined,
      {
        invoked: true,
        accepted: [
          {
            id: "gated-crit",
            severity: "CRITICAL",
            title: "SQL injection",
            filePath: "src/db.ts",
            line: 10,
          },
        ],
      },
    );

    expect(result.decision).toBe("BLOCKED");
    expect(result.statistics.issuesFound.critical).toBe(1);
  });

  it("keeps legacy behaviour when the gate was never invoked", () => {
    const { parser, sessionId } = session();
    const result = parser.parseReviewResult(
      {
        structuredData: {
          decision: "APPROVED",
          summary: "ok",
          issues: [
            {
              severity: "CRITICAL",
              category: "security",
              title: "SQL injection",
              description: "d",
              filePath: "src/a.ts",
            },
          ],
        },
        usage: {},
      },
      Date.now(),
      sessionId,
      undefined,
      { invoked: false, accepted: [] },
    );

    expect(result.decision).toBe("BLOCKED");
    expect(result.statistics.issuesFound.critical).toBe(1);
    expect(result.ungatedIssues).toBeUndefined();
  });
});
