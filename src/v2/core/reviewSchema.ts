/**
 * Zod schemas for the review verdict, passed to NeuroLink's `generate({ schema })`.
 *
 * NeuroLink owns structured output end-to-end: providers that support
 * tools+schema enforce the shape at the wire (AI SDK `experimental_output` /
 * OpenAI-style `response_format`), it falls back to an unstructured call when a
 * backend rejects that, and it extracts/repairs/validates JSON out of prose or
 * truncated text into `result.structuredData` (`coerceJsonToSchema`). Yama
 * therefore does NO JSON parsing of its own — the parser only normalizes the
 * already-structured verdict and applies the decision policy.
 */

import { z } from "zod";

const severitySchema = z.enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]);

const findingSchema = z.object({
  id: z.string().optional(),
  severity: severitySchema,
  category: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  filePath: z.string().optional(),
  // Models routinely emit `line: null` for file-level findings.
  line: z.number().nullish(),
  suggestion: z.string().optional(),
  /** Rule key used by projectStandards.severityOverrides remapping. */
  rule: z.string().optional(),
});

/** PR-mode final verdict — the `<output>` contract in ReviewSystemPrompt. */
export const prReviewVerdictSchema = z.object({
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "BLOCKED"]),
  summary: z.string(),
  issues: z.array(findingSchema),
  /**
   * Ids (from the <previous-review> block) of previously-reported findings
   * this run VERIFIED as fixed. Bookkeeping stays deterministic in Yama;
   * the judgement is the agent's.
   */
  resolvedIssueIds: z.array(z.string()).optional(),
});

/** Local-mode verdict — the output schema in PromptBuilder's local prompt. */
export const localReviewVerdictSchema = prReviewVerdictSchema.extend({
  enhancements: z.array(findingSchema),
});

/**
 * True when a structuredData value is actually verdict-shaped. NeuroLink's
 * text coercion recovers ANY JSON object it finds in the final message, so a
 * present-but-unrelated object (a tool-args echo, an empty {}) must be treated
 * as "no verdict" — both by the follow-up trigger and by the parser — or the
 * two disagree and the follow-up never fires.
 */
export function isVerdictShaped(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.decision === "string" || Array.isArray(v.issues);
}
