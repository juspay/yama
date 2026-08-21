/**
 * The gate — every finding passes through here before it can reach the PR.
 *
 * Pure and deterministic. The agent proposes; this decides. That ordering is the
 * whole design: prompt instructions about what not to report are probabilistic,
 * and at scale a probabilistic rule is a rule that is sometimes broken. The
 * invariants below are not.
 *
 * Order matters. Cheap structural checks run before expensive ones, and dedup
 * runs before validity so a finding already on the PR is never re-judged.
 */

import type {
  FindingSeverity,
  GateInput,
  GateResult,
  GuardRule,
  IdentifiedFinding,
  RejectedFinding,
  RejectionReason,
} from "../types/index.js";
import { buildFindingId } from "./Markers.js";
import { fileInChangeSet, lineWasChanged } from "../changes/ChangeSet.js";
import { matchesAnyPath } from "../policy/paths.js";

/** Severities that must carry a concrete fix, in descending order of harm. */
const FIX_REQUIRED: FindingSeverity[] = ["CRITICAL", "MAJOR"];

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  SUGGESTION: 0,
  MINOR: 1,
  MAJOR: 2,
  CRITICAL: 3,
};

const rejection = (
  finding: IdentifiedFinding,
  reason: RejectionReason,
  detail: string,
): RejectedFinding => ({ finding, reason, detail });

/**
 * Raise a finding's severity to the floor its path demands.
 *
 * Applied before the fix requirement, so a SUGGESTION promoted to MAJOR by a
 * guard also inherits the obligation to carry a fix. A floor that changed the
 * label but not the standard would be decoration.
 */
export function applySeverityFloor(
  finding: IdentifiedFinding,
  guards: GuardRule[] | undefined,
): IdentifiedFinding {
  if (!guards || guards.length === 0 || !finding.filePath) {
    return finding;
  }
  let floor: FindingSeverity | undefined;
  for (const guard of guards) {
    if (
      !guard.severityFloor ||
      !matchesAnyPath(finding.filePath, guard.paths)
    ) {
      continue;
    }
    if (!floor || SEVERITY_RANK[guard.severityFloor] > SEVERITY_RANK[floor]) {
      floor = guard.severityFloor;
    }
  }
  if (!floor || SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[floor]) {
    return finding;
  }
  // The id is content-derived and includes severity, so raising severity means
  // re-deriving it — otherwise the promoted finding would dedup against a
  // differently-severe twin.
  const promoted = { ...finding, severity: floor };
  return { ...promoted, id: buildFindingId(promoted) };
}

/** Run one submission through every invariant. */
export function gateFindings(input: GateInput): GateResult {
  const accepted: IdentifiedFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const seenInBatch = new Set<string>();

  for (const candidate of input.findings) {
    const identified: IdentifiedFinding = {
      ...candidate,
      id: candidate.id ?? buildFindingId(candidate),
    };
    const finding = applySeverityFloor(identified, input.guards);

    // 1 — duplicate within this submission
    if (seenInBatch.has(finding.id)) {
      rejected.push(
        rejection(
          finding,
          "duplicate-in-batch",
          "An identical finding appears earlier in this submission.",
        ),
      );
      continue;
    }
    seenInBatch.add(finding.id);

    // 2 — already on the pull request from an earlier run
    if (input.alreadyReported.has(finding.id)) {
      rejected.push(
        rejection(
          finding,
          "already-reported",
          `A comment for this finding already exists on the pull request (id ${finding.id}). ` +
            `Do not post it again — check instead whether it is now fixed.`,
        ),
      );
      continue;
    }

    // 3 — already accepted earlier in this run
    if (input.alreadyAccepted.has(finding.id)) {
      rejected.push(
        rejection(
          finding,
          "already-accepted",
          "This finding was accepted earlier in this run and is already queued to post.",
        ),
      );
      continue;
    }

    // 4 — learned false positive
    if (input.suppressed.has(finding.id)) {
      rejected.push(
        rejection(
          finding,
          "suppressed",
          "This pattern has been dismissed by the team often enough to be suppressed.",
        ),
      );
      continue;
    }

    // 5 — structural: the finding must point at code this PR touched.
    //     Policy findings are exempt: an ownership or guard violation is about
    //     the change as a whole, not a line within it.
    if (input.changeSet && finding.source !== "policy") {
      if (
        finding.filePath &&
        !fileInChangeSet(input.changeSet, finding.filePath)
      ) {
        rejected.push(
          rejection(
            finding,
            "file-not-in-change",
            `"${finding.filePath}" is not part of this pull request's changes.`,
          ),
        );
        continue;
      }
      if (
        input.changedLinesOnly &&
        finding.filePath &&
        finding.line !== undefined &&
        finding.line !== null &&
        !lineWasChanged(input.changeSet, finding.filePath, finding.line)
      ) {
        rejected.push(
          rejection(
            finding,
            "line-not-changed",
            `${finding.filePath}:${finding.line} was not modified by this pull request. ` +
              `Report pre-existing issues only when the change makes them newly reachable, ` +
              `and cite the changed line that does so.`,
          ),
        );
        continue;
      }
    }

    // 6 — a check already said this. Two voices on one line is noise.
    if (
      finding.source === "agent" &&
      input.checkFlagged &&
      finding.filePath &&
      finding.line !== undefined &&
      finding.line !== null &&
      input.checkFlagged.has(`${finding.filePath}:${finding.line}`)
    ) {
      rejected.push(
        rejection(
          finding,
          "already-flagged-by-check",
          "A configured check already reports this location; its finding will be posted instead.",
        ),
      );
      continue;
    }

    // 7 — identifying a problem without a fix is half a review.
    if (
      FIX_REQUIRED.includes(finding.severity) &&
      !(finding.suggestion && finding.suggestion.trim().length > 0)
    ) {
      rejected.push(
        rejection(
          finding,
          "missing-fix",
          `A ${finding.severity} finding must carry a concrete fix. Add a "suggestion" ` +
            `showing the corrected code, and an "impact" saying what breaks without it.`,
        ),
      );
      continue;
    }

    // 8 — calibrated confidence, for agent claims only. A compiler error is not
    //     a probabilistic claim, so check and policy findings skip this.
    if (finding.source === "agent" && input.confidence) {
      const score = input.confidence.get(finding.id);
      if (score !== undefined && score < input.confidenceThreshold) {
        rejected.push(
          rejection(
            finding,
            "below-confidence",
            `Verification scored this ${score}/100, below the ${input.confidenceThreshold} ` +
              `threshold. Either establish it with concrete evidence, or drop it.`,
          ),
        );
        continue;
      }
    }

    accepted.push(finding);
  }

  return {
    accepted,
    rejected,
    instruction: buildInstruction(
      accepted.length,
      rejected.length,
      input.dryRun,
    ),
  };
}

function buildInstruction(
  accepted: number,
  rejected: number,
  dryRun: boolean,
): string {
  if (accepted === 0) {
    return rejected === 0
      ? "Nothing submitted."
      : `All ${rejected} finding(s) were rejected. Read each reason — some are worth ` +
          `resubmitting with better evidence, most are not.`;
  }
  return dryRun
    ? `${accepted} finding(s) accepted. This is a dry run: do not post anything. ` +
        `Include them in your final report.`
    : `${accepted} finding(s) accepted. Post exactly one inline comment for each, now, ` +
        `before moving on. Post nothing for the ${rejected} rejected finding(s).`;
}
