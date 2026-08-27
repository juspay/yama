/**
 * The verdict policy (TASKS:Y5.5) — a pure function of (findings, config).
 *
 * Pure on purpose: what a run decides has to be re-derivable from the banked findings and
 * the `verdict:` block alone, without re-running the model. Everything the policy consults
 * is config, so a repository can be as strict or as forgiving as it likes without a code
 * change, and the reasons say which rule fired.
 *
 * Defaults (`src/config/schema.ts`): any CRITICAL blocks, MAJOR-only comments, the rest
 * approves.
 */
import type {
  Finding,
  Severity,
  Verdict,
  VerdictConfig,
} from "../types/index.js";
import { countBySeverity, severityRank } from "../util/severity.js";

/** Ids named in a reason before it collapses into a count. */
const MAX_NAMED = 5;

/** A finding with no stated confidence is taken at its word. */
const confidenceOf = (finding: Finding): number => finding.confidence ?? 1;

const named = (findings: readonly Finding[]): string => {
  const ids = findings.map((finding) => finding.id);
  return ids.length > MAX_NAMED
    ? `${ids.slice(0, MAX_NAMED).join(", ")} and ${ids.length - MAX_NAMED} more`
    : ids.join(", ");
};

/** `2 CRITICAL, 1 MAJOR` — most serious first, empty severities left out. */
const tally = (findings: readonly Finding[]): string => {
  const counts = countBySeverity(findings.map((finding) => finding.severity));
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
};

const matches = (
  findings: readonly Finding[],
  severities: readonly Severity[],
): Finding[] =>
  findings.filter((finding) => severities.includes(finding.severity));

/**
 * Decides the verdict. `blockOn` wins over `commentOn` where a severity is in both, and
 * `blockAfter` turns a pile of comment-level findings into a block — the case where
 * nothing is individually fatal but the change is not ready.
 */
export const decideVerdict = (
  findings: readonly Finding[],
  policy: VerdictConfig,
): Verdict => {
  const considered = findings.filter(
    (finding) => confidenceOf(finding) >= policy.minConfidence,
  );
  const dropped = findings.length - considered.length;
  const noise =
    dropped > 0
      ? [
          `${dropped} finding(s) below the ${policy.minConfidence} confidence floor were not counted`,
        ]
      : [];

  const blocking = matches(considered, policy.blockOn);
  if (blocking.length > 0) {
    return {
      decision: "block",
      reasons: [
        `${tally(blocking)}: ${named(blocking)} — blockOn covers ${policy.blockOn.join(", ")}`,
        ...noise,
      ],
    };
  }

  const commenting = matches(considered, policy.commentOn);
  if (policy.blockAfter > 0 && commenting.length >= policy.blockAfter) {
    return {
      decision: "block",
      reasons: [
        `${commenting.length} findings at ${policy.commentOn.join(", ")} reached the blockAfter threshold of ${policy.blockAfter}: ${named(commenting)}`,
        ...noise,
      ],
    };
  }

  if (commenting.length > 0) {
    return {
      decision: "comment",
      reasons: [
        `${tally(commenting)}: ${named(commenting)} — commentOn covers ${policy.commentOn.join(", ")}, which reports without gating`,
        ...noise,
      ],
    };
  }

  if (considered.length > 0) {
    return {
      decision: "approve",
      reasons: [
        `${tally(considered)}, none at a severity the policy acts on`,
        ...noise,
      ],
    };
  }

  return { decision: "approve", reasons: noise };
};

/** Most serious first, then by confidence — the order findings are posted and reported in. */
export const rankFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      confidenceOf(b) - confidenceOf(a) ||
      a.id.localeCompare(b.id),
  );
