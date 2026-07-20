/**
 * Loads structured review rules from `.yama/rules/**` (YAML or JSON; a file
 * holds one rule object or a `rules:` array), compiles them for prompt
 * injection, and computes deterministic compliance from reported findings.
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import { parse as parseYAML } from "yaml";
import {
  LocalReviewFinding,
  RuleComplianceEntry,
  YamaRule,
} from "../types/index.js";

const RULES_DIR = ".yama/rules";
const RULE_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

export class RuleLoader {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  /** Recursively load all rule files. Malformed files are skipped loudly. */
  async load(): Promise<YamaRule[]> {
    const dir = join(this.projectRoot, RULES_DIR);
    if (!existsSync(dir)) {
      return [];
    }
    const rules: YamaRule[] = [];
    const seen = new Set<string>();
    await this.walk(dir, rules, seen);
    return rules;
  }

  private async walk(
    dir: string,
    out: YamaRule[],
    seen: Set<string>,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(path, out, seen);
        continue;
      }
      if (!RULE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        const raw = await readFile(path, "utf-8");
        const parsed =
          extname(entry.name).toLowerCase() === ".json"
            ? JSON.parse(raw)
            : parseYAML(raw);
        for (const candidate of Array.isArray(parsed?.rules)
          ? parsed.rules
          : Array.isArray(parsed)
            ? parsed
            : [parsed]) {
          const rule = this.normalize(candidate);
          if (!rule) {
            console.warn(`   ⚠️  Skipping malformed rule in ${path}`);
            continue;
          }
          if (seen.has(rule.id)) {
            console.warn(
              `   ⚠️  Duplicate rule id "${rule.id}" in ${path} — first definition wins.`,
            );
            continue;
          }
          seen.add(rule.id);
          out.push(rule);
        }
      } catch (error) {
        console.warn(
          `   ⚠️  Could not load rules from ${path}: ${(error as Error).message}`,
        );
      }
    }
  }

  private normalize(candidate: unknown): YamaRule | null {
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    const value = candidate as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const rule = typeof value.rule === "string" ? value.rule.trim() : "";
    if (!id || !rule) {
      return null;
    }
    const severity =
      typeof value.severity === "string" &&
      ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"].includes(
        value.severity.toUpperCase(),
      )
        ? (value.severity.toUpperCase() as YamaRule["severity"])
        : undefined;
    return {
      id,
      rule,
      scope: Array.isArray(value.scope)
        ? value.scope.filter((s): s is string => typeof s === "string")
        : undefined,
      severity,
      blocking: value.blocking === true,
      badExample:
        typeof value.badExample === "string" ? value.badExample : undefined,
      goodExample:
        typeof value.goodExample === "string" ? value.goodExample : undefined,
      rationale:
        typeof value.rationale === "string" ? value.rationale : undefined,
    };
  }
}

const escapeXML = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Compile rules into the prompt block the review agent receives. */
export function compileRulesForPrompt(rules: YamaRule[]): string {
  if (rules.length === 0) {
    return "";
  }
  const render = (rule: YamaRule): string => {
    const attrs = [
      `id="${escapeXML(rule.id)}"`,
      rule.severity ? `severity="${rule.severity}"` : "",
      rule.scope && rule.scope.length > 0
        ? `scope="${escapeXML(rule.scope.join(","))}"`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const parts = [escapeXML(rule.rule)];
    if (rule.badExample) {
      parts.push(`<bad>${escapeXML(rule.badExample)}</bad>`);
    }
    if (rule.goodExample) {
      parts.push(`<good>${escapeXML(rule.goodExample)}</good>`);
    }
    if (rule.rationale) {
      parts.push(`<why>${escapeXML(rule.rationale)}</why>`);
    }
    return `  <rule ${attrs}>${parts.join(" ")}</rule>`;
  };

  const blocking = rules.filter((rule) => rule.blocking);
  const advisory = rules.filter((rule) => !rule.blocking);
  const sections: string[] = [];
  if (blocking.length > 0) {
    sections.push(
      `<team-rules authority="blocking">\n<!-- Violating any of these BLOCKS the PR. Cite the rule id in your finding's "rule" field. -->\n${blocking.map(render).join("\n")}\n</team-rules>`,
    );
  }
  if (advisory.length > 0) {
    sections.push(
      `<team-rules authority="advisory">\n<!-- Conventions to enforce with proportionate severity. Cite the rule id in your finding's "rule" field. -->\n${advisory.map(render).join("\n")}\n</team-rules>`,
    );
  }
  return sections.join("\n\n");
}

/**
 * Deterministic compliance from reported findings: a rule is `violated` when
 * any finding cites it; otherwise honestly `no-violation-reported` (Yama does
 * not claim a verified pass it did not perform).
 */
export function computeRuleCompliance(
  rules: YamaRule[],
  findings: Pick<LocalReviewFinding, "id" | "rule">[] | undefined,
): RuleComplianceEntry[] {
  return rules.map((rule) => {
    const citing = (findings || []).filter(
      (finding) => finding.rule === rule.id,
    );
    return {
      ruleId: rule.id,
      blocking: rule.blocking === true,
      status: citing.length > 0 ? "violated" : "no-violation-reported",
      findingIds: citing.length > 0 ? citing.map((f) => f.id) : undefined,
    };
  });
}

/** Any violated blocking rule forces BLOCKED — deterministic, like criticals. */
export function hasBlockingRuleViolation(
  compliance: RuleComplianceEntry[],
): boolean {
  return compliance.some(
    (entry) => entry.blocking && entry.status === "violated",
  );
}
