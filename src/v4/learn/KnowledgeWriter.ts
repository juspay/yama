/**
 * Writing what a merge taught back into the repository.
 *
 * Learned rules go to `.yama/rules/learned.yaml` — a separate file from the ones
 * a human wrote, so `git diff` on a learn commit shows only what Yama concluded
 * and a reviewer can revert it without touching hand-authored policy.
 *
 * Everything written here is reviewable text. There is no opaque store, no
 * embedding index, nothing that has to be rebuilt: the knowledge base is files
 * in the repository, which is what makes a wrong lesson a one-line pull request
 * to fix rather than a support ticket.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import type { KnowledgeWriteResult, RuleEntry } from "../types/index.js";

/** Rules Yama learned live here; hand-written rules are never rewritten. */
export const LEARNED_RULES_PATH = ".yama/rules/learned.yaml";

/** Which rules came from learning rather than from a human. */
export function partitionLearned(
  all: RuleEntry[],
  authored: ReadonlySet<string>,
): { learned: RuleEntry[]; authored: RuleEntry[] } {
  const learned: RuleEntry[] = [];
  const human: RuleEntry[] = [];
  for (const rule of all) {
    (authored.has(rule.id) ? human : learned).push(rule);
  }
  return { learned, authored: human };
}

/** Ids currently defined in files other than the learned one. */
export async function authoredRuleIds(
  projectRoot: string,
  rules: RuleEntry[],
): Promise<Set<string>> {
  const path = join(projectRoot, LEARNED_RULES_PATH);
  if (!existsSync(path)) {
    return new Set(rules.map((rule) => rule.id));
  }
  try {
    const parsed = parseYAML(await readFile(path, "utf-8")) as
      | { rules?: RuleEntry[] }
      | undefined;
    const learned = new Set((parsed?.rules ?? []).map((rule) => rule.id));
    return new Set(
      rules.map((rule) => rule.id).filter((id) => !learned.has(id)),
    );
  } catch {
    // An unreadable learned file means we cannot tell learned from authored.
    // Treating everything as authored is the safe direction: it declines to
    // rewrite a human's rule rather than risking overwriting one.
    return new Set(rules.map((rule) => rule.id));
  }
}

/**
 * Write the learned rule set.
 *
 * Sorted by id so a diff between two learn commits shows what changed rather
 * than a reshuffle. Returns the paths written, which is what the git writer
 * scopes its `add` to.
 */
export async function writeLearnedRules(
  projectRoot: string,
  learned: RuleEntry[],
): Promise<KnowledgeWriteResult> {
  const path = join(projectRoot, LEARNED_RULES_PATH);
  await mkdir(dirname(path), { recursive: true });

  const sorted = [...learned].sort((a, b) => a.id.localeCompare(b.id));
  const body = [
    "# Rules Yama learned from merged pull requests.",
    "#",
    "# Written by `yama learn`. Safe to edit or delete: a rule you remove stops being",
    "# enforced, and a rule you correct stays corrected — learning only ever adds",
    "# occurrences to an existing id, it never rewrites your text.",
    "#",
    "# status: candidate = observed, not yet enforced. active = enforced.",
    "#         suppressed = Yama stopped reporting this. dormant = unused, retired.",
    "",
    stringifyYAML({ rules: sorted }, { lineWidth: 100 }),
  ].join("\n");

  await writeFile(path, body, "utf-8");
  return { paths: [LEARNED_RULES_PATH], ruleCount: sorted.length };
}

/**
 * Append a merge to the product impact log.
 *
 * One file per merge rather than one growing file: concurrent learn runs on
 * different merges would otherwise conflict on every line of a shared document,
 * and a rebase-retry push cannot resolve that.
 */
export async function appendImpactLog(
  projectRoot: string,
  pullRequestId: number,
  entry: {
    at: string;
    title?: string;
    capabilities: string[];
    paths: string[];
    summary: string;
  },
): Promise<string> {
  const relative = join(
    ".yama",
    "product",
    "impact-log",
    `pr-${pullRequestId}.yaml`,
  );
  const path = join(projectRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    stringifyYAML({ pullRequestId, ...entry }, { lineWidth: 100 }),
    "utf-8",
  );
  return relative;
}
