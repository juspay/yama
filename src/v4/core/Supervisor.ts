/**
 * The supervisor — what watches the agent between turns.
 *
 * The agent decides how to review. The supervisor decides whether it is still
 * making progress, and re-states the rules that matter for what it is about to
 * look at. Both halves are necessary: an unsupervised loop drifts and burns its
 * budget on research, and a scripted loop cannot review anything it was not told
 * to expect.
 *
 * Rule re-injection is the part that is easy to skip and expensive to omit. In a
 * long session the system instruction is pushed out of view, and after a
 * compaction it may be gone entirely. Restating the binding rules for the next
 * turn's files is what keeps a twenty-turn review as compliant as a two-turn one.
 *
 * Pure: takes observations, returns guidance. Nothing here calls a model.
 */

import { recall } from "../tools/recall.js";
import type {
  RecallEntry,
  SuperviseOptions,
  SupervisorSignal,
  SupervisorVerdict,
  TurnObservation,
} from "../types/index.js";

/** Thresholds. Deliberately generous — this catches spinning, not slowness. */
export const WASTE_THRESHOLDS = {
  duplicateCallLimit: 3,
  emptyResultStreakLimit: 4,
  errorStreakLimit: 3,
};

/** Repeated identical calls mean the agent is stuck, not thorough. */
export function detectDuplicateCalls(
  toolCalls: TurnObservation["toolCalls"],
): string[] {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const key = `${call.name}(${call.params})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= WASTE_THRESHOLDS.duplicateCallLimit)
    .map(([key]) => key);
}

/** Longest run of consecutive calls matching a predicate. */
export function longestStreak(
  toolCalls: TurnObservation["toolCalls"],
  predicate: (call: TurnObservation["toolCalls"][number]) => boolean,
): number {
  let longest = 0;
  let current = 0;
  for (const call of toolCalls) {
    current = predicate(call) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** Planned files the agent has not looked at yet. */
export function coverageGap(observation: TurnObservation): string[] {
  const examined = new Set(observation.examinedPaths);
  return observation.plannedPaths.filter((path) => !examined.has(path));
}

/**
 * Decide whether to intervene, and with what.
 *
 * Intervening on every turn would be nagging, and an agent that is told it is
 * off track every turn learns to ignore the message. So the bar is a real
 * signal: a gap, a stall, or a compaction that may have dropped the rules.
 */
export function supervise(options: SuperviseOptions): SupervisorVerdict {
  const { observation } = options;
  const signals: SupervisorSignal[] = [];
  const parts: string[] = [];

  const gap = coverageGap(observation);
  if (gap.length > 0 && options.moreTurnsExpected) {
    signals.push("coverage-gap");
    parts.push(
      `${gap.length} file(s) from your plan are still unexamined: ` +
        `${gap.slice(0, 10).join(", ")}${gap.length > 10 ? ", …" : ""}.`,
    );
  }

  // A finding described in prose but never submitted is invisible to the gate,
  // and therefore invisible on the pull request.
  if (observation.claimedFindings > 0 && observation.gateSubmissions === 0) {
    signals.push("gate-skipped");
    parts.push(
      `You described ${observation.claimedFindings} finding(s) but have not called ` +
        `submit_finding. Nothing reaches the pull request without going through it.`,
    );
  }

  if (observation.unpostedFindingIds.length > 0) {
    signals.push("unposted-findings");
    parts.push(
      `These findings were accepted but have no comment yet: ` +
        `${observation.unpostedFindingIds.join(", ")}. Post them before continuing.`,
    );
  }

  const duplicates = detectDuplicateCalls(observation.toolCalls);
  if (duplicates.length > 0) {
    signals.push("duplicate-calls");
    parts.push(
      `You have repeated the same call several times: ${duplicates[0]}. ` +
        `It will not return anything different — try a different approach.`,
    );
  }

  if (
    longestStreak(observation.toolCalls, (call) => call.empty === true) >=
    WASTE_THRESHOLDS.emptyResultStreakLimit
  ) {
    signals.push("empty-streak");
    parts.push(
      `Several searches in a row came back empty. Narrow the question or move on ` +
        `to the next file rather than continuing to probe.`,
    );
  }

  if (
    longestStreak(observation.toolCalls, (call) => call.error === true) >=
    WASTE_THRESHOLDS.errorStreakLimit
  ) {
    signals.push("error-streak");
    parts.push(
      `Several tool calls in a row failed. Work with what you already have rather ` +
        `than retrying the same call.`,
    );
  }

  // After a compaction the system instruction may no longer be in view. This is
  // the moment to restate the contract, not a moment to assume it survived.
  if (observation.compacted) {
    signals.push("compaction");
    parts.push(
      `The conversation was compacted. To restate: submit every candidate finding ` +
        `to submit_finding before posting; post accepted findings immediately; ` +
        `CRITICAL and MAJOR findings are refused without a concrete fix; comment only ` +
        `on lines this pull request changed.`,
    );
  }

  if (signals.length === 0) {
    return { intervene: false, signals, guidance: "" };
  }

  // Re-inject the rules governing what the agent is about to look at. Cheap,
  // bounded, and the difference between a rule being followed on turn two and
  // on turn twenty.
  const rules = gap.length > 0 ? renderRulesFor(options.entries, gap) : "";

  return {
    intervene: true,
    signals,
    guidance: [parts.join("\n\n"), rules].filter(Boolean).join("\n\n"),
  };
}

/** The binding rules for a set of paths, rendered compactly. */
export function renderRulesFor(
  entries: RecallEntry[],
  paths: string[],
): string {
  const result = recall(entries, { paths, limit: 5 });
  if (result.entries.length === 0) {
    return "";
  }
  const lines = result.entries.map(
    (entry) =>
      `- [${entry.id}] ${entry.title}${entry.blocking ? " (BLOCKING)" : ""}`,
  );
  return `Rules governing the files you have left:\n${lines.join("\n")}`;
}
