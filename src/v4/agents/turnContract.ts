/**
 * What a review turn must end with.
 *
 * Two independent channels carry the same facts, and the harness takes whichever
 * arrives:
 *
 *  - `report_progress`, a TOOL. Its input schema is validated natively by every
 *    provider that can call tools at all, and the call is visible in the trace.
 *  - this SCHEMA, attached to the turn itself. Where the provider supports tools
 *    and structured output together it is enforced at the wire; where it does
 *    not, the runtime coerces the turn's final text against it.
 *
 * Belt and braces, deliberately. A per-turn schema alone was rejected in v3
 * because a schema alongside tools was unevenly supported and the fallback was
 * JSON scraped out of prose. A tool alone leaves the harness blind whenever the
 * model narrates its progress instead of reporting it — "I have finished the
 * migration files" in prose is invisible to code. Running both means a turn is
 * legible when either channel works, and the reconciliation below prefers
 * whichever actually said something rather than trusting one blindly.
 *
 * The schema is kept deliberately flat and free of string patterns, minimums and
 * long enums: complex schemas are rejected outright by some providers and
 * degrade to text coercion on others, and a contract that only holds on one
 * vendor is not a contract.
 */

import { z } from "zod";
import type { TurnProgress } from "../types/index.js";

const planSchema = z.object({
  groups: z
    .array(
      z.object({
        id: z.string(),
        paths: z.array(z.string()),
      }),
    )
    .describe("Every changed file, in exactly one group."),
  declined: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .optional()
    .describe("Files you are not reviewing, each with a reason."),
});

/**
 * The shape of every review turn's answer.
 *
 * `summary` is first and required because a schema whose only fields are
 * bookkeeping invites a model to return bookkeeping and say nothing — the
 * summary is where the turn's actual reasoning lands, and the supervisor reads
 * it.
 */
export const turnOutcomeSchema = z.object({
  summary: z
    .string()
    .describe("What you did this turn and what you concluded."),
  plan: planSchema.optional(),
  completedGroups: z
    .array(z.string())
    .optional()
    .describe("Group ids you finished reviewing this turn."),
  cleanGroups: z
    .array(z.string())
    .optional()
    .describe("Group ids you reviewed and found nothing worth reporting in."),
  claimedFindings: z
    .number()
    .optional()
    .describe("How many problems you described this turn."),
  resolved: z
    .object({
      pullRequestId: z.number().optional(),
      headSha: z.string().optional(),
      baseSha: z.string().optional(),
    })
    .optional(),
  descriptionUpdated: z.boolean().optional(),
  descriptionSections: z.array(z.string()).optional(),
  done: z
    .boolean()
    .optional()
    .describe("True when you have nothing further to do in this stage."),
});

/**
 * Fold a turn's structured answer into what the progress tool recorded.
 *
 * Additive on every list, because the two channels report the same work and
 * neither is authoritative: an agent that called `report_progress` for group A
 * and then described finishing group B in its structured summary has finished
 * both. Taking the union is the only reading that never loses work; the cost is
 * that a group claimed twice is counted once, which is what the sets are for.
 *
 * `done` and `descriptionUpdated` latch on for the same reason — a turn that
 * said it was finished in either channel said it was finished.
 */
export function mergeTurnOutcome(
  progress: TurnProgress,
  outcome: unknown,
): TurnProgress {
  const parsed = turnOutcomeSchema.safeParse(outcome);
  if (!parsed.success) {
    return progress;
  }
  const data = parsed.data;

  const merged: TurnProgress = {
    ...progress,
    completedGroups: [
      ...new Set([
        ...progress.completedGroups,
        ...(data.completedGroups ?? []),
      ]),
    ],
    cleanGroups: [
      ...new Set([...progress.cleanGroups, ...(data.cleanGroups ?? [])]),
    ],
    descriptionSections: [
      ...new Set([
        ...progress.descriptionSections,
        ...(data.descriptionSections ?? []),
      ]),
    ],
    // Not summed: the two channels describe the SAME turn, so adding them would
    // double-count a model that reported its findings both ways and trip the
    // supervisor's gate-hygiene check against a number that never existed.
    claimedFindings: Math.max(
      progress.claimedFindings,
      data.claimedFindings ?? 0,
    ),
    done: progress.done || data.done === true,
  };

  if (data.descriptionUpdated === true) {
    merged.descriptionUpdated = true;
  }

  if (data.plan) {
    const existing = progress.plan?.groups ?? [];
    const groups = [...existing];
    for (const group of data.plan.groups) {
      const found = groups.find((entry) => entry.id === group.id);
      if (found) {
        found.paths = [...new Set([...found.paths, ...group.paths])];
      } else {
        groups.push({ id: group.id, paths: [...group.paths] });
      }
    }
    const declined = [...(progress.plan?.declined ?? [])];
    for (const entry of data.plan.declined ?? []) {
      if (
        !declined.some((existingEntry) => existingEntry.path === entry.path)
      ) {
        declined.push(entry);
      }
    }
    merged.plan = { groups, declined };
  }

  if (data.resolved) {
    merged.resolved = {
      ...progress.resolved,
      ...(data.resolved.pullRequestId !== undefined
        ? { pullRequestId: data.resolved.pullRequestId }
        : {}),
      ...(data.resolved.headSha ? { headSha: data.resolved.headSha } : {}),
      ...(data.resolved.baseSha ? { baseSha: data.resolved.baseSha } : {}),
    };
  }

  return merged;
}
