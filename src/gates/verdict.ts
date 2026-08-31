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
  EngineTask,
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

/**
 * Whether this run is entitled to a verdict at all (TASKS:Y4.7).
 *
 * `decideVerdict([], policy)` returns APPROVE, and it is right to: no findings over a change
 * somebody reviewed is the ordinary happy path, and the whole point of a reviewer is to be
 * able to say "this is fine". What it cannot distinguish is the case where nobody reviewed
 * anything — and that is not hypothetical. On curator PR #702 the work stage closed all
 * four of its items as blocked, produced nothing, and the run approved a change it had
 * never read, on a pull request, in production.
 *
 * The difference between the two is on the checklist, in the distinction the checklist tools
 * already draw: `done` means the item was worked, `closed` means it was abandoned with a
 * reason. A run over a real change where NOT ONE item was worked and no finding came out did
 * not review anything, whatever its JSON says.
 *
 * Returns why the run cannot be trusted to decide, or `undefined` when it can.
 */
export const reviewEstablishedNothing = (input: {
  /** Reviewable files. No change, nothing owed — a run with nothing to do may approve. */
  changedFiles: number;
  /** The checklist as the engine holds it at the end of the work stage. */
  checklist: readonly EngineTask[];
  /** Findings that survived grounding. */
  findings: number;
}): string | undefined => {
  if (input.changedFiles === 0 || input.findings > 0) {
    return undefined;
  }
  const worked = input.checklist.filter((task) => task.status === "done");
  if (worked.length > 0) {
    return undefined;
  }
  const closed = input.checklist.filter((task) => task.status === "closed");
  return `not one of ${input.checklist.length} checklist item(s) was worked over a change of ${input.changedFiles} file(s), and no finding came out of it${
    closed.length > 0 ? ` — ${closed.length} were closed unworked` : ""
  }. A review that established nothing is not a review that found nothing, and this run will not approve a change it did not read`;
};

/**
 * Stages whose rescue actually undermines a verdict.
 *
 * The first version of this caveat downgraded on ANY recovered stage, which was an
 * over-correction: on a slow gateway a work round gets closed out routinely, and a run
 * that then finished its checklist and produced findings did do the job. What a verdict
 * genuinely rests on is the checklist the review was planned against and the collation
 * the findings came out of — if either of those had to be rescued, "this change is fine"
 * is a claim the run cannot make. `warmup` shapes tone, `work` answers to its own
 * completeness gate, and `delivery` happens after the decision.
 */
const DECIDING_STAGES: readonly string[] = ["taskInsertion", "collate"];

/**
 * A verdict that knows the run had to be rescued (TASKS:Y4.1).
 *
 * `recovered` was introduced to mean "this stage did not answer on its own — the gate
 * closed it out". It was recorded on the metric, printed in the progress line, and then
 * consulted by nothing: `decideVerdict` is a pure function of findings, so a run whose
 * Task Insertion or Work stage had to be rescued could still return APPROVE, indistinguishable
 * from one that did its job. That makes the flag decoration, which this repository's own
 * review caught and was right about.
 *
 * An approval is the one decision that asserts something POSITIVE about a change — that it
 * is fine. A run that had to be helped up cannot make that assertion at full strength, so
 * approve becomes comment and the reason names the stage. Block and comment are untouched:
 * a rescued run that still found something serious found it, and the finding stands on its
 * own evidence.
 */
export const withRecoveryCaveat = (
  verdict: Verdict,
  stages: readonly { stage: string; recovered?: boolean }[],
): Verdict => {
  const rescued = [
    ...new Set(
      stages
        .filter((stage) => stage.recovered === true)
        .map((s) => s.stage)
        .filter((stage) => DECIDING_STAGES.includes(stage)),
    ),
  ];
  if (rescued.length === 0 || verdict.decision !== "approve") {
    return verdict;
  }
  return {
    decision: "comment",
    reasons: [
      ...verdict.reasons,
      `${rescued.join(", ")} did not answer on its own and was closed out by the gate — a review that had to be rescued does not approve a change, it reports what it managed to establish`,
    ],
  };
};

/** Most serious first, then by confidence — the order findings are posted and reported in. */
export const rankFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      confidenceOf(b) - confidenceOf(a) ||
      a.id.localeCompare(b.id),
  );
