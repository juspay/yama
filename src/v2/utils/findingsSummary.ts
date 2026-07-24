/**
 * Renders verdict findings as compact markdown so the CI layer can publish WHY
 * a review blocked, even when the agent posted no inline comments. The verdict
 * is derived from the structured findings (reviewDecision.ts); this is the
 * human-readable trail for that decision.
 */
import type { LocalReviewFinding } from "../types/index.js";

const SEVERITY_ICON: Record<LocalReviewFinding["severity"], string> = {
  CRITICAL: "🔒",
  MAJOR: "⚠️",
  MINOR: "💡",
  SUGGESTION: "💬",
};

const SEVERITY_ORDER: Record<LocalReviewFinding["severity"], number> = {
  CRITICAL: 0,
  MAJOR: 1,
  MINOR: 2,
  SUGGESTION: 3,
};

const MAX_DESCRIPTION_CHARS = 400;

/**
 * A finding with neither a file location nor a description gives a human
 * nothing to verify — flag it rather than let it read like a vetted issue.
 */
export function isEvidenceFreeFinding(finding: LocalReviewFinding): boolean {
  return !finding.filePath?.trim() && !finding.description?.trim();
}

export function formatFindingsMarkdown(
  issues: LocalReviewFinding[] | undefined,
): string {
  if (!issues || issues.length === 0) {
    return "";
  }

  const sorted = [...issues].sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  return sorted
    .map((finding) => {
      const icon = SEVERITY_ICON[finding.severity] ?? "•";
      const title = (finding.title || "(untitled finding)")
        .replace(/\s+/g, " ")
        .trim();
      const location = finding.filePath?.trim()
        ? ` — \`${finding.filePath}${typeof finding.line === "number" ? `:${finding.line}` : ""}\``
        : "";
      const lines = [`- ${icon} **${finding.severity}**: ${title}${location}`];

      const description = (finding.description || "")
        .replace(/\s+/g, " ")
        .trim();
      if (description) {
        const clipped =
          description.length > MAX_DESCRIPTION_CHARS
            ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`
            : description;
        lines.push(`  ${clipped}`);
      }
      if (isEvidenceFreeFinding(finding)) {
        lines.push(
          "  ⚠️ _No evidence provided (no file or description) — verify before acting on this finding._",
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}
