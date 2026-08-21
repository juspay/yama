/**
 * The capability map and impact ledger.
 *
 * The value here compounds: after thirty merges, "changes to the posting path
 * needed correction in three of the last eight attempts" is a fact a reviewer
 * cannot derive from the diff and could not know without having watched. That
 * one number changes how a reviewer reads a change.
 *
 * Everything is pure over already-loaded data. Reading and writing the files is
 * the caller's job, so this stays testable without a filesystem.
 */

import type {
  ChangeSet,
  ChangeKind,
  ImpactLogEntry,
  ImpactReport,
  ProductCapability,
} from "../types/index.js";
import { changedPaths } from "../changes/ChangeSet.js";
import { matchesAnyPath } from "../policy/paths.js";

/** Capabilities a change touches, most specific first. */
export function capabilitiesForPaths(
  capabilities: ProductCapability[],
  paths: string[],
): ProductCapability[] {
  const matched = capabilities.filter((capability) =>
    paths.some((path) => matchesAnyPath(path, capability.paths)),
  );
  // A capability scoped to three paths says more than one scoped to "src/**",
  // so the narrower one leads.
  return matched.sort((a, b) => a.paths.length - b.paths.length);
}

export function capabilitiesForChange(
  capabilities: ProductCapability[],
  changeSet: ChangeSet,
): ProductCapability[] {
  return capabilitiesForPaths(
    capabilities,
    changedPaths(changeSet, { includeExcluded: true }),
  );
}

/**
 * Everything that depends on a capability, transitively.
 *
 * Cycles are tolerated rather than rejected: a real system has them, and a
 * reviewer asking "what else breaks" should get an answer, not a validation
 * error about the map's shape.
 */
export function dependentsOf(
  capabilities: ProductCapability[],
  capabilityId: string,
): ProductCapability[] {
  const found = new Map<string, ProductCapability>();
  const queue = [capabilityId];
  const seen = new Set<string>([capabilityId]);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const capability of capabilities) {
      if (!capability.dependsOn?.includes(current) || seen.has(capability.id)) {
        continue;
      }
      seen.add(capability.id);
      found.set(capability.id, capability);
      queue.push(capability.id);
    }
  }
  return [...found.values()];
}

/** History for one capability, newest first. */
export function historyFor(
  log: ImpactLogEntry[],
  capabilityId: string,
): ImpactLogEntry[] {
  return log
    .filter((entry) => entry.capabilities.includes(capabilityId))
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

/**
 * How often changes to a capability have needed correcting.
 *
 * This is the number worth surfacing on a pull request. It is computed over the
 * recent window rather than all history, because a capability that was unstable
 * two years ago and solid since should not be described as risky.
 */
export function historicalRisk(
  log: ImpactLogEntry[],
  capabilityId: string,
  window = 10,
): ImpactReport["historicalRisk"] {
  const history = historyFor(log, capabilityId).slice(0, window);
  if (history.length === 0) {
    return undefined;
  }
  const corrected = history.filter(
    (entry) => (entry.laterCorrectedBy?.length ?? 0) > 0,
  );
  return {
    totalChanges: history.length,
    corrected: corrected.length,
    recentCorrections: corrected.flatMap(
      (entry) => entry.laterCorrectedBy ?? [],
    ),
  };
}

/**
 * Link a correcting pull request back to what it corrected.
 *
 * Called at merge time. Without this backfill the ledger records what changed
 * but never what went wrong, which is the half that makes it useful.
 */
export function linkCorrection(
  log: ImpactLogEntry[],
  correction: { pullRequestId: number; corrects: number[] },
): ImpactLogEntry[] {
  const corrects = new Set(correction.corrects);
  return log.map((entry) => {
    if (!corrects.has(entry.pullRequestId)) {
      return entry;
    }
    const existing = entry.laterCorrectedBy ?? [];
    return existing.includes(correction.pullRequestId)
      ? entry
      : { ...entry, laterCorrectedBy: [...existing, correction.pullRequestId] };
  });
}

/**
 * Infer what a commit corrects.
 *
 * Conventional-commit reverts and explicit "fixes #N" references are the two
 * signals available without asking anyone. Both are conservative: a false
 * negative loses one data point, a false positive teaches the ledger a lie.
 */
export function inferCorrections(commitMessage: string): {
  kind: ChangeKind | undefined;
  corrects: number[];
} {
  const corrects = new Set<number>();

  const revert = /^Revert\s+"?(.+?)"?$/im.exec(commitMessage);
  const isRevert = revert !== null || /^revert(\(.+\))?:/im.test(commitMessage);

  for (const match of commitMessage.matchAll(
    /(?:reverts?|fixes|fixed|closes)\s+(?:pull request\s+)?#(\d+)/gi,
  )) {
    corrects.add(Number(match[1]));
  }
  // A revert commit references the reverted PR in its own subject.
  if (isRevert) {
    for (const match of commitMessage.matchAll(/#(\d+)/g)) {
      corrects.add(Number(match[1]));
    }
  }

  const kind: ChangeKind | undefined = isRevert
    ? "revert"
    : /^fix(\(.+\))?:/im.test(commitMessage)
      ? "fix"
      : /^perf(\(.+\))?:/im.test(commitMessage)
        ? "perf"
        : /^(refactor|chore|test|docs|style)(\(.+\))?:/im.test(commitMessage)
          ? "internal"
          : undefined;

  return { kind, corrects: [...corrects] };
}

/** Assemble the context an impact specialist starts from. */
export function buildImpactContext(
  capabilities: ProductCapability[],
  log: ImpactLogEntry[],
  changeSet: ChangeSet,
): {
  touched: ProductCapability[];
  dependents: ProductCapability[];
  silentFailureModes: string[];
  risk: Array<{ capabilityId: string; risk: ImpactReport["historicalRisk"] }>;
  recentChanges: ImpactLogEntry[];
} {
  const touched = capabilitiesForChange(capabilities, changeSet);
  const dependents = touched
    .flatMap((capability) => dependentsOf(capabilities, capability.id))
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.id === candidate.id) === index &&
        !touched.some((entry) => entry.id === candidate.id),
    );

  return {
    touched,
    dependents,
    silentFailureModes: touched
      .filter((capability) => capability.failureMode)
      .map((capability) => `${capability.name}: ${capability.failureMode}`),
    risk: touched.map((capability) => ({
      capabilityId: capability.id,
      risk: historicalRisk(log, capability.id),
    })),
    recentChanges: touched
      .flatMap((capability) => historyFor(log, capability.id).slice(0, 3))
      .filter(
        (entry, index, all) =>
          all.findIndex(
            (other) => other.pullRequestId === entry.pullRequestId,
          ) === index,
      ),
  };
}

/** Render an impact report for the summary comment. */
export function renderImpactReport(report: ImpactReport): string {
  const lines: string[] = [];

  if (report.capabilities.length > 0) {
    lines.push(
      `**Touches:** ${report.capabilities
        .map((capability) =>
          capability.criticality
            ? `${capability.name} (${capability.criticality})`
            : capability.name,
        )
        .join(", ")}`,
    );
  }
  lines.push(`**Change kind:** ${report.changeKind}`);
  lines.push(`**Blast radius:** ${report.blastRadius}`);

  if (report.userVisibleEffect) {
    lines.push(`**User-visible effect:** ${report.userVisibleEffect}`);
  }

  for (const mode of report.silentFailureModes) {
    lines.push(`**Fails silently:** ${mode}`);
  }

  if (report.historicalRisk && report.historicalRisk.corrected > 0) {
    lines.push(
      `**Historical risk:** this area needed correction in ` +
        `${report.historicalRisk.corrected} of the last ${report.historicalRisk.totalChanges} ` +
        `changes (${report.historicalRisk.recentCorrections
          .map((id) => `#${id}`)
          .join(", ")}).`,
    );
  }

  if (report.suggestedTests.length > 0) {
    lines.push("", "**Worth testing:**");
    for (const test of report.suggestedTests) {
      lines.push(`- ${test}`);
    }
  }

  if (report.unresolved.length > 0) {
    lines.push("", "**Not traced:**");
    for (const item of report.unresolved) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}

/**
 * The impact report Yama can derive without asking a model anything.
 *
 * Everything here comes from the capability map and the impact ledger, both of
 * which are facts the repository recorded on earlier merges. The impact
 * specialist adds judgement on top — what will break and for whom — but this
 * part is arithmetic, so it is always available and always the same.
 *
 * Returns undefined when the repository has no capability map or the change
 * touches nothing in it. That is the documented degraded state, and an empty
 * "Impact" section saying nothing would be worse than none.
 */
export function deriveImpactReport(
  capabilities: ProductCapability[],
  log: ImpactLogEntry[],
  changeSet: ChangeSet,
): ImpactReport | undefined {
  if (capabilities.length === 0) {
    return undefined;
  }

  const context = buildImpactContext(capabilities, log, changeSet);
  if (context.touched.length === 0) {
    return undefined;
  }

  const riskiest = context.risk
    .map((entry) => entry.risk)
    .filter((risk): risk is NonNullable<typeof risk> => risk !== undefined)
    .sort((a, b) => b.corrected - a.corrected)[0];

  return {
    capabilities: context.touched.map((capability) => ({
      id: capability.id,
      name: capability.name,
      ...(capability.criticality
        ? { criticality: capability.criticality }
        : {}),
    })),
    // Deliberately the neutral value: the KIND of change is a judgement about
    // intent, and claiming "contract-change" from path matching alone would be
    // a guess dressed as a fact. The specialist sets it when it can.
    changeKind: "internal",
    blastRadius:
      context.dependents.length > 0
        ? `${context.dependents.length} dependent capability(ies): ` +
          context.dependents.map((capability) => capability.name).join(", ")
        : "no other mapped capability depends on this",
    ...(context.touched.some((capability) => capability.userVisible)
      ? {
          userVisibleEffect: context.touched
            .filter((capability) => capability.userVisible)
            .map((capability) => capability.name)
            .join(", "),
        }
      : {}),
    silentFailureModes: context.silentFailureModes,
    ...(riskiest ? { historicalRisk: riskiest } : {}),
    suggestedTests: [],
    unresolved: [],
  };
}
