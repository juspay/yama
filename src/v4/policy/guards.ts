/**
 * Guard evaluation — path-scoped policy, evaluated in code.
 *
 * Guards express three things a project wants enforced regardless of what any
 * model concludes: some paths may not be touched, some paths demand certain
 * checks pass, and some paths raise the severity floor for anything found there.
 *
 * Pure. Zero tokens. Deterministic. The severity floor is applied by the gate;
 * the other two produce findings here.
 */

import type {
  ChangeSet,
  GuardEvaluation,
  GuardRule,
  IdentifiedFinding,
} from "../types/index.js";
import { changedPaths } from "../changes/ChangeSet.js";
import { matchesAnyPath } from "./paths.js";
import { buildFindingId } from "../findings/Markers.js";

/** Which guards apply to this change. */
export function applicableGuards(
  guards: GuardRule[],
  changeSet: ChangeSet,
): Array<{ guard: GuardRule; paths: string[] }> {
  // Excluded files still count for policy: deleting a lockfile or touching a
  // generated file under a forbidden path is exactly the kind of change a guard
  // is meant to catch, and skipping it because Yama does not review that file
  // would be a hole.
  const paths = changedPaths(changeSet, { includeExcluded: true });
  return guards
    .map((guard) => ({
      guard,
      paths: paths.filter((path) => matchesAnyPath(path, guard.paths)),
    }))
    .filter((entry) => entry.paths.length > 0);
}

const asFinding = (
  guard: GuardRule,
  title: string,
  description: string,
  suggestion: string,
  filePath?: string,
): IdentifiedFinding => {
  const candidate = {
    severity: "MAJOR" as const,
    title,
    description,
    suggestion,
    impact: guard.reason ?? "This path is governed by a project guard.",
    filePath,
    line: null,
    source: "policy" as const,
    ruleId: guard.id,
  };
  return { ...candidate, id: buildFindingId(candidate) };
};

/**
 * Evaluate guards against a change set and the checks that actually ran.
 *
 * @param checkOutcomes  Check id → whether it passed. A check that did not run
 *                       at all is treated as not satisfied: a required check
 *                       that silently did not execute is the same risk as one
 *                       that failed.
 */
export function evaluateGuards(
  guards: GuardRule[],
  changeSet: ChangeSet,
  checkOutcomes: ReadonlyMap<string, boolean> = new Map(),
): GuardEvaluation {
  const findings: IdentifiedFinding[] = [];
  const violatedRuleIds: string[] = [];
  const requiredCheckIds = new Set<string>();

  for (const { guard, paths } of applicableGuards(guards, changeSet)) {
    if (guard.forbid) {
      violatedRuleIds.push(guard.id);
      findings.push(
        asFinding(
          guard,
          `Change touches a protected path (${guard.id})`,
          `This pull request modifies ${paths.length} path(s) covered by the "${guard.id}" ` +
            `guard: ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}.`,
          guard.reason
            ? `Revert these changes, or get the guard amended: ${guard.reason}`
            : "Revert these changes, or amend the guard in .yama/policy/guards.yaml.",
          paths[0],
        ),
      );
      continue;
    }

    for (const checkId of guard.requireChecks ?? []) {
      requiredCheckIds.add(checkId);
      const passed = checkOutcomes.get(checkId);
      if (passed === true) {
        continue;
      }
      violatedRuleIds.push(guard.id);
      findings.push(
        asFinding(
          guard,
          passed === false
            ? `Required check "${checkId}" failed for a guarded path`
            : `Required check "${checkId}" did not run for a guarded path`,
          `The "${guard.id}" guard requires "${checkId}" to pass for changes under ` +
            `${guard.paths.join(", ")}. It ${passed === false ? "failed" : "did not run"}.`,
          passed === false
            ? `Fix what "${checkId}" reports, then push again.`
            : `Ensure "${checkId}" is enabled in .yama/checks.yaml and can execute in this environment.`,
          paths[0],
        ),
      );
    }
  }

  return {
    findings,
    violatedRuleIds: [...new Set(violatedRuleIds)],
    requiredCheckIds: [...requiredCheckIds],
  };
}
