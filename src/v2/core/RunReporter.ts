/**
 * RunReporter — writes the per-run review report artifact.
 *
 * Everything valuable a run produces (bootstrap standards, explore
 * investigations, gate batches with critic outcomes, finalization, the
 * reconciled verdict) used to live only in stdout and evaporate with the CI
 * log. This collects those events and renders one markdown report (plus the
 * raw JSON) per session, so CI can archive the review's reasoning next to its
 * state file. Local files only — a log, not a PR side effect — and strictly
 * best-effort: reporting failures warn and never affect the review.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ReviewResult,
  RunReportConfig,
  RunReportEvent,
  RunReportFindingRef,
  RunReportMeta,
  RunReportOutcome,
  RunReportTimelineEntry,
} from "../types/index.js";

const DEFAULT_REPORT_PATH = ".yama/reports";

/**
 * Flatten free text (model-authored titles, exception messages, explore
 * prose) for safe interpolation into one markdown table cell or bullet:
 * newlines collapse to spaces, and backslashes are escaped BEFORE pipes so a
 * pre-existing "\|" in the input cannot re-arm the pipe and break the row
 * structure — the error path is exactly where the report matters most.
 */
const inline = (value: string | undefined): string =>
  (value || "")
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();

export class RunReporter {
  private readonly timeline: RunReportTimelineEntry[] = [];

  constructor(private readonly meta: RunReportMeta) {}

  record(event: RunReportEvent): void {
    this.timeline.push({ ...event, at: new Date().toISOString() });
  }

  /** Render + write the report. Returns the markdown path, or null. */
  async write(
    config: RunReportConfig | undefined,
    result?: ReviewResult,
    error?: string,
  ): Promise<string | null> {
    if (config?.enabled === false) {
      return null;
    }
    try {
      const dir = config?.path || DEFAULT_REPORT_PATH;
      await mkdir(dir, { recursive: true });
      const outcome = this.buildOutcome(result, error);
      const base = join(dir, this.meta.sessionId);
      await writeFile(`${base}.md`, this.renderMarkdown(outcome), "utf8");
      await writeFile(
        `${base}.json`,
        JSON.stringify(
          { meta: this.meta, timeline: this.timeline, outcome },
          null,
          2,
        ),
        "utf8",
      );
      console.log(`   📄 Run report written: ${base}.md`);
      return `${base}.md`;
    } catch (writeError) {
      console.warn(
        `   ⚠️  Could not write run report: ${(writeError as Error).message}`,
      );
      return null;
    }
  }

  private buildOutcome(
    result?: ReviewResult,
    error?: string,
  ): RunReportOutcome {
    if (!result) {
      return { error };
    }
    const toRef = (issue: {
      severity: string;
      title: string;
      filePath?: string;
      line?: number;
    }): RunReportFindingRef => ({
      severity: issue.severity,
      title: issue.title,
      filePath: issue.filePath,
      line: issue.line,
    });
    return {
      decision: result.decision,
      completion: result.completion,
      durationSeconds: result.duration,
      issues: (result.issues || []).map(toRef),
      ungatedIssues: (result.ungatedIssues || []).map(toRef),
      summary: result.summary,
      tokenUsage: result.tokenUsage,
      costEstimate: result.costEstimate,
      error,
    };
  }

  private renderMarkdown(outcome: RunReportOutcome): string {
    const meta = this.meta;
    const lines: string[] = [];
    const repo = [meta.workspace, meta.repository].filter(Boolean).join("/");
    const title = meta.pullRequestId
      ? `${repo} PR #${meta.pullRequestId}`
      : repo || meta.sessionId;
    lines.push(`# Yama Review Report — ${title}`, "");
    lines.push(`| | |`, `| --- | --- |`);
    lines.push(`| Session | \`${meta.sessionId}\` |`);
    lines.push(`| Started | ${meta.startedAt} |`);
    if (meta.aiProvider || meta.aiModel) {
      lines.push(
        `| Model | ${meta.aiProvider || ""} / ${meta.aiModel || ""} |`,
      );
    }
    lines.push(`| Mode | ${meta.dryRun ? "🟡 DRY-RUN" : "🔴 LIVE"} |`);
    if (outcome.decision) {
      lines.push(`| Decision | **${outcome.decision}** |`);
    }
    if (outcome.completion) {
      lines.push(
        `| Completion | ${outcome.completion.stopReason}` +
          `${outcome.completion.stepsUsed ? ` (${outcome.completion.stepsUsed} steps)` : ""}` +
          `${outcome.completion.partial ? " — **PARTIAL**" : ""} |`,
      );
    }
    if (outcome.durationSeconds !== undefined) {
      lines.push(`| Duration | ${outcome.durationSeconds}s |`);
    }
    if (outcome.tokenUsage) {
      lines.push(
        `| Tokens | ${outcome.tokenUsage.total} (in ${outcome.tokenUsage.input} / out ${outcome.tokenUsage.output}) |`,
      );
    }
    if (outcome.error) {
      lines.push(`| Error | ${inline(outcome.error)} |`);
    }
    lines.push("");

    const findingLine = (issue: RunReportFindingRef): string => {
      const location = issue.filePath
        ? ` — \`${inline(issue.filePath)}${issue.line ? `:${issue.line}` : ""}\``
        : "";
      return `- **${issue.severity}**: ${inline(issue.title)}${location}`;
    };

    lines.push(`## Verified findings (${outcome.issues?.length ?? 0})`, "");
    if (outcome.issues?.length) {
      for (const issue of outcome.issues) {
        lines.push(findingLine(issue));
      }
    } else {
      lines.push("_None accepted by the review gate._");
    }
    lines.push("");

    if (outcome.ungatedIssues?.length) {
      lines.push(
        `## Quarantined claims (${outcome.ungatedIssues.length})`,
        "",
        "_Listed in the model verdict but never verified by the_ " +
          "`submit_review` _gate — excluded from the decision, comments, and state._",
        "",
      );
      for (const issue of outcome.ungatedIssues) {
        lines.push(findingLine(issue));
      }
      lines.push("");
    }

    lines.push(`## Timeline`, "");
    if (this.timeline.length === 0) {
      lines.push("_No events recorded._");
    }
    for (const entry of this.timeline) {
      const at = entry.at.slice(11, 19);
      switch (entry.kind) {
        case "bootstrap":
          lines.push(
            `- \`${at}\` 🧭 Bootstrapped repo standards (${entry.chars} chars)`,
          );
          break;
        case "explore":
          lines.push(
            `- \`${at}\` 🔎 Explore${entry.cached ? " (cached)" : ""}: ${inline(entry.task)}`,
          );
          if (entry.summary) {
            lines.push(`  - ${inline(entry.summary)}`);
          }
          break;
        case "submit":
          lines.push(
            `- \`${at}\` 🛡️ submit_review (${entry.mode}): ` +
              `${entry.accepted.length} accepted, ${entry.rejected.length} rejected`,
          );
          for (const finding of entry.accepted) {
            lines.push(`  - ✅ ${finding.severity}: ${inline(finding.title)}`);
          }
          for (const finding of entry.rejected) {
            lines.push(
              `  - ❌ ${finding.severity}: ${inline(finding.title)} — ${inline(finding.reason)}`,
            );
          }
          break;
        case "finalization":
          lines.push(
            `- \`${at}\` 📮 Finalization: ${entry.outcome}` +
              `${entry.detail ? ` (${inline(entry.detail)})` : ""}`,
          );
          break;
        case "note":
          lines.push(`- \`${at}\` 📝 ${inline(entry.text)}`);
          break;
      }
    }
    lines.push("");

    if (outcome.summary) {
      lines.push(`## Review summary`, "", outcome.summary, "");
    }

    return lines.join("\n");
  }
}
