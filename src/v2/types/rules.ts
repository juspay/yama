/**
 * Structured, versioned review rules — `.yama/rules/**` — the enforcement
 * half of "rules and conventions". A rule is prompt guidance going in AND a
 * deterministic compliance row coming out.
 */

export type RuleSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";

export type YamaRule = {
  /** Stable id findings cite via their `rule` field (kebab-case). */
  id: string;
  /** The rule, stated imperatively and specifically. */
  rule: string;
  /** Glob scopes this rule applies to (repo-relative). Empty/absent = all files. */
  scope?: string[];
  severity?: RuleSeverity;
  /** Blocking rules force BLOCKED when violated, regardless of counts. */
  blocking?: boolean;
  badExample?: string;
  goodExample?: string;
  rationale?: string;
};

export type RuleComplianceStatus = "violated" | "no-violation-reported";

export type RuleComplianceEntry = {
  ruleId: string;
  blocking: boolean;
  status: RuleComplianceStatus;
  /** Finding ids citing this rule (when violated). */
  findingIds?: string[];
};
