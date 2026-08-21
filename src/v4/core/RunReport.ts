/**
 * The run report — what actually happened, in the form a person reads.
 *
 * Written because the production traces that motivated v4 were unreadable: runs
 * ended with no comments and nothing in the logs said whether the agent found
 * nothing, found things it could not post, or never reached the gate. Every one
 * of those has a different fix and they looked identical.
 *
 * So the report states each stage's outcome, and it names specifics — which
 * finding is unposted, which check did not run — never a count.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  PipelineResult,
  PostedFinding,
  StageOutcome,
} from "../types/index.js";
import { renderScorecard } from "../judge/scorecard.js";

const MARK: Record<StageOutcome["status"], string> = {
  passed: "✓",
  degraded: "!",
  skipped: "-",
  failed: "✗",
};

export function renderRunReport(
  result: PipelineResult,
  warnings: string[] = [],
  posted: PostedFinding[] = [],
): string {
  const lines: string[] = ["Stages"];

  for (const outcome of result.stages.outcomes) {
    lines.push(
      `  ${MARK[outcome.status]} ${outcome.stage.padEnd(8)} ${outcome.status}` +
        (outcome.attempts > 1 ? `  (${outcome.attempts} attempts)` : ""),
    );
    for (const item of outcome.missing ?? []) {
      lines.push(`      missing: ${item}`);
    }
  }

  const { verdict } = result;
  lines.push(
    "",
    `Findings   ${posted.length} posted` +
      (result.review.turns > 0 ? `, over ${result.review.turns} turn(s)` : ""),
  );

  for (const finding of posted) {
    lines.push(
      `  ${finding.severity.padEnd(10)} ${finding.filePath ?? "(repository)"}` +
        `${finding.line ? `:${finding.line}` : ""} — ${finding.title}`,
    );
  }

  if (result.checks.length > 0) {
    lines.push("", "Checks");
    for (const check of result.checks) {
      lines.push(
        `  ${check.status === "passed" ? "✓" : check.status === "skipped" ? "-" : "✗"} ` +
          `${check.checkId.padEnd(10)} ${check.status}` +
          (check.reason ? ` — ${check.reason}` : "") +
          (check.findings.length > 0
            ? ` (${check.findings.length} findings)`
            : "") +
          (check.droppedFindings > 0
            ? `, ${check.droppedFindings} dropped`
            : ""),
      );
    }
  }

  if (result.review.interventions.length > 0) {
    lines.push("", "Supervisor");
    for (const intervention of result.review.interventions) {
      lines.push(`  · ${intervention}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  lines.push(
    "",
    `Verdict    ${verdict.decision}${verdict.advisory ? "  (advisory — verdict is off)" : ""}` +
      `${result.stages.partial ? "  (partial run)" : ""}`,
    ...verdict.reasons.map((reason) => `           ${reason}`),
    `Summary    ${result.summaryPosted ? "posted" : "NOT posted"}` +
      `   ·   Status ${result.statusRecorded ? "recorded" : "NOT recorded"}` +
      `   ·   Turn loop ended: ${result.review.turnLoopEnd}`,
  );

  if (result.metrics) {
    lines.push("", renderScorecard(result.metrics));
  }

  return lines.join("\n");
}

/** Findings that reached the pull request, counted by severity. */
export function countBySeverity(
  posted: PostedFinding[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of posted) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Persist the report next to the run.
 *
 * Best effort: a run whose report cannot be written still reviewed the pull
 * request, and the report is already on stdout. The failure is returned rather
 * than thrown so the caller can mention it without losing the run.
 */
export async function writeRunReport(
  projectRoot: string,
  runId: string,
  result: PipelineResult,
): Promise<string | undefined> {
  const directory = join(projectRoot, ".yama", "reports");
  try {
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${runId}.json`);
    await writeFile(
      path,
      `${JSON.stringify(
        {
          runId,
          verdict: result.verdict,
          stages: result.stages,
          review: result.review,
          checks: result.checks.map((check) => ({
            checkId: check.checkId,
            status: check.status,
            reason: check.reason,
            findings: check.findings.length,
            dropped: check.droppedFindings,
          })),
          summaryPosted: result.summaryPosted,
          statusRecorded: result.statusRecorded,
          // Consumed by CI: the action reads these to set its step outputs, so
          // a workflow can gate on a decision without parsing prose.
          decision: result.verdict.decision,
          partial: result.stages.outcomes.some(
            (stage) => stage.status === "degraded" || stage.status === "failed",
          ),
          posted: (result.posted ?? []).length,
          bySeverity: countBySeverity(result.posted ?? []),
          metrics: result.metrics,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    return path;
  } catch {
    // The report is already on stdout; losing the file copy is not worth
    // failing a completed review over.
    return undefined;
  }
}
