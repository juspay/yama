import {
  CheckSecurityError,
  assertCheckConfigUntampered,
  buildCacheKey,
  capFindings,
  checkOutcomes,
  executeCheck,
  failedBlockingChecks,
  flaggedLocations,
  prepareChecks,
  scopeFindings,
  shouldRunCheck,
  toFindings,
} from "../../../src/v4/checks/Runner.js";
import {
  parseEslint,
  parseJunit,
  parseRegex,
  parseSarif,
  parseTsc,
  getParser,
} from "../../../src/v4/checks/parsers/index.js";
import {
  buildChangeSet,
  lineWasChanged,
} from "../../../src/v4/changes/ChangeSet.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  CheckConfig,
  CheckRunResult,
  CommandRunner,
  ResolvedConfig,
} from "../../../src/v4/types/index.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,2 +10,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
diff --git a/docs/readme.md b/docs/readme.md
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,1 +1,2 @@
 title
+text
`;

const changeSet = buildChangeSet({
  diff: DIFF,
  excludePatterns: [],
  maxFiles: 100,
});

const isChangedLine = (path: string, line: number): boolean =>
  lineWasChanged(changeSet, path, line);

const emptyOutput = { stdout: "", stderr: "", exitCode: 0 };

function configWith(checks: CheckConfig[]): ResolvedConfig {
  return {
    version: 4,
    ai: { provider: "vertex" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...optionalDefaults(),
    checks: { enabled: true, allowForks: false, checks },
  } as ResolvedConfig;
}

describe("SARIF parser — the language-agnostic path", () => {
  const sarif = JSON.stringify({
    runs: [
      {
        results: [
          {
            ruleId: "S1234",
            level: "error",
            message: { text: "Unsafe call" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "src/app.ts" },
                  region: { startLine: 11 },
                },
              },
            ],
          },
          {
            ruleId: "S5678",
            message: { text: "No level given" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "file://src/other.ts" },
                  region: { startLine: 3 },
                },
              },
            ],
          },
        ],
      },
    ],
  });

  it("extracts path, line, rule and message", () => {
    const [first] = parseSarif(
      { ...emptyOutput, stdout: sarif },
      { checkId: "c" },
    );
    expect(first).toEqual({
      filePath: "src/app.ts",
      line: 11,
      level: "error",
      severity: "MAJOR",
      ruleId: "S1234",
      message: "Unsafe call",
    });
  });

  it("defaults a missing level to warning, per the SARIF spec", () => {
    const [, second] = parseSarif(
      { ...emptyOutput, stdout: sarif },
      { checkId: "c" },
    );
    expect(second.severity).toBe("MINOR");
  });

  it("strips a file:// prefix", () => {
    const [, second] = parseSarif(
      { ...emptyOutput, stdout: sarif },
      { checkId: "c" },
    );
    expect(second.filePath).toBe("src/other.ts");
  });

  it("honours a configured severity map", () => {
    const [first] = parseSarif(
      { ...emptyOutput, stdout: sarif },
      { checkId: "c", severityMap: { error: "CRITICAL" } },
    );
    expect(first.severity).toBe("CRITICAL");
  });

  it("returns nothing rather than throwing on garbage", () => {
    expect(
      parseSarif({ ...emptyOutput, stdout: "not json" }, { checkId: "c" }),
    ).toEqual([]);
    expect(
      parseSarif({ ...emptyOutput, stdout: "{}" }, { checkId: "c" }),
    ).toEqual([]);
  });
});

describe("other parsers", () => {
  it("parses ESLint json, mapping numeric severity", () => {
    const findings = parseEslint(
      {
        ...emptyOutput,
        stdout: JSON.stringify([
          {
            filePath: "src/app.ts",
            messages: [
              {
                severity: 2,
                line: 11,
                ruleId: "no-eval",
                message: "eval is evil",
              },
              {
                severity: 1,
                line: 12,
                ruleId: "quotes",
                message: "use single quotes",
              },
            ],
          },
        ]),
      },
      { checkId: "lint" },
    );
    expect(findings[0].severity).toBe("MAJOR");
    expect(findings[1].severity).toBe("MINOR");
  });

  it("parses tsc diagnostics from stdout or stderr", () => {
    const findings = parseTsc(
      {
        ...emptyOutput,
        stdout:
          "src/app.ts(11,5): error TS2345: Argument of type 'x' is not assignable.",
      },
      { checkId: "tsc" },
    );
    expect(findings[0]).toMatchObject({
      filePath: "src/app.ts",
      line: 11,
      ruleId: "TS2345",
      severity: "MAJOR",
    });
  });

  it("parses JUnit failures and ignores passing cases", () => {
    const findings = parseJunit(
      {
        ...emptyOutput,
        stdout:
          `<testsuite>` +
          `<testcase classname="Gate" name="rejects duplicates"/>` +
          `<testcase classname="Gate" name="blocks criticals"><failure message="expected BLOCKED"/></testcase>` +
          `</testsuite>`,
      },
      { checkId: "test" },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(
      /Gate › blocks criticals: expected BLOCKED/,
    );
  });

  it("parses generic file:line: message output", () => {
    const findings = parseRegex(
      { ...emptyOutput, stdout: "src/app.ts:11:2: error: something broke" },
      { checkId: "custom" },
    );
    expect(findings[0]).toMatchObject({ filePath: "src/app.ts", line: 11 });
  });

  it("does not turn ordinary prose into findings", () => {
    const findings = parseRegex(
      { ...emptyOutput, stdout: "Running checks...\nAll good!\nDone in 3s" },
      { checkId: "custom" },
    );
    expect(findings).toEqual([]);
  });

  it("agent parser yields nothing — extraction needs a model", () => {
    expect(
      getParser("agent")(
        { ...emptyOutput, stdout: "anything" },
        { checkId: "c" },
      ),
    ).toEqual([]);
  });

  it("defaults to the regex parser when none is configured", () => {
    expect(getParser(undefined)).toBe(parseRegex);
  });
});

describe("security — the trust boundary", () => {
  const checks: CheckConfig[] = [
    { id: "lint", run: "pnpm lint" },
    { id: "custom", run: "./scripts/check-migrations.sh --strict" },
  ];

  it("refuses when the pull request edits checks.yaml", () => {
    expect(() =>
      assertCheckConfigUntampered(checks, [".yama/checks.yaml"]),
    ).toThrow(CheckSecurityError);
  });

  it("refuses when the pull request edits a script a check executes", () => {
    expect(() =>
      assertCheckConfigUntampered(checks, ["scripts/check-migrations.sh"]),
    ).toThrow(/executes/);
  });

  it("allows an unrelated change", () => {
    expect(() =>
      assertCheckConfigUntampered(checks, ["src/app.ts"]),
    ).not.toThrow();
  });

  it("ignores built-in checks, which execute nothing", () => {
    expect(() =>
      assertCheckConfigUntampered(
        [{ id: "owners", type: "builtin.owners" }],
        [".yama/policy/ownership.yaml"],
      ),
    ).not.toThrow();
  });
});

describe("check selection", () => {
  it("runs a check with no path condition", () => {
    expect(shouldRunCheck({ id: "lint", run: "x" }, changeSet).run).toBe(true);
  });

  it("skips a disabled check", () => {
    const decision = shouldRunCheck(
      { id: "lint", run: "x", enabled: false },
      changeSet,
    );
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/disabled/);
  });

  it("runs only when a changed file matches when.paths", () => {
    expect(
      shouldRunCheck(
        { id: "lint", run: "x", when: { paths: ["**/*.ts"] } },
        changeSet,
      ).run,
    ).toBe(true);
    expect(
      shouldRunCheck(
        { id: "lint", run: "x", when: { paths: ["**/*.py"] } },
        changeSet,
      ).run,
    ).toBe(false);
  });

  it("reports skipped checks rather than dropping them", () => {
    const { prepared, skipped } = prepareChecks(
      configWith([
        { id: "ts", run: "x", when: { paths: ["**/*.ts"] } },
        { id: "py", run: "x", when: { paths: ["**/*.py"] } },
      ]),
      changeSet,
    );
    expect(prepared.map((entry) => entry.config.id)).toEqual(["ts"]);
    expect(skipped[0]).toMatchObject({ checkId: "py", status: "skipped" });
  });
});

describe("content-addressed caching", () => {
  it("is stable for the same content and changes when content changes", () => {
    const check: CheckConfig = { id: "lint", run: "pnpm lint" };
    const a = buildCacheKey(check, new Map([["src/app.ts", "h1"]]), [
      "src/app.ts",
    ]);
    const b = buildCacheKey(check, new Map([["src/app.ts", "h1"]]), [
      "src/app.ts",
    ]);
    const c = buildCacheKey(check, new Map([["src/app.ts", "h2"]]), [
      "src/app.ts",
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("is insensitive to path ordering", () => {
    const check: CheckConfig = { id: "lint", run: "x" };
    const hashes = new Map([
      ["a.ts", "1"],
      ["b.ts", "2"],
    ]);
    expect(buildCacheKey(check, hashes, ["a.ts", "b.ts"])).toBe(
      buildCacheKey(check, hashes, ["b.ts", "a.ts"]),
    );
  });

  it("changes when the command changes", () => {
    const hashes = new Map([["a.ts", "1"]]);
    expect(buildCacheKey({ id: "l", run: "x" }, hashes, ["a.ts"])).not.toBe(
      buildCacheKey({ id: "l", run: "y" }, hashes, ["a.ts"]),
    );
  });
});

describe("executeCheck", () => {
  const prepared = {
    config: { id: "lint", run: "pnpm lint" },
    paths: [],
    cacheKey: "k",
  };

  const runnerFor =
    (
      output: Partial<{
        stdout: string;
        stderr: string;
        exitCode: number;
        timedOut: boolean;
      }>,
    ): CommandRunner =>
    async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...output,
    });

  it("passes on exit code 0", async () => {
    const result = await executeCheck({
      check: prepared,
      runner: runnerFor({}),
      cwd: "/repo",
    });
    expect(result.status).toBe("passed");
  });

  it("fails on a non-zero exit even with no parseable findings", async () => {
    const result = await executeCheck({
      check: prepared,
      runner: runnerFor({ exitCode: 1, stderr: "command not found" }),
      cwd: "/repo",
    });
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
  });

  it("reports a timeout distinctly from a failure", async () => {
    const result = await executeCheck({
      check: prepared,
      runner: runnerFor({ timedOut: true }),
      cwd: "/repo",
    });
    expect(result.status).toBe("timeout");
    expect(result.reason).toMatch(/exceeded/);
  });

  it("turns a runner exception into an error result, never a thrown review", async () => {
    const result = await executeCheck({
      check: prepared,
      runner: async () => {
        throw new Error("spawn ENOENT");
      },
      cwd: "/repo",
    });
    expect(result.status).toBe("error");
    expect(result.reason).toBe("spawn ENOENT");
  });

  it("serves and marks a cached result", async () => {
    const cache = new Map<string, CheckRunResult>();
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    };

    await executeCheck({ check: prepared, runner, cwd: "/repo", cache });
    const second = await executeCheck({
      check: prepared,
      runner,
      cwd: "/repo",
      cache,
    });

    expect(calls).toBe(1);
    expect(second.cached).toBe(true);
  });

  it("does not execute a built-in check", async () => {
    const result = await executeCheck({
      check: {
        config: { id: "owners", type: "builtin.owners" },
        paths: [],
        cacheKey: "k",
      },
      runner: async () => {
        throw new Error("should not run");
      },
      cwd: "/repo",
    });
    expect(result.status).toBe("skipped");
  });

  it("truncates very large output", async () => {
    const result = await executeCheck({
      check: prepared,
      runner: runnerFor({ stdout: "x".repeat(50_000) }),
      cwd: "/repo",
    });
    expect(result.output?.length).toBeLessThan(21_000);
    expect(result.output).toMatch(/more characters/);
  });
});

describe("scoping findings to the change", () => {
  const findings = [
    {
      filePath: "src/app.ts",
      line: 11,
      severity: "MAJOR" as const,
      message: "on a changed line",
    },
    {
      filePath: "src/app.ts",
      line: 10,
      severity: "MAJOR" as const,
      message: "on an old line",
    },
    {
      filePath: "src/untouched.ts",
      line: 1,
      severity: "MAJOR" as const,
      message: "elsewhere",
    },
    { severity: "MAJOR" as const, message: "repository-level" },
  ];

  it("changed-lines keeps only findings on lines this PR changed", () => {
    const scoped = scopeFindings(
      findings,
      { id: "c", run: "x" },
      changeSet,
      isChangedLine,
    );
    expect(scoped.map((finding) => finding.message)).toEqual([
      "on a changed line",
      "repository-level",
    ]);
  });

  it("changed-files keeps anything in a touched file", () => {
    const scoped = scopeFindings(
      findings,
      { id: "c", run: "x", scope: "changed-files" },
      changeSet,
      isChangedLine,
    );
    expect(scoped.map((finding) => finding.message)).toContain(
      "on an old line",
    );
    expect(scoped.map((finding) => finding.message)).not.toContain("elsewhere");
  });

  it("repo keeps everything", () => {
    expect(
      scopeFindings(
        findings,
        { id: "c", run: "x", scope: "repo" },
        changeSet,
        isChangedLine,
      ),
    ).toHaveLength(4);
  });
});

describe("capFindings", () => {
  const result: CheckRunResult = {
    checkId: "lint",
    status: "failed",
    durationMs: 1,
    droppedFindings: 0,
    findings: [
      { severity: "MINOR", message: "m1" },
      { severity: "CRITICAL", message: "c1" },
      { severity: "SUGGESTION", message: "s1" },
      { severity: "MAJOR", message: "j1" },
    ],
  };

  it("keeps the most severe and reports the rest as dropped, never silently", () => {
    const capped = capFindings(result, 2);
    expect(capped.findings.map((finding) => finding.message)).toEqual([
      "c1",
      "j1",
    ]);
    expect(capped.droppedFindings).toBe(2);
  });

  it("leaves a small result untouched", () => {
    expect(capFindings(result, 10).droppedFindings).toBe(0);
  });
});

describe("aggregation", () => {
  const results: CheckRunResult[] = [
    {
      checkId: "lint",
      status: "failed",
      durationMs: 1,
      droppedFindings: 0,
      findings: [
        {
          filePath: "src/app.ts",
          line: 11,
          severity: "MAJOR",
          message: "eval",
          ruleId: "no-eval",
        },
      ],
    },
    {
      checkId: "tsc",
      status: "passed",
      durationMs: 1,
      droppedFindings: 0,
      findings: [],
    },
    {
      checkId: "flaky",
      status: "skipped",
      durationMs: 0,
      droppedFindings: 0,
      findings: [],
    },
  ];

  it("converts check findings into gate-ready findings carrying their source", () => {
    const [finding] = toFindings(results[0]);
    expect(finding.source).toBe("check");
    expect(finding.checkId).toBe("lint");
    expect(finding.title).toBe("no-eval: eval");
    expect(finding.suggestion).toBeTruthy();
    expect(finding.id).toBeTruthy();
  });

  it("reports flagged locations so the agent does not duplicate a linter", () => {
    expect([...flaggedLocations(results)]).toEqual(["src/app.ts:11"]);
  });

  it("maps outcomes, leaving a skipped check absent rather than passing", () => {
    const outcomes = checkOutcomes(results);
    expect(outcomes.get("lint")).toBe(false);
    expect(outcomes.get("tsc")).toBe(true);
    expect(outcomes.has("flaky")).toBe(false);
  });

  it("identifies blocking checks that did not pass", () => {
    expect(
      failedBlockingChecks(results, [
        { id: "lint", run: "x", blocking: true },
        { id: "tsc", run: "x", blocking: true },
      ]),
    ).toEqual(["lint"]);
  });

  it("ignores non-blocking failures for the verdict", () => {
    expect(failedBlockingChecks(results, [{ id: "lint", run: "x" }])).toEqual(
      [],
    );
  });
});
