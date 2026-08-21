/**
 * `parse: agent` — the escape hatch for a tool no named parser understands.
 *
 * Most checks are parsed deterministically: SARIF covers most linters and
 * scanners, and the named parsers cover the rest. This exists for the script
 * every team has that prints its own format, where the alternative is writing a
 * regex against output that changes shape whenever someone edits the script.
 *
 * Two properties keep it from becoming a second reviewer:
 *
 *  1. **It is schema-bound.** The model returns findings against a schema on a
 *     cheap chain, and anything that does not validate is reported as a failed
 *     extraction rather than quietly dropped. v3's equivalent scraped JSON out
 *     of prose and treated a parse failure as "no findings", so a check that
 *     failed and a check that passed produced the same silence.
 *  2. **It reads output, never code.** The prompt says so and the tool surface
 *     enforces it — the call is made with tools off, so the extractor has no
 *     way to look at the repository and invent a finding of its own. Findings
 *     it returns are marked `source: "check"`, which means the inline judge
 *     skips them: a compiler error is not a probabilistic claim, and neither is
 *     a line the tool itself printed.
 */

import { z } from "zod";
import type {
  CheckConfig,
  CheckRunResult,
  ExtractionOptions,
  FindingSeverity,
} from "../types/index.js";
import { generateStructured } from "../core/StructuredCall.js";

/**
 * Deliberately flat and permissive.
 *
 * No string patterns, no minimums, no long enums: complex schemas are rejected
 * outright by some providers and silently degrade to text coercion on others,
 * and every field here is something the tool's own output either states or does
 * not. A missing line number is normal, not an error.
 */
export const extractedFindingsSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]),
      message: z.string(),
      filePath: z.string().optional(),
      line: z.number().nullish(),
      ruleId: z.string().optional(),
    }),
  ),
});

/** How much raw output one extraction pass reads. */
const MAX_OUTPUT_CHARS = 24_000;

/**
 * Turn one check's raw output into findings.
 *
 * Returns the result unchanged when there is nothing to extract, so callers can
 * run this over every result without branching.
 */
export async function extractFindings(
  result: CheckRunResult,
  check: CheckConfig,
  options: ExtractionOptions,
): Promise<{ result: CheckRunResult; warnings: string[] }> {
  const output = (result.output ?? "").trim();
  if (output.length === 0) {
    return { result, warnings: [] };
  }

  const truncated = output.length > MAX_OUTPUT_CHARS;
  const body = truncated ? output.slice(0, MAX_OUTPUT_CHARS) : output;

  const call = await generateStructured({
    host: options.host,
    chain: options.chain,
    context: options.context,
    systemPrompt: options.instruction,
    message: [
      `Command: ${check.run ?? check.id}`,
      check.hint ? `Hint from the project: ${check.hint}` : "",
      "",
      "Output:",
      body,
      truncated ? "\n[output truncated — report only what is above]" : "",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: extractedFindingsSchema,
    operation: `extract-${check.id}`,
  });

  if (!call.data) {
    // A check that ran and could not be read is NOT a check that found
    // nothing. Recorded as failed so the stage predicate names it, because
    // "no findings" from a broken extraction reads exactly like a pass.
    return {
      result: {
        ...result,
        status: "failed",
        reason:
          `its output could not be parsed into findings` +
          (call.warnings.length > 0 ? `: ${call.warnings[0]}` : ""),
      },
      warnings: call.warnings,
    };
  }

  const findings = call.data.findings.map((finding) => ({
    checkId: check.id,
    severity: severityFor(finding.severity, check),
    message: finding.message,
    ...(finding.filePath ? { filePath: finding.filePath } : {}),
    ...(finding.line !== undefined && finding.line !== null
      ? { line: finding.line }
      : {}),
    ...(finding.ruleId ? { ruleId: finding.ruleId } : {}),
  }));

  return {
    result: { ...result, findings },
    warnings: [
      ...call.warnings,
      ...(truncated
        ? [
            `Check "${check.id}" produced ${output.length} characters of output; only the ` +
              `first ${MAX_OUTPUT_CHARS} were read for findings.`,
          ]
        : []),
    ],
  };
}

/**
 * Apply the check's own severity mapping to what the extractor reported.
 *
 * The project's `severity:` block wins where it names a level, so a team can
 * downgrade a noisy script without touching a prompt.
 */
function severityFor(
  reported: FindingSeverity,
  check: CheckConfig,
): FindingSeverity {
  const mapping = check.severity as Record<string, string> | undefined;
  const mapped = mapping?.[reported.toLowerCase()] ?? mapping?.[reported];
  return typeof mapped === "string" &&
    ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"].includes(mapped)
    ? (mapped as FindingSeverity)
    : reported;
}
