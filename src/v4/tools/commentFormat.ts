/**
 * Comment rendering.
 *
 * A finding that only names a problem leaves the work of fixing it to the
 * author, which is the difference between a reviewer and an alarm. Every comment
 * therefore carries three things: what is wrong, what it costs, and how to fix
 * it. The gate refuses CRITICAL and MAJOR findings without a fix, so by the time
 * anything reaches this renderer the material exists.
 */

import { renderImpactReport } from "../product/Capabilities.js";
import type {
  FindingSeverity,
  IdentifiedFinding,
  SummaryInput,
} from "../types/index.js";

const MARKER: Record<FindingSeverity, string> = {
  CRITICAL: "🔒 CRITICAL",
  MAJOR: "⚠️ MAJOR",
  MINOR: "💡 MINOR",
  SUGGESTION: "💬 SUGGESTION",
};

/**
 * Wrap a suggestion in a fenced block unless it already carries its own fence.
 *
 * Models emit both shapes, and double-fencing renders as literal backticks —
 * which makes the fix unreadable exactly where readability matters most.
 */
function renderFix(suggestion: string): string {
  const trimmed = suggestion.trim();
  if (trimmed.includes("```")) {
    return trimmed;
  }
  const looksLikeCode =
    /[;{}()=]|^\s*[-+]/m.test(trimmed) && trimmed.split("\n").length <= 40;
  return looksLikeCode ? `\`\`\`\n${trimmed}\n\`\`\`` : trimmed;
}

/** Render one inline comment. */
export function renderFindingComment(finding: IdentifiedFinding): string {
  const lines: string[] = [`${MARKER[finding.severity]}: ${finding.title}`, ""];

  if (
    finding.description &&
    finding.description.trim() !== finding.title.trim()
  ) {
    lines.push(finding.description.trim(), "");
  }

  if (finding.impact) {
    lines.push(`**Why it matters:** ${finding.impact.trim()}`, "");
  }

  if (finding.suggestion) {
    lines.push("**Fix:**", renderFix(finding.suggestion), "");
  }

  if (finding.ruleId) {
    lines.push(`_Rule: \`${finding.ruleId}\`_`);
  }
  if (finding.checkId) {
    lines.push(`_Reported by \`${finding.checkId}\`_`);
  }

  return lines.join("\n").trimEnd();
}

const SEVERITY_ORDER: FindingSeverity[] = [
  "CRITICAL",
  "MAJOR",
  "MINOR",
  "SUGGESTION",
];

/**
 * Render the summary comment.
 *
 * Composed from what actually happened rather than from a model's account of it:
 * posted findings, real check outcomes, real scope. A summary assembled from a
 * narrative can describe a review that did not occur.
 */
export function renderSummaryComment(input: SummaryInput): string {
  const lines: string[] = ["## Yama review", ""];

  const decision = input.verdict.advisory
    ? `${input.verdict.decision} _(advisory — verdict enforcement is off)_`
    : input.verdict.decision;
  lines.push(`**${decision}**`, "");

  for (const reason of input.verdict.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push("");

  if (input.posted.length > 0) {
    const counts = SEVERITY_ORDER.map((severity) => ({
      severity,
      count: input.posted.filter((finding) => finding.severity === severity)
        .length,
    })).filter((entry) => entry.count > 0);

    lines.push(
      `### Findings (${input.posted.length})`,
      "",
      counts
        .map((entry) => `${MARKER[entry.severity]} ${entry.count}`)
        .join(" · "),
      "",
    );

    for (const severity of SEVERITY_ORDER) {
      const group = input.posted.filter(
        (finding) => finding.severity === severity,
      );
      for (const finding of group) {
        const location = finding.filePath
          ? ` — \`${finding.filePath}${finding.line ? `:${finding.line}` : ""}\``
          : "";
        lines.push(`- **${severity}**: ${finding.title}${location}`);
      }
    }
    lines.push("");
  } else {
    lines.push("No findings.", "");
  }

  // An accepted finding with no comment is the failure mode this whole
  // architecture exists to prevent. If it happens anyway, say so on the PR
  // rather than letting the summary imply a clean review.
  if (input.unposted.length > 0) {
    lines.push(
      `> **${input.unposted.length} finding(s) could not be posted as inline comments.** ` +
        `They are listed here so they are not lost:`,
      "",
    );
    for (const finding of input.unposted) {
      const location = finding.filePath
        ? ` — \`${finding.filePath}${finding.line ? `:${finding.line}` : ""}\``
        : "";
      lines.push(`> - **${finding.severity}**: ${finding.title}${location}`);
    }
    lines.push("");
  }

  // The derived facts first, then the specialist's narrative if there is one:
  // what the map already knows is not a claim anyone has to weigh, and reading
  // it first is what makes the narrative above it interpretable.
  if (input.impactReport || input.impact) {
    lines.push("### Impact", "");
    if (input.impactReport) {
      lines.push(renderImpactReport(input.impactReport));
    }
    if (input.impact) {
      lines.push(input.impactReport ? "" : "", input.impact.trim());
    }
    lines.push("");
  }

  if (input.checks.length > 0) {
    lines.push("### Checks", "");
    if (input.checkFindingsPosted) {
      lines.push(
        `${input.checkFindingsPosted} finding(s) below come from these checks, not from ` +
          `the reviewer.`,
        "",
      );
    }
    lines.push("| Check | Result | Findings |");
    lines.push("| --- | --- | --- |");
    for (const check of input.checks) {
      const findings =
        check.dropped > 0
          ? `${check.findings} (+${check.dropped} not shown)`
          : String(check.findings);
      lines.push(`| \`${check.checkId}\` | ${check.status} | ${findings} |`);
    }
    lines.push("");
  }

  const scope: string[] = [`${input.filesReviewed} file(s) reviewed`];
  if (input.filesExcluded > 0) {
    scope.push(`${input.filesExcluded} excluded`);
  }
  if (input.truncated) {
    scope.push("**file limit reached — not every change was reviewed**");
  }
  lines.push(`_${scope.join(", ")}._`);

  if (input.degradedStages.length > 0) {
    lines.push(
      "",
      `_This review did not complete every stage (${input.degradedStages.join(", ")}), ` +
        `so it cannot vouch for the whole change._`,
    );
  }

  return lines.join("\n");
}
