/**
 * Findings summary formatter: the markdown trail that explains a blocking
 * verdict even when the agent posted no inline comments.
 */
import { describe, it, expect } from "@jest/globals";
import {
  formatFindingsMarkdown,
  isEvidenceFreeFinding,
} from "../../../src/v2/utils/findingsSummary.js";
import { LocalReviewFinding } from "../../../src/v2/types/index.js";

const finding = (
  overrides: Partial<LocalReviewFinding> = {},
): LocalReviewFinding => ({
  id: "f1",
  severity: "MAJOR",
  category: "correctness",
  title: "Something broke",
  description: "A description of the problem.",
  ...overrides,
});

describe("formatFindingsMarkdown", () => {
  it("returns empty string for missing or empty findings", () => {
    expect(formatFindingsMarkdown(undefined)).toBe("");
    expect(formatFindingsMarkdown([])).toBe("");
  });

  it("orders findings by severity and renders location + description", () => {
    const md = formatFindingsMarkdown([
      finding({ id: "minor", severity: "MINOR", title: "Nit" }),
      finding({
        id: "crit",
        severity: "CRITICAL",
        title: "Injection",
        filePath: "src/a.ts",
        line: 42,
      }),
    ]);
    const critIndex = md.indexOf("CRITICAL");
    const minorIndex = md.indexOf("MINOR");
    expect(critIndex).toBeGreaterThanOrEqual(0);
    expect(critIndex).toBeLessThan(minorIndex);
    expect(md).toContain("`src/a.ts:42`");
    expect(md).toContain("A description of the problem.");
  });

  it("flags evidence-free findings instead of letting them read as vetted", () => {
    const md = formatFindingsMarkdown([
      finding({ description: "", filePath: undefined, title: "Phantom" }),
    ]);
    expect(md).toContain("No evidence provided");
  });

  it("does not flag findings that carry a file or a description", () => {
    const withFileOnly = finding({ description: "", filePath: "src/a.ts" });
    const withDescOnly = finding({ filePath: undefined });
    expect(isEvidenceFreeFinding(withFileOnly)).toBe(false);
    expect(isEvidenceFreeFinding(withDescOnly)).toBe(false);
    expect(formatFindingsMarkdown([withFileOnly, withDescOnly])).not.toContain(
      "No evidence provided",
    );
  });

  it("clips very long descriptions and collapses whitespace", () => {
    const md = formatFindingsMarkdown([
      finding({ description: `line1\nline2   spaced ${"x".repeat(600)}` }),
    ]);
    expect(md).toContain("line1 line2 spaced");
    expect(md).toContain("…");
    expect(md.length).toBeLessThan(700);
  });
});
