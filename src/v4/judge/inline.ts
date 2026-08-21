/**
 * The inline judge — calibrated confidence, not a binary opinion.
 *
 * A tri-state critic ("confirmed / uncertain / refuted") gives the gate nothing
 * to act on: "uncertain" is not a decision. A 0–100 score against an explicit
 * rubric is, and it lets a project move its own bar without changing any code.
 *
 * Check findings never come here. A compiler error is not a probabilistic claim,
 * and asking a model to second-guess `tsc` produces exactly the wrong kind of
 * doubt.
 */

import { z } from "zod";
import type {
  IdentifiedFinding,
  InlineJudge,
  InlineJudgeOptions,
} from "../types/index.js";
import { generateStructured } from "../core/StructuredCall.js";

/**
 * The rubric, given to the judge verbatim.
 *
 * Anchored on verifiability rather than on how bad the problem sounds: the
 * question is "did the reviewer establish this", not "would this be serious if
 * true". Severity is already the gate's job.
 */
export const CONFIDENCE_RUBRIC = `Score each finding from 0 to 100 for how confident you are that it is a real, actionable problem in THIS change.

- 0   Not a real issue. It does not survive light scrutiny, or it describes code the pull request did not touch.
- 25  Might be real, but the evidence given does not establish it. A stylistic point no stated rule covers scores here.
- 50  Verified as real, but marginal — a nitpick, or something that rarely bites in practice.
- 75  Verified, and it will be hit in practice. The current code is insufficient.
- 100 Certain. The evidence directly demonstrates the defect.

Score down for:
- Anything a linter, type checker, or compiler already reports.
- Pre-existing problems on lines this change did not modify.
- Claims the cited evidence does not support.
- Severity inflated beyond the actual consequence.
- Changes that are obviously intentional and consistent with the rest of the change.

When you are torn between two scores, choose the lower one. A false positive costs the author more time than a missed nitpick costs the codebase.

Return only the JSON object.`;

/**
 * The judge's role, held apart from the rubric.
 *
 * The rubric is the part a team tunes; this sentence is the part that must not
 * drift, because a judge that starts reviewing the code itself stops being a
 * calibration pass and becomes a second opinion nobody asked for.
 */
export const JUDGE_ROLE =
  "You score findings another reviewer has already written. You do not review " +
  "the code yourself and you do not add findings of your own. Score every " +
  "finding you are given, by its id, and return only the structured result.";

export const confidenceSchema = z.object({
  scores: z.array(
    z.object({
      id: z.string(),
      score: z.number().min(0).max(100),
      reason: z.string(),
    }),
  ),
});

/** Only agent claims are judged. */
export function needsJudgement(finding: IdentifiedFinding): boolean {
  return finding.source === "agent";
}

/**
 * Render the batch for the judge.
 *
 * The rubric is a parameter so a project can manage it on a prompt platform
 * without shipping a release. The shipped text is the default, and it is what
 * every test and every unconfigured repository uses.
 */
export function buildJudgePrompt(
  findings: IdentifiedFinding[],
  instruction: string = CONFIDENCE_RUBRIC,
): string {
  const payload = findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    file: finding.filePath,
    line: finding.line,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
    impact: finding.impact,
    rule: finding.ruleId,
  }));
  return `${instruction}\n\nFindings:\n${JSON.stringify(payload, null, 2)}`;
}

/**
 * Turn a judge response into a score map.
 *
 * A finding the judge did not address gets no entry rather than a default. The
 * gate treats an absent score as unjudged and lets the finding through — which
 * is the right failure direction: a judge that silently drops a batch must not
 * silently delete real findings.
 */
export function collectScores(
  findings: IdentifiedFinding[],
  structured: unknown,
): Map<string, number> {
  const parsed = confidenceSchema.safeParse(structured);
  const scores = new Map<string, number>();
  if (!parsed.success) {
    return scores;
  }
  const known = new Set(findings.map((finding) => finding.id));
  for (const entry of parsed.data.scores) {
    if (known.has(entry.id)) {
      scores.set(entry.id, entry.score);
    }
  }
  return scores;
}

/**
 * Raise confidence when independent reviewers found the same thing.
 *
 * Two sub-agents working from different angles landing on one defect is real
 * evidence, and treating it as such is what makes fan-out worth its cost. The
 * bonus is capped so agreement can lift a borderline finding over the bar but
 * never rescue one the judge scored near zero.
 */
export function applyAgreementBonus(
  scores: Map<string, number>,
  agreementCounts: ReadonlyMap<string, number>,
): Map<string, number> {
  const adjusted = new Map(scores);
  for (const [id, score] of scores) {
    const agreements = agreementCounts.get(id) ?? 1;
    if (agreements <= 1) {
      continue;
    }
    const bonus = Math.min(15, (agreements - 1) * 8);
    adjusted.set(id, Math.min(100, score + bonus));
  }
  return adjusted;
}

/**
 * Count how many independent reporters raised each finding.
 *
 * Keyed on the content-derived id, so two agents describing the same defect at
 * the same location agree even when they word it differently — as long as they
 * pick the same title, which the id already normalises for case and whitespace.
 */
export function countAgreement(
  reports: Array<{ findings: IdentifiedFinding[] }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    // A single reporter raising the same finding twice is not agreement.
    for (const id of new Set(report.findings.map((finding) => finding.id))) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Merge sub-agent reports, keeping the richest version of each finding. */
export function mergeReports(
  reports: Array<{ findings: IdentifiedFinding[] }>,
): IdentifiedFinding[] {
  const byId = new Map<string, IdentifiedFinding>();
  for (const report of reports) {
    for (const finding of report.findings) {
      const existing = byId.get(finding.id);
      if (!existing) {
        byId.set(finding.id, finding);
        continue;
      }
      // Prefer whichever version actually explains itself: a finding with a fix
      // and an impact is more useful than the same finding stated bare.
      byId.set(finding.id, {
        ...existing,
        description: longer(existing.description, finding.description),
        suggestion: longer(existing.suggestion, finding.suggestion),
        impact: longer(existing.impact, finding.impact),
        evidence: longer(existing.evidence, finding.evidence),
      });
    }
  }
  return [...byId.values()];
}

function longer(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return b.length > a.length ? b : a;
}

/**
 * Build the judge the gate calls.
 *
 * Returns undefined when no threshold is in force, so a project that set
 * `confidenceThreshold: 0` pays nothing — not a model call that is then ignored.
 *
 * The judge scores; it never decides. The gate applies the threshold, which
 * keeps the accept/reject decision in one deterministic place and makes the
 * bar a config value rather than a property of a prompt.
 */
export function createInlineJudge(
  options: InlineJudgeOptions,
): InlineJudge | undefined {
  if (options.threshold <= 0) {
    return undefined;
  }

  return async (findings) => {
    const judgeable = findings.filter(needsJudgement);
    if (judgeable.length === 0) {
      return { scores: new Map(), warnings: [] };
    }

    const result = await generateStructured({
      host: options.host,
      chain: options.chain,
      context: options.context,
      systemPrompt: JUDGE_ROLE,
      message: buildJudgePrompt(judgeable, options.instruction),
      schema: confidenceSchema,
      operation: "judge-inline",
    });

    if (!result.data) {
      // An absent verdict must not delete findings. Returning no scores leaves
      // every one unjudged, and the gate lets an unjudged finding through — a
      // judge that cannot answer is not evidence that the reviewer was wrong.
      return {
        scores: new Map(),
        warnings: [
          ...result.warnings,
          `Confidence scoring did not return a usable result, so ${judgeable.length} ` +
            `finding(s) were gated without it.`,
        ],
      };
    }

    const scores = applyAgreementBonus(
      collectScores(judgeable, result.data),
      options.agreement ?? new Map(),
    );

    const unscored = judgeable.filter((finding) => !scores.has(finding.id));
    return {
      scores,
      warnings: [
        ...result.warnings,
        ...(unscored.length > 0
          ? [
              `The judge did not score ${unscored.length} finding(s); they were gated ` +
                `without a confidence check.`,
            ]
          : []),
      ],
    };
  };
}
