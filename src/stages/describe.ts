/**
 * Description enhancement (TASKS:Y7.3) — adding to a pull request's description without
 * ever rewriting its author.
 *
 * A description belongs to whoever opened the pull request. So Yama writes into a block of
 * its own, fenced by HTML markers, and touches nothing outside it:
 *
 *     <!-- yama:description:start -->  …everything Yama wrote…  <!-- yama:description:end -->
 *
 * On the first run the block is APPENDED. On every run after that it is REPLACED IN PLACE,
 * which means an author who moved it, or wrote three paragraphs above and below it, keeps
 * all of that exactly as it was. A description Yama cannot read is a description Yama does
 * not touch: overwriting an author because a tool result was unfamiliar is the one failure
 * this file exists to prevent.
 *
 * Which sections go in the block is config (`delivery.describeSections`), never the
 * agent's choice — the same ruling the rest of Delivery is built on.
 */
import type { DescribeSection, Finding, Verdict } from "../types/index.js";

/** Opens Yama's block. Everything before it is the author's. */
export const DESCRIPTION_START = "<!-- yama:description:start -->";

/** Closes Yama's block. Everything after it is the author's. */
export const DESCRIPTION_END = "<!-- yama:description:end -->";

/** Findings named in the description before the list collapses into a count. */
const MAX_LISTED = 10;

const sectionLines = (
  section: DescribeSection,
  input: {
    summary: string;
    riskAreas: readonly string[];
    findings: readonly Finding[];
    verdict: Verdict;
    checklistComplete: boolean;
  },
): string[] => {
  switch (section) {
    case "summary":
      return ["### What this change does", "", input.summary];
    case "risk":
      return [
        "### Where the risk is",
        "",
        ...(input.riskAreas.length > 0
          ? input.riskAreas.map((area) => `- ${area}`)
          : ["- Nothing this review considers risky."]),
      ];
    case "findings":
      return [
        `### Review findings (${input.findings.length})`,
        "",
        ...(input.findings.length > 0
          ? [
              ...input.findings
                .slice(0, MAX_LISTED)
                .map(
                  (finding) =>
                    `- **${finding.severity}** \`${finding.file}:${finding.line}\` — ${finding.summary}`,
                ),
              ...(input.findings.length > MAX_LISTED
                ? [
                    `- …and ${input.findings.length - MAX_LISTED} more, in the review comments.`,
                  ]
                : []),
            ]
          : ["- None."]),
      ];
    default:
      return [
        "### Review coverage",
        "",
        `- Verdict: **${input.verdict.decision.toUpperCase()}**`,
        ...input.verdict.reasons.map((reason) => `- ${reason}`),
        ...(input.checklistComplete
          ? []
          : [
              "- **This review is incomplete** — some checklist items were not finished.",
            ]),
      ];
  }
};

/**
 * Yama's block, rendered. Always fenced, always in the configured order, and always the
 * same shape — a block whose layout drifts between runs reads as a rewrite in the diff.
 */
export const renderDescriptionBlock = (input: {
  sections: readonly DescribeSection[];
  summary: string;
  riskAreas: readonly string[];
  findings: readonly Finding[];
  verdict: Verdict;
  checklistComplete: boolean;
}): string =>
  [
    DESCRIPTION_START,
    "",
    "<!-- Written by Yama. Edit outside this block; anything inside it is replaced on the next review. -->",
    "",
    ...input.sections.flatMap((section) => [
      ...sectionLines(section, input),
      "",
    ]),
    DESCRIPTION_END,
  ]
    .join("\n")
    .trimEnd();

/** True when a description already carries Yama's block, correctly fenced. */
export const hasDescriptionBlock = (description: string): boolean => {
  const start = description.indexOf(DESCRIPTION_START);
  return start >= 0 && description.indexOf(DESCRIPTION_END, start) > start;
};

/**
 * The whole description as it must be set: the author's text untouched, with Yama's block
 * replaced where it already is, or appended where it is not.
 *
 * Returns the current description UNCHANGED when the new block is identical to the one
 * already there — a no-op update is still a notification to every watcher of the pull
 * request, and a review that ran twice should not look like two edits.
 */
export const mergeDescription = (
  current: string,
  block: string,
): { description: string; changed: boolean } => {
  const start = current.indexOf(DESCRIPTION_START);
  const end = start < 0 ? -1 : current.indexOf(DESCRIPTION_END, start);
  if (start < 0 || end < 0) {
    const author = current.trimEnd();
    return {
      description: author.length > 0 ? `${author}\n\n${block}` : block,
      changed: true,
    };
  }
  const before = current.slice(0, start);
  const after = current.slice(end + DESCRIPTION_END.length);
  const description = `${before}${block}${after}`;
  return { description, changed: description !== current };
};
