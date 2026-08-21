import {
  CONFIDENCE_RUBRIC,
  applyAgreementBonus,
  buildJudgePrompt,
  collectScores,
  confidenceSchema,
  countAgreement,
  mergeReports,
  needsJudgement,
} from "../../../src/v4/judge/inline.js";
import {
  DELEGATION_CAPS,
  SUB_AGENTS,
  findSubAgent,
  reportToCandidates,
  subAgentReportSchema,
} from "../../../src/v4/agents/subAgents.js";
import type { IdentifiedFinding } from "../../../src/v4/types/index.js";

const finding = (
  overrides: Partial<IdentifiedFinding> = {},
): IdentifiedFinding => ({
  id: "a",
  severity: "MAJOR",
  title: "Unsafe eval",
  source: "agent",
  ...overrides,
});

describe("what gets judged", () => {
  it("judges agent claims", () => {
    expect(needsJudgement(finding())).toBe(true);
  });

  it("NEVER judges a check finding — a compiler error is not probabilistic", () => {
    expect(needsJudgement(finding({ source: "check" }))).toBe(false);
  });

  it("never judges a policy finding — ownership is a fact, not an opinion", () => {
    expect(needsJudgement(finding({ source: "policy" }))).toBe(false);
  });
});

describe("rubric", () => {
  it("anchors on verifiability, not on how bad it sounds", () => {
    expect(CONFIDENCE_RUBRIC).toMatch(/does not establish it/);
    expect(CONFIDENCE_RUBRIC).toMatch(/evidence directly demonstrates/);
  });

  it("tells the judge to break ties downward", () => {
    expect(CONFIDENCE_RUBRIC).toMatch(/choose the lower one/);
  });

  it("names the false-positive classes explicitly", () => {
    expect(CONFIDENCE_RUBRIC).toMatch(/linter, type checker, or compiler/);
    expect(CONFIDENCE_RUBRIC).toMatch(/Pre-existing problems/);
  });

  it("includes every finding's evidence in the prompt", () => {
    const prompt = buildJudgePrompt([
      finding({ evidence: "src/app.ts:11 calls eval(req.body)" }),
    ]);
    expect(prompt).toMatch(/src\/app\.ts:11 calls eval/);
    expect(prompt).toMatch(/Score each finding/);
  });
});

describe("collectScores", () => {
  const findings = [finding({ id: "a" }), finding({ id: "b" })];

  it("collects scores for known findings", () => {
    const scores = collectScores(findings, {
      scores: [
        { id: "a", score: 90, reason: "verified" },
        { id: "b", score: 30, reason: "unsupported" },
      ],
    });
    expect(scores.get("a")).toBe(90);
    expect(scores.get("b")).toBe(30);
  });

  it("ignores scores for findings that were not submitted", () => {
    const scores = collectScores(findings, {
      scores: [{ id: "ghost", score: 100, reason: "" }],
    });
    expect(scores.size).toBe(0);
  });

  it("LEAVES AN UNSCORED FINDING ABSENT so the gate lets it through", () => {
    const scores = collectScores(findings, {
      scores: [{ id: "a", score: 90, reason: "" }],
    });
    expect(scores.has("b")).toBe(false);
  });

  it("returns nothing on a malformed judge response rather than dropping findings", () => {
    expect(collectScores(findings, { garbage: true }).size).toBe(0);
    expect(collectScores(findings, null).size).toBe(0);
    expect(
      collectScores(findings, { scores: [{ id: "a", score: 500 }] }).size,
    ).toBe(0);
  });

  it("validates the schema shape", () => {
    expect(confidenceSchema.safeParse({ scores: [] }).success).toBe(true);
    expect(
      confidenceSchema.safeParse({
        scores: [{ id: "a", score: -1, reason: "" }],
      }).success,
    ).toBe(false);
  });
});

describe("cross-agent agreement", () => {
  it("counts one vote per reporter, not per mention", () => {
    const counts = countAgreement([
      { findings: [finding({ id: "a" }), finding({ id: "a" })] },
      { findings: [finding({ id: "a" })] },
      { findings: [finding({ id: "b" })] },
    ]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
  });

  it("lifts a borderline finding when independent reviewers agree", () => {
    const adjusted = applyAgreementBonus(
      new Map([["a", 74]]),
      new Map([["a", 2]]),
    );
    expect(adjusted.get("a")).toBe(82);
  });

  it("does not change a finding only one agent raised", () => {
    expect(
      applyAgreementBonus(new Map([["a", 74]]), new Map([["a", 1]])).get("a"),
    ).toBe(74);
  });

  it("caps the bonus so agreement cannot rescue a near-zero score", () => {
    const adjusted = applyAgreementBonus(
      new Map([["a", 10]]),
      new Map([["a", 5]]),
    );
    expect(adjusted.get("a")).toBe(25);
  });

  it("never exceeds 100", () => {
    expect(
      applyAgreementBonus(new Map([["a", 98]]), new Map([["a", 3]])).get("a"),
    ).toBe(100);
  });
});

describe("mergeReports", () => {
  it("deduplicates by finding id", () => {
    const merged = mergeReports([
      { findings: [finding({ id: "a" })] },
      { findings: [finding({ id: "a" }), finding({ id: "b" })] },
    ]);
    expect(merged.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
  });

  it("keeps the version that actually explains itself", () => {
    const merged = mergeReports([
      { findings: [finding({ id: "a", suggestion: "fix it" })] },
      {
        findings: [
          finding({
            id: "a",
            suggestion: "const parsed = JSON.parse(input); validate(parsed);",
            impact: "Remote code execution from any request",
          }),
        ],
      },
    ]);
    expect(merged[0].suggestion).toMatch(/JSON\.parse/);
    expect(merged[0].impact).toMatch(/Remote code execution/);
  });

  it("does not lose a field one reporter supplied and the other omitted", () => {
    const merged = mergeReports([
      { findings: [finding({ id: "a", evidence: "line 11" })] },
      { findings: [finding({ id: "a", impact: "breaks checkout" })] },
    ]);
    expect(merged[0].evidence).toBe("line 11");
    expect(merged[0].impact).toBe("breaks checkout");
  });
});

describe("sub-agent definitions", () => {
  it("gives every specialist a description that tells the agent WHEN to delegate", () => {
    for (const agent of SUB_AGENTS) {
      expect(agent.description).toMatch(/Delegate when/);
    }
  });

  it("never gives a specialist a posting tool", () => {
    for (const agent of SUB_AGENTS) {
      expect(
        agent.tools.some((tool) => /post|comment|status/i.test(tool)),
      ).toBe(false);
    }
  });

  it("never gives a specialist the gate — the main agent decides", () => {
    for (const agent of SUB_AGENTS) {
      expect(agent.tools).not.toContain("submit_finding");
    }
  });

  it("includes the impact specialist, which is the differentiating one", () => {
    const impact = findSubAgent("investigate_impact");
    expect(impact?.tier).toBe("strong");
    expect(impact?.instructions).toMatch(/blast radius/);
  });

  it("asks the tests specialist for named cases, not 'more tests'", () => {
    expect(findSubAgent("investigate_tests")?.instructions).toMatch(
      /names and the condition each asserts/,
    );
  });

  it("forbids the conventions specialist from inventing rules", () => {
    expect(findSubAgent("investigate_conventions")?.instructions).toMatch(
      /an unwritten preference is not a convention/i,
    );
  });

  it("puts cheap work on the cheap tier", () => {
    expect(findSubAgent("investigate_history")?.tier).toBe("cheap");
    expect(findSubAgent("investigate_security")?.tier).toBe("strong");
  });

  it("returns undefined for an unknown specialist", () => {
    expect(findSubAgent("investigate_nothing")).toBeUndefined();
  });
});

describe("delegation caps", () => {
  it("scales with the concurrency tier", () => {
    expect(DELEGATION_CAPS.high.maxConcurrent).toBe(8);
    expect(DELEGATION_CAPS.medium.maxConcurrent).toBe(4);
    expect(DELEGATION_CAPS.low.maxConcurrent).toBe(1);
  });

  it("keeps low genuinely serial", () => {
    expect(DELEGATION_CAPS.low.maxPerTurn).toBe(1);
  });
});

describe("reportToCandidates", () => {
  it("validates a specialist report", () => {
    expect(
      subAgentReportSchema.safeParse({
        summary: "checked",
        findings: [{ severity: "MAJOR", title: "x" }],
      }).success,
    ).toBe(true);
    expect(
      subAgentReportSchema.safeParse({
        summary: "x",
        findings: [{ severity: "HUGE", title: "y" }],
      }).success,
    ).toBe(false);
  });

  it("preserves severity as reported — the gate and judge handle grading", () => {
    const [candidate] = reportToCandidates(
      { summary: "s", findings: [{ severity: "CRITICAL", title: "t" }] },
      "investigate_security",
    );
    expect(candidate.severity).toBe("CRITICAL");
    expect(candidate.source).toBe("agent");
    expect(candidate.category).toBe("investigate_security");
  });

  it("normalises a missing line to null rather than dropping the field", () => {
    const [candidate] = reportToCandidates(
      { summary: "s", findings: [{ severity: "MINOR", title: "t" }] },
      "x",
    );
    expect(candidate.line).toBeNull();
  });
});
