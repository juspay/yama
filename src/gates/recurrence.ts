/**
 * The recurrence gate (TASKS:Y7.1) — holding a re-review to the findings it already made.
 *
 * A recurring run has two jobs the first one did not: account for every finding the last
 * review left open, and decide over the FULL open set rather than only over what it
 * happened to look at this time. The agent does the classifying, because only something
 * that has read the current code can say whether a problem is fixed. This gate does the
 * two things the agent must not be trusted with:
 *
 *   1. **Coverage.** A prior id the plan said nothing about stays OPEN. Silence is not
 *      evidence of a fix, and a review that quietly drops its own last finding is worse
 *      than one that repeats it.
 *   2. **Identity.** A classification of an id that was never open is ignored rather than
 *      believed — the ledger decides what was open, not the model.
 *
 * Pure. Nothing here reads a file, calls a tool or throws.
 */
import type {
  Finding,
  PriorFindingReview,
  PriorFindingsGateResult,
} from "../types/index.js";

/** The empty result, for a run with nothing behind it. */
export const NO_PRIOR_FINDINGS: PriorFindingsGateResult = {
  open: [],
  fixed: [],
  moot: [],
  unresolved: [],
  reviewed: [],
};

/**
 * Splits the previous review's open findings by what this run says became of them.
 *
 * `current` is what this run found on its own: a prior finding re-found this run is open
 * whatever the agent claimed about it, because the evidence is in front of us.
 */
export const classifyPriorFindings = (input: {
  /** The previous run's open findings, from the store's ledger. */
  prior: readonly Finding[];
  /** The agent's account, from the insertion plan. */
  reviewed?: readonly PriorFindingReview[];
  /** Ids this run found again by itself. */
  current?: readonly string[];
}): PriorFindingsGateResult => {
  const refound = new Set(input.current ?? []);
  const known = new Map(input.prior.map((finding) => [finding.id, finding]));
  const stated = new Map<string, PriorFindingReview>();
  for (const review of input.reviewed ?? []) {
    // A claim about an id that was never open is not a classification of anything.
    if (known.has(review.id) && !stated.has(review.id)) {
      stated.set(review.id, review);
    }
  }

  const open: Finding[] = [];
  const fixed: string[] = [];
  const moot: string[] = [];
  const unresolved: string[] = [];

  for (const finding of input.prior) {
    const review = stated.get(finding.id);
    if (review === undefined) {
      unresolved.push(finding.id);
      open.push(finding);
      continue;
    }
    if (refound.has(finding.id) || review.state === "open") {
      open.push(finding);
      continue;
    }
    (review.state === "fixed" ? fixed : moot).push(finding.id);
  }

  return { open, fixed, moot, unresolved, reviewed: [...stated.values()] };
};

/**
 * The nudge for a plan that ignored prior findings. Not a retry — the checklist is already
 * written, and the honest fix is to carry the unaccounted ones as open and say so.
 */
export const unresolvedPriorFindings = (
  result: PriorFindingsGateResult,
): string | undefined =>
  result.unresolved.length === 0
    ? undefined
    : `${result.unresolved.length} finding(s) from the previous review were never accounted for and are carried as still open: ${result.unresolved.join(", ")}`;
