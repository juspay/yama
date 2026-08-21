/**
 * `recall` — the agent's single door to project context.
 *
 * There is no prompt assembly in Yama, so everything a reviewer needs to know
 * about this repository arrives through this tool. That makes two properties
 * matter more than raw retrieval quality:
 *
 *  1. **Every result is citable.** A finding that enforces a convention must be
 *     able to name it, so the author can read the rule rather than argue with a
 *     reviewer's taste.
 *  2. **Results are bounded.** An unbounded context tool recreates the giant
 *     prompt one tool call later.
 *
 * Ranking is lexical (BM25-flavoured) rather than embedding-based. Deterministic,
 * needs no embedding provider, and works the moment a repo is cloned — which is
 * what "plug into any project" requires.
 */

import { historicalRisk, historyFor } from "../product/Capabilities.js";
import type {
  ChangeSet,
  ImpactLogEntry,
  ProductCapability,
  RecallEntry,
  RecallQuery,
  RecallResult,
  RuleEntry,
} from "../types/index.js";
import { matchesAnyPath, normalizePath } from "../policy/paths.js";

const DEFAULT_LIMIT = 8;
/** Hard ceiling so a recall can never become the giant prompt again. */
const MAX_CHARS = 12_000;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "is",
  "it",
  "and",
  "or",
  "for",
  "on",
  "with",
  "this",
  "that",
  "be",
  "are",
  "as",
  "at",
  "by",
  "from",
  "we",
  "you",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Score one entry against a query.
 *
 * Field weighting reflects what actually discriminates: a title match is a
 * strong signal, an alias match is an author saying "this is also called that",
 * and a body match is weak because bodies are long and match everything.
 */
export function scoreEntry(entry: RecallEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) {
    return 0;
  }

  const fields: Array<{ text: string; weight: number }> = [
    { text: entry.title, weight: 6 },
    { text: entry.summary, weight: 3 },
    { text: (entry.aliases ?? []).join(" "), weight: 5 },
    { text: (entry.keywords ?? []).join(" "), weight: 2 },
    { text: entry.domain ?? "", weight: 2 },
    { text: entry.body ?? "", weight: 1 },
  ];

  let score = 0;
  for (const field of fields) {
    const tokens = new Set(tokenize(field.text));
    if (tokens.size === 0) {
      continue;
    }
    const hits = queryTokens.filter((token) => tokens.has(token)).length;
    if (hits > 0) {
      // Saturating rather than linear: matching a token twice in a title is not
      // twice as relevant, and linear growth lets one verbose field dominate.
      score += field.weight * (1 + Math.log(hits));
    }
  }

  // An exact id match is what a citation lookup looks like — it should win.
  if (queryTokens.includes(entry.id.toLowerCase())) {
    score += 50;
  }

  // Nothing matched. Return zero rather than falling through to the weight
  // bonus below: a heavily-weighted convention that has nothing to do with the
  // query must not surface, or every recall returns the same popular entries
  // regardless of what was asked.
  if (score === 0) {
    return 0;
  }

  // Occurrence weight ranks among MATCHES; it never gates. A convention seen
  // nine times outranks one seen twice, but a rare rule is still retrievable.
  if (entry.weight && entry.weight > 0) {
    score += Math.min(6, Math.log2(entry.weight + 1) * 2);
  }

  return score;
}

/** Entries whose path scope covers any of the given paths. */
export function scopedToPaths(
  entries: RecallEntry[],
  paths: string[],
): RecallEntry[] {
  if (paths.length === 0) {
    return entries;
  }
  const normalized = paths.map(normalizePath);
  return entries.filter((entry) => {
    // An entry with no path scope is repo-wide and always applies.
    if (!entry.paths || entry.paths.length === 0) {
      return true;
    }
    return normalized.some((path) => matchesAnyPath(path, entry.paths));
  });
}

/**
 * Retrieve.
 *
 * With no query text, results are ordered by weight and blocking status — the
 * "what governs these files?" question, which is what an agent asks when it
 * opens a file it has not seen.
 */
export function recall(
  entries: RecallEntry[],
  query: RecallQuery,
): RecallResult {
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT);

  let pool = entries;
  if (query.scope && query.scope !== "all") {
    const kind = query.scope === "pr" ? "pr-context" : query.scope;
    pool = pool.filter((entry) => entry.kind === kind);
  }
  pool = scopedToPaths(pool, query.paths ?? []);

  const queryTokens = query.query ? tokenize(query.query) : [];

  const ranked =
    queryTokens.length === 0
      ? [...pool].sort(
          (a, b) =>
            Number(b.blocking ?? false) - Number(a.blocking ?? false) ||
            (b.weight ?? 0) - (a.weight ?? 0) ||
            a.id.localeCompare(b.id),
        )
      : pool
          .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
          .filter((scored) => scored.score > 0)
          .sort(
            (a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id),
          )
          .map((scored) => scored.entry);

  const selected = ranked.slice(0, limit);
  return {
    entries: selected,
    omitted: Math.max(0, ranked.length - selected.length),
    text: renderRecall(selected, Math.max(0, ranked.length - selected.length)),
  };
}

/** Render results for the agent, truncating at the character ceiling. */
export function renderRecall(entries: RecallEntry[], omitted: number): string {
  if (entries.length === 0) {
    return "Nothing recorded for that. Read the code and judge on its merits; do not invent a convention.";
  }

  const blocks: string[] = [];
  let used = 0;
  let rendered = 0;

  for (const entry of entries) {
    const parts = [`[${entry.id}] ${entry.title}`, entry.summary];
    if (entry.blocking) {
      parts.push("BLOCKING — a violation blocks the pull request.");
    }
    if (entry.severity) {
      parts.push(`Severity when violated: ${entry.severity}.`);
    }
    if (entry.paths && entry.paths.length > 0) {
      parts.push(`Applies to: ${entry.paths.join(", ")}`);
    }
    if (entry.body) {
      parts.push(entry.body.trim());
    }

    const block = parts.join("\n");
    if (used + block.length > MAX_CHARS && rendered > 0) {
      break;
    }
    blocks.push(block);
    used += block.length;
    rendered += 1;
  }

  const notRendered = omitted + (entries.length - rendered);
  const footer =
    notRendered > 0
      ? `\n\n(${notRendered} further entr${notRendered === 1 ? "y" : "ies"} matched. Narrow the query or pass paths to see them.)`
      : "";

  return `${blocks.join("\n\n---\n\n")}${footer}`;
}

/** Build recall entries from configured rules. */
export function entriesFromRules(rules: RuleEntry[]): RecallEntry[] {
  return (
    rules
      // Suppressed entries describe what NOT to report; they are retrievable only
      // under an explicit scope, never mixed into a general "what applies here".
      .filter((rule) => rule.status !== "dormant")
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        summary: rule.summary,
        body: rule.example ? `Example:\n${rule.example}` : undefined,
        kind: rule.status === "suppressed" ? "suppression" : "rule",
        paths: rule.paths,
        aliases: rule.aliases,
        keywords: rule.keywords,
        domain: rule.domain,
        severity: rule.severity,
        blocking: rule.blocking,
        weight: rule.weight ?? rule.occurrences,
      }))
  );
}

/** A recall entry carrying this pull request's accumulated notes. */
export function entryFromPrContext(
  pullRequestId: number,
  summary: string,
): RecallEntry | undefined {
  if (!summary.trim()) {
    return undefined;
  }
  return {
    id: `pr-${pullRequestId}`,
    title: `Earlier runs on pull request #${pullRequestId}`,
    summary:
      "What previous Yama runs on this pull request already established.",
    body: summary,
    kind: "pr-context",
  };
}

/** Paths touched by the change, for a default path scope. */
export function defaultPathScope(changeSet: ChangeSet): string[] {
  return changeSet.files.map((file) => file.path);
}

/**
 * Recall entries for the product capability map.
 *
 * This is the layer that makes Yama more than a diff reader: a capability entry
 * says what a region of code MEANS to a user, how it fails, and — through the
 * impact ledger — how often changes to it have needed correcting. None of that
 * is derivable from the change under review, which is exactly why it has to be
 * retrievable.
 *
 * The failure mode is carried in the summary rather than the body because it is
 * the field that changes how a reviewer reads a change: a capability that fails
 * SILENTLY deserves more scrutiny than one that throws, and the diff never says
 * which.
 */
export function entriesFromProduct(
  capabilities: ProductCapability[],
  log: ImpactLogEntry[] = [],
): RecallEntry[] {
  return capabilities.map((capability) => {
    const risk = historicalRisk(log, capability.id);
    const history = historyFor(log, capability.id);

    const summary = [
      capability.failureMode
        ? `Fails by: ${capability.failureMode}.`
        : undefined,
      capability.userVisible ? "User-visible." : undefined,
      capability.criticality
        ? `Criticality: ${capability.criticality}.`
        : undefined,
      risk && risk.corrected > 0
        ? `${risk.corrected} of the last ${risk.totalChanges} change(s) here needed a ` +
          `follow-up fix.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");

    const body = [
      capability.entrypoints && capability.entrypoints.length > 0
        ? `Entry points: ${capability.entrypoints.join(", ")}`
        : undefined,
      capability.dependsOn && capability.dependsOn.length > 0
        ? `Depends on: ${capability.dependsOn.join(", ")}`
        : undefined,
      history.length > 0
        ? `Recent changes:\n${history
            .slice(0, 5)
            .map((entry) => `- #${entry.pullRequestId}: ${entry.summary}`)
            .join("\n")}`
        : undefined,
      capability.notes,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      id: `product.${capability.id}`,
      title: capability.name,
      summary: summary || `Implemented by ${capability.paths.join(", ")}.`,
      ...(body ? { body } : {}),
      kind: "product" as const,
      paths: capability.paths,
      ...(capability.criticality === "high" ? { weight: 3 } : {}),
    };
  });
}
