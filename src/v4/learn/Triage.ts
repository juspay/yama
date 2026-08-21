/**
 * Learning from a merged pull request.
 *
 * Two signals, both free at merge time:
 *
 *  - What HUMANS said. A comment that recurs across pull requests is an
 *    unwritten convention. The agent judges each one on first appearance —
 *    was it valid, and why did we miss it — and coding conventions promote at
 *    one or two occurrences regardless of author, because a convention two
 *    reviewers state independently is already a convention.
 *
 *  - What happened to YAMA's comments. Acted on is precision credit. Dismissed
 *    without a code change, repeatedly, is a suppression candidate.
 *
 * Occurrence count becomes a stored WEIGHT that ranks rules at recall time
 * rather than a threshold that gates them. Frequency should decide prominence,
 * not existence.
 */

import { z } from "zod";
import type {
  LearningUpdate,
  RuleEntry,
  RuleStatus,
  TriagedHumanComment,
  TriagedYamaComment,
} from "../types/index.js";

/**
 * Promotion thresholds.
 *
 * Conventions promote fast — two independent statements of the same rule is
 * enough, and the cost of a wrong one is a revert. Preferences need more,
 * because "I'd have done it differently" is not a rule. Suppression is
 * deliberately SLOWER than promotion: learning to stay quiet about a real
 * defect is a much more expensive mistake than being briefly too noisy.
 */
export const PROMOTION = {
  conventionOccurrences: 2,
  preferenceOccurrences: 4,
  suppressionOccurrences: 3,
  /** Merges without a sighting before an unused rule goes dormant. */
  dormantAfterMerges: 40,
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/**
 * Fold one merge's human comments into the rule set.
 *
 * Existing rules gain occurrences and evidence; new ones start as candidates.
 * A candidate becomes active once its threshold is met, which is the only
 * moment a rule starts being enforced.
 */
export function applyHumanComments(
  rules: RuleEntry[],
  comments: TriagedHumanComment[],
  pullRequestId: number,
): LearningUpdate {
  const byId = new Map(rules.map((rule) => [rule.id, { ...rule }]));
  const changes: string[] = [];

  for (const comment of comments) {
    if (comment.classification === "context-specific") {
      // A one-off about this change specifically. Recording it as a rule would
      // enforce a decision that was only ever about one pull request.
      continue;
    }

    const id = `conv.${slug(comment.conventionKey)}`;
    const existing = byId.get(id);
    const evidence = comment.evidence ?? `PR#${pullRequestId}`;

    if (existing) {
      const occurrences = (existing.occurrences ?? 1) + 1;
      const authors = countAuthors(existing, comment.author);
      const threshold =
        comment.classification === "preference"
          ? PROMOTION.preferenceOccurrences
          : PROMOTION.conventionOccurrences;

      const status: RuleStatus =
        existing.status === "candidate" && occurrences >= threshold
          ? "active"
          : (existing.status ?? "active");

      if (status !== existing.status) {
        changes.push(
          `Promoted "${existing.title}" to active (${occurrences} occurrences, ${authors} author(s)).`,
        );
      } else {
        changes.push(
          `Reinforced "${existing.title}" (${occurrences} occurrences).`,
        );
      }

      byId.set(id, {
        ...existing,
        occurrences,
        authors,
        weight: occurrences,
        status,
        evidence: [...new Set([...(existing.evidence ?? []), evidence])],
      });
      continue;
    }

    // First sighting. A convention stated once by a reviewer is worth recording
    // as a candidate — recall still returns it, it just does not yet carry the
    // weight of an established rule.
    const status: RuleStatus =
      comment.classification === "missed-convention" &&
      PROMOTION.conventionOccurrences <= 1
        ? "active"
        : "candidate";

    byId.set(id, {
      id,
      title: comment.title,
      summary: comment.summary,
      paths: comment.paths,
      severity: comment.severity,
      status,
      occurrences: 1,
      authors: comment.author ? 1 : 0,
      weight: 1,
      evidence: [evidence],
    });
    changes.push(`Recorded "${comment.title}" as a candidate convention.`);
  }

  return { rules: [...byId.values()], changes };
}

function countAuthors(rule: RuleEntry, author: string | undefined): number {
  // Author identities are not stored — only the count — so this is an
  // approximation that can overcount when the same person comments twice. That
  // is acceptable for a ranking signal and avoids keeping a list of who said
  // what, which is a different kind of record entirely.
  return author ? (rule.authors ?? 0) + 1 : (rule.authors ?? 0);
}

/**
 * Fold Yama's own comment outcomes into the suppression set.
 *
 * A finding dismissed without any code change is a candidate false positive. It
 * takes several such dismissals — more than a convention takes to promote — for
 * Yama to stop reporting the pattern.
 */
export function applyYamaOutcomes(
  rules: RuleEntry[],
  outcomes: TriagedYamaComment[],
  pullRequestId: number,
): LearningUpdate {
  const byId = new Map(rules.map((rule) => [rule.id, { ...rule }]));
  const changes: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.outcome !== "dismissed-no-change") {
      continue;
    }

    const id = `suppress.${outcome.findingId}`;
    const existing = byId.get(id);
    const occurrences = (existing?.occurrences ?? 0) + 1;
    const status: RuleStatus =
      occurrences >= PROMOTION.suppressionOccurrences
        ? "suppressed"
        : "candidate";

    if (existing?.status !== status && status === "suppressed") {
      changes.push(
        `Suppressing "${outcome.title}" after ${occurrences} dismissals without a code change.`,
      );
    }

    byId.set(id, {
      id,
      title: outcome.title,
      summary:
        outcome.reason ??
        "Dismissed by reviewers without a code change on more than one pull request.",
      status,
      occurrences,
      weight: occurrences,
      evidence: [
        ...new Set([...(existing?.evidence ?? []), `PR#${pullRequestId}`]),
      ],
    });
  }

  return { rules: [...byId.values()], changes };
}

/**
 * Retire rules nothing has referenced in a long time.
 *
 * A rulebook that only grows becomes a rulebook nobody trusts. Dormant rather
 * than deleted: the evidence trail survives, and a dormant rule can be revived
 * by a single new sighting.
 */
export function retireDormantRules(
  rules: RuleEntry[],
  mergesSinceLastSeen: ReadonlyMap<string, number>,
): LearningUpdate {
  const changes: string[] = [];
  const updated = rules.map((rule) => {
    const since = mergesSinceLastSeen.get(rule.id) ?? 0;
    if (
      rule.status === "candidate" &&
      since >= PROMOTION.dormantAfterMerges &&
      (rule.occurrences ?? 0) < PROMOTION.conventionOccurrences
    ) {
      changes.push(`Retired "${rule.title}" — unseen for ${since} merges.`);
      return { ...rule, status: "dormant" as RuleStatus };
    }
    return rule;
  });
  return { rules: updated, changes };
}

/** Precision over recent runs: of what Yama posted, how much was acted on. */
export function computePrecision(outcomes: TriagedYamaComment[]): {
  posted: number;
  actedOn: number;
  dismissed: number;
  precision: number;
} {
  const posted = outcomes.length;
  const actedOn = outcomes.filter(
    (entry) => entry.outcome === "acted-on",
  ).length;
  const dismissed = outcomes.filter(
    (entry) => entry.outcome === "dismissed-no-change",
  ).length;
  // Unresolved comments are excluded from the denominator rather than counted
  // as failures: a comment nobody has looked at yet is not a false positive.
  const judged = actedOn + dismissed;
  return {
    posted,
    actedOn,
    dismissed,
    precision: judged === 0 ? 0 : actedOn / judged,
  };
}

/** The commit body, so a human can read what changed and why. */
export function renderLearningSummary(
  pullRequestId: number,
  changes: string[],
  precision: ReturnType<typeof computePrecision>,
): string {
  const lines = [`Learned from pull request #${pullRequestId}.`, ""];
  if (changes.length === 0) {
    lines.push("No changes to the knowledge base.");
  } else {
    for (const change of changes) {
      lines.push(`- ${change}`);
    }
  }
  if (precision.posted > 0) {
    lines.push(
      "",
      `Of ${precision.posted} finding(s) posted, ${precision.actedOn} were acted on and ` +
        `${precision.dismissed} dismissed (precision ${(precision.precision * 100).toFixed(0)}%).`,
    );
  }
  return lines.join("\n");
}

/**
 * What the classifier returns.
 *
 * A schema rather than prose: this is the one place a model's output becomes
 * repository content, so it is validated before it can be written. An
 * unparseable response teaches nothing rather than teaching garbage.
 */
export const triageSchema = z.object({
  human: z
    .array(
      z.object({
        // These strings are the ones `Triage.ts` matches on, and the ones the
        // architecture names. They had drifted apart from it once — the schema
        // asked for "convention" while the code tested for "missed-convention"
        // — and a cast to the declared type hid the mismatch from the compiler,
        // so every human comment fell through to no-op and precision was
        // permanently zero. Keep these three lists in step: the schema, the
        // prompt in `prompts/local.ts`, and `types/triage.ts`.
        classification: z.enum([
          "missed-convention",
          "missed-bug",
          "preference",
          "context-specific",
        ]),
        conventionKey: z.string(),
        title: z.string(),
        summary: z.string(),
        paths: z.array(z.string()).optional(),
        severity: z
          .enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"])
          .optional(),
        author: z.string().optional(),
        evidence: z.string().optional(),
      }),
    )
    .default([]),
  yama: z
    .array(
      z.object({
        findingId: z.string(),
        outcome: z.enum([
          "acted-on",
          "dismissed-no-change",
          "argued-down",
          "unresolved",
        ]),
        title: z.string(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
});
