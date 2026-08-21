import {
  NOISY_RULE,
  checkHealth,
  computeQuality,
  computeRunMetrics,
  renderScorecard,
} from "../../../src/v4/judge/scorecard.js";
import {
  buildMigrationPlan,
  importCodeowners,
  renderMigrationPlan,
} from "../../../src/v4/config/migrate.js";
import { matchesPath } from "../../../src/v4/policy/paths.js";
import type {
  FindingLedgerSnapshot,
  PostedFinding,
  StageOutcome,
} from "../../../src/v4/types/index.js";

const posted = (id: string): PostedFinding => ({
  id,
  severity: "MAJOR",
  title: id,
  source: "agent",
  postedCommentId: `c-${id}`,
  postedAt: new Date(0).toISOString(),
});

const ledger = (
  overrides: Partial<FindingLedgerSnapshot> = {},
): FindingLedgerSnapshot => ({
  submitted: 10,
  accepted: [posted("a"), posted("b")],
  rejected: [],
  posted: [posted("a"), posted("b")],
  unposted: [],
  ...overrides,
});

const metricsInput = (overrides: Record<string, unknown> = {}) => ({
  ledger: ledger(),
  stages: [] as StageOutcome[],
  filesPlanned: 10,
  filesExamined: 10,
  changedLines: 200,
  durationMs: 60_000,
  turns: 4,
  delegations: 2,
  ...overrides,
});

describe("run metrics", () => {
  it("computes coverage, noise and gate accept rate", () => {
    const metrics = computeRunMetrics(metricsInput());
    expect(metrics.coverage).toBe(1);
    expect(metrics.noisePer100Lines).toBe(1);
    expect(metrics.gateAcceptRate).toBeCloseTo(0.2);
  });

  it("reports no coverage when a run planned nothing but had work to do", () => {
    // The run that reviewed least must not score best. A plan of zero over a
    // real diff means the review never started, and calling that 100% is the
    // false all-clear this whole design exists to remove.
    expect(
      computeRunMetrics({
        ...metricsInput(),
        filesPlanned: 0,
        changedLines: 200,
      }).coverage,
    ).toBe(0);
  });

  it("reports full coverage when there was genuinely nothing to review", () => {
    expect(
      computeRunMetrics({ ...metricsInput(), filesPlanned: 0, changedLines: 0 })
        .coverage,
    ).toBe(1);
  });

  it("reports zero noise on an empty diff rather than NaN", () => {
    expect(
      computeRunMetrics(metricsInput({ changedLines: 0 })).noisePer100Lines,
    ).toBe(0);
  });

  it("collects degraded stages", () => {
    const metrics = computeRunMetrics(
      metricsInput({
        stages: [
          { stage: "post", status: "degraded", attempts: 3, durationMs: 1 },
          { stage: "verdict", status: "passed", attempts: 1, durationMs: 1 },
        ] as StageOutcome[],
      }),
    );
    expect(metrics.degradedStages).toEqual(["post"]);
  });
});

describe("health alerts", () => {
  it("treats unposted findings as CRITICAL — a clean-looking broken review", () => {
    const alerts = checkHealth(
      computeRunMetrics(
        metricsInput({ ledger: ledger({ unposted: [posted("c")] }) }),
      ),
    );
    const unposted = alerts.find((alert) => alert.metric === "unposted");
    expect(unposted?.severity).toBe("critical");
    expect(unposted?.message).toMatch(
      /shows fewer problems than the review found/,
    );
  });

  it("warns on incomplete coverage", () => {
    const alerts = checkHealth(
      computeRunMetrics(metricsInput({ filesExamined: 5 })),
    );
    expect(alerts.some((alert) => alert.metric === "coverage")).toBe(true);
  });

  it("warns when a review is too dense to be read", () => {
    const alerts = checkHealth(
      computeRunMetrics(
        metricsInput({
          changedLines: 20,
          ledger: ledger({ posted: [posted("a"), posted("b"), posted("c")] }),
        }),
      ),
    );
    const noise = alerts.find((alert) => alert.metric === "noise");
    expect(noise?.message).toMatch(/get ignored/);
  });

  it("is silent on a healthy run", () => {
    expect(checkHealth(computeRunMetrics(metricsInput()))).toEqual([]);
  });
});

describe("ground-truth quality", () => {
  it("computes precision from what humans did, not from what Yama claimed", () => {
    const quality = computeQuality({
      postedFindings: 10,
      actedOn: 6,
      dismissed: 2,
      missedByYama: 0,
      byRule: [],
    });
    expect(quality.precision).toBe(0.75);
  });

  it("computes recall against what humans found that Yama missed", () => {
    const quality = computeQuality({
      postedFindings: 10,
      actedOn: 6,
      dismissed: 2,
      missedByYama: 2,
      byRule: [],
    });
    expect(quality.recall).toBe(0.75);
  });

  it("omits F1 when there is nothing to compute it from", () => {
    expect(
      computeQuality({
        postedFindings: 0,
        actedOn: 0,
        dismissed: 0,
        missedByYama: 0,
        byRule: [],
      }).f1,
    ).toBeUndefined();
  });

  it("identifies a noisy rule only with enough evidence", () => {
    const quality = computeQuality({
      postedFindings: 20,
      actedOn: 5,
      dismissed: 15,
      missedByYama: 0,
      byRule: [
        { ruleId: "noisy", posted: 12, actedOn: 2 },
        { ruleId: "rare-but-wrong", posted: 2, actedOn: 0 },
        { ruleId: "good", posted: 15, actedOn: 12 },
      ],
    });

    expect(quality.noisyRules.map((rule) => rule.ruleId)).toEqual(["noisy"]);
    expect(NOISY_RULE.minPosted).toBeGreaterThan(2);
  });
});

describe("renderScorecard", () => {
  it("separates this run's metrics from ground truth", () => {
    const body = renderScorecard(
      computeRunMetrics(metricsInput({ tokensUsed: 120_000 })),
      computeQuality({
        postedFindings: 10,
        actedOn: 6,
        dismissed: 2,
        missedByYama: 2,
        byRule: [{ ruleId: "noisy", posted: 12, actedOn: 2 }],
      }),
    );

    expect(body).toMatch(/### This run/);
    expect(body).toMatch(
      /### Measured against what humans did \(ground truth\)/,
    );
    expect(body).toMatch(/Precision: 75%/);
    expect(body).toMatch(/Rules worth retiring/);
    expect(body).toMatch(/Tokens: 120,000/);
  });

  it("renders without ground truth on a fresh run", () => {
    const body = renderScorecard(computeRunMetrics(metricsInput()));
    expect(body).toMatch(/### This run/);
    expect(body).not.toMatch(/ground truth/);
  });

  it("includes alerts when something is wrong", () => {
    const body = renderScorecard(
      computeRunMetrics(
        metricsInput({ ledger: ledger({ unposted: [posted("c")] }) }),
      ),
    );
    expect(body).toMatch(/### Alerts/);
    expect(body).toMatch(/\*\*critical\*\* unposted/);
  });
});

describe("migration plan", () => {
  const legacy = {
    version: 2,
    ai: { provider: "vertex", model: "big", explore: { model: "small" } },
    mcpServers: { servers: { github: { url: "u" } } },
    review: {
      excludePatterns: ["dist/**"],
      maxFilesPerReview: 50,
      workflowInstructions: "Always check the ledger first.",
      focusAreas: [{ name: "Security", description: "SQL injection" }],
      toolPreferences: { lazyLoading: true },
    },
    performance: {
      tokenBudget: { maxTokensPerReview: 1 },
      maxReviewDuration: "15m",
    },
  };

  it("writes the two required files plus review", () => {
    const plan = buildMigrationPlan(legacy);
    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain(".yama/yama.yaml");
    expect(paths).toContain(".yama/mcp.yaml");
    expect(paths).toContain(".yama/review.yaml");
  });

  it("moves v3 prompt text into knowledge files rather than dropping it", () => {
    const plan = buildMigrationPlan(legacy);
    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain(".yama/knowledge/workflow.md");
    expect(paths).toContain(".yama/knowledge/focus/security.md");
    expect(plan.orphans).toHaveLength(2);
  });

  it("reports dropped keys WITH the reason they no longer matter", () => {
    const plan = buildMigrationPlan(legacy);
    expect(plan.dropped.join("\n")).toMatch(/tokenBudget — never enforced/);
    expect(plan.dropped.join("\n")).toMatch(
      /maxReviewDuration — v4 bounds a review by work/,
    );
    expect(plan.dropped.join("\n")).toMatch(/toolPreferences/);
  });

  it("produces parseable YAML", () => {
    const plan = buildMigrationPlan(legacy);
    const yama = plan.files.find((file) => file.path === ".yama/yama.yaml");
    expect(yama?.content).toMatch(/version: 4/);
    expect(yama?.content).toMatch(/provider: vertex/);
  });

  it("renders a what-moved-where table and promises not to write", () => {
    const rendered = renderMigrationPlan(buildMigrationPlan(legacy));
    expect(rendered).toMatch(/\| New file \| From \|/);
    expect(rendered).toMatch(/Your existing config keeps working/);
    expect(rendered).toMatch(/--write/);
  });

  it("handles a minimal legacy config without inventing files", () => {
    const plan = buildMigrationPlan({
      ai: { provider: "v" },
      mcpServers: { servers: {} },
    });
    expect(plan.files.map((file) => file.path)).toEqual([
      ".yama/yama.yaml",
      ".yama/mcp.yaml",
    ]);
    expect(plan.dropped).toEqual([]);
  });
});

describe("CODEOWNERS import", () => {
  const CODEOWNERS = `
# Core team owns everything by default
*       @team/core

/src/payments/  @team/payments @alice
docs/           @team/docs
*.sql           @team/data
malformed-line-without-owner
`;

  it("imports every rule and skips malformed lines", () => {
    const result = importCodeowners(CODEOWNERS);
    expect(result.rules).toHaveLength(4);
    expect(result.skipped[0]).toMatch(/malformed-line-without-owner/);
  });

  it("preserves last-match-wins by marking every rule exclusive", () => {
    expect(
      importCodeowners(CODEOWNERS).rules.every((rule) => rule.exclusive),
    ).toBe(true);
  });

  it("imports as NON-blocking — importing must not change merge behaviour", () => {
    expect(
      importCodeowners(CODEOWNERS).rules.every((rule) => !rule.blocking),
    ).toBe(true);
  });

  it("captures multiple owners", () => {
    const payments = importCodeowners(CODEOWNERS).rules.find((rule) =>
      rule.paths[0].includes("payments"),
    );
    expect(payments?.owners).toEqual(["@team/payments", "@alice"]);
  });

  it("translates gitignore-flavoured patterns into working globs", () => {
    const rules = importCodeowners(CODEOWNERS).rules;

    const anchored = rules.find((rule) =>
      rule.paths[0].startsWith("src/payments"),
    );
    expect(
      matchesPath("src/payments/charge.ts", anchored?.paths[0] as string),
    ).toBe(true);

    const unanchored = rules.find((rule) => rule.paths[0].includes("docs"));
    expect(
      matchesPath("a/docs/readme.md", unanchored?.paths[0] as string),
    ).toBe(true);

    const sql = rules.find((rule) => rule.paths[0].endsWith("*.sql"));
    expect(matchesPath("db/schema.sql", sql?.paths[0] as string)).toBe(true);
  });

  it("ignores comments and blank lines", () => {
    expect(importCodeowners("# just a comment\n\n").rules).toEqual([]);
  });
});
