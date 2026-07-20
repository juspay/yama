/**
 * Phase 4: structured team rules — loading, prompt compilation, and
 * deterministic compliance/blocking.
 */
import { describe, it, expect } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RuleLoader,
  compileRulesForPrompt,
  computeRuleCompliance,
  hasBlockingRuleViolation,
} from "../../../src/v2/rules/RuleLoader.js";
import { YamaRule } from "../../../src/v2/types/index.js";

const setupRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "yama-rules-"));
  mkdirSync(join(root, ".yama/rules/db"), { recursive: true });
  return root;
};

describe("RuleLoader", () => {
  it("loads rules from nested yaml/json, skipping malformed and duplicates", async () => {
    const root = setupRepo();
    writeFileSync(
      join(root, ".yama/rules/general.yaml"),
      [
        "rules:",
        "  - id: no-raw-sql",
        "    rule: Parameterize all SQL queries",
        "    severity: CRITICAL",
        "    blocking: true",
        '    scope: ["src/db/**"]',
        "  - id: no-raw-sql",
        "    rule: duplicate should be ignored",
        "  - rule: missing id should be skipped",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".yama/rules/db/naming.json"),
      JSON.stringify({ id: "table-naming", rule: "Tables are snake_case" }),
    );
    writeFileSync(join(root, ".yama/rules/broken.yaml"), "{{{not yaml");

    const rules = await new RuleLoader(root).load();
    expect(rules.map((rule) => rule.id).sort()).toEqual([
      "no-raw-sql",
      "table-naming",
    ]);
    const sql = rules.find((rule) => rule.id === "no-raw-sql")!;
    expect(sql.blocking).toBe(true);
    expect(sql.severity).toBe("CRITICAL");
    expect(sql.scope).toEqual(["src/db/**"]);
  });

  it("returns empty for repos without a rules dir", async () => {
    expect(
      await new RuleLoader(mkdtempSync(join(tmpdir(), "r-"))).load(),
    ).toEqual([]);
  });
});

describe("compileRulesForPrompt", () => {
  const rules: YamaRule[] = [
    {
      id: "no-raw-sql",
      rule: "Parameterize <all> queries",
      blocking: true,
      badExample: "db.query(`${id}`)",
      goodExample: "db.query(sql, [id])",
    },
    { id: "naming", rule: "snake_case tables" },
  ];

  it("separates blocking from advisory and escapes content", () => {
    const block = compileRulesForPrompt(rules);
    expect(block).toContain('authority="blocking"');
    expect(block).toContain('authority="advisory"');
    expect(block).toContain("Parameterize &lt;all&gt; queries");
    expect(block).toContain('id="no-raw-sql"');
    expect(block).toContain("<bad>");
  });

  it("is empty with no rules", () => {
    expect(compileRulesForPrompt([])).toBe("");
  });

  it("escapes quotes so rule values cannot break out of XML attributes", () => {
    const block = compileRulesForPrompt([
      {
        id: 'x" injected="1',
        rule: `Don't use "raw" HTML`,
        scope: ['src/"quoted"/**'],
        blocking: true,
      },
    ]);
    expect(block).not.toContain('injected="1"');
    expect(block).toContain('id="x&quot; injected=&quot;1"');
    expect(block).toContain('scope="src/&quot;quoted&quot;/**"');
    expect(block).toContain("Don&#39;t use &quot;raw&quot; HTML");
  });
});

describe("rule compliance", () => {
  const rules: YamaRule[] = [
    { id: "no-raw-sql", rule: "x", blocking: true },
    { id: "naming", rule: "y" },
  ];

  it("marks cited rules violated and enforces blocking", () => {
    const compliance = computeRuleCompliance(rules, [
      { id: "f1", rule: "no-raw-sql" },
      { id: "f2", rule: undefined },
    ]);
    expect(compliance.find((c) => c.ruleId === "no-raw-sql")?.status).toBe(
      "violated",
    );
    expect(
      compliance.find((c) => c.ruleId === "no-raw-sql")?.findingIds,
    ).toEqual(["f1"]);
    expect(compliance.find((c) => c.ruleId === "naming")?.status).toBe(
      "no-violation-reported",
    );
    expect(hasBlockingRuleViolation(compliance)).toBe(true);
  });

  it("does not block on advisory violations", () => {
    const compliance = computeRuleCompliance(rules, [
      { id: "f1", rule: "naming" },
    ]);
    expect(hasBlockingRuleViolation(compliance)).toBe(false);
  });
});
