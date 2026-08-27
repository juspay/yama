/**
 * The severity taxonomy, in one place.
 *
 * Three modules were about to hold their own copy of the same four strings: the store
 * validator, the stage schemas and now the verdict policy. They are one ORDERED list —
 * ordered because both the verdict policy (TASKS:Y5.5) and the posting threshold
 * (TASKS:Y3.5) ask "is this at least as serious as X", and an order that lives in two
 * places is an order that will disagree with itself.
 *
 * `src/types/findings.ts` derives `Severity` from this array, so the type, the validator
 * and the ranking cannot drift.
 */
import { z } from "zod";
import type { Severity } from "../types/index.js";

/** Most serious first. The index IS the rank — see `severityRank`. */
export const SEVERITIES = ["CRITICAL", "MAJOR", "MINOR", "INFO"] as const;

/** The one validator for a severity value; its output type IS `Severity`. */
export const SeverityLevelSchema = z.enum(SEVERITIES);

/** 0 is the most serious. Lower ranks outrank higher ones. */
export const severityRank = (severity: Severity): number =>
  SEVERITIES.indexOf(severity);

/** True when `severity` is at least as serious as `floor` (inclusive). */
export const severityAtLeast = (severity: Severity, floor: Severity): boolean =>
  severityRank(severity) <= severityRank(floor);

/** Counts per severity, most serious first, zeroes included — reasons read off this. */
export const countBySeverity = (
  severities: readonly Severity[],
): Record<Severity, number> => {
  const counts: Record<Severity, number> = {
    CRITICAL: 0,
    MAJOR: 0,
    MINOR: 0,
    INFO: 0,
  };
  for (const severity of severities) {
    counts[severity] += 1;
  }
  return counts;
};
