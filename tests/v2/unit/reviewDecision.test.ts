/**
 * Unit tests for the code-derived review decision (security M2 safety layer).
 */

import { describe, it, expect } from "@jest/globals";
import {
  deriveDecision,
  DEFAULT_MAJOR_BLOCK_THRESHOLD,
} from "../../../src/v2/core/reviewDecision.js";
import { IssuesBySeverity } from "../../../src/v2/types/index.js";

const issues = (over: Partial<IssuesBySeverity> = {}): IssuesBySeverity => ({
  critical: 0,
  major: 0,
  minor: 0,
  suggestions: 0,
  ...over,
});

describe("deriveDecision", () => {
  it("blocks an AI approval when a CRITICAL finding exists (M2)", () => {
    expect(deriveDecision("APPROVED", issues({ critical: 1 }))).toBe("BLOCKED");
  });

  it("blocks regardless of the AI decision when CRITICAL exists", () => {
    expect(deriveDecision("CHANGES_REQUESTED", issues({ critical: 2 }))).toBe(
      "BLOCKED",
    );
    expect(deriveDecision("BLOCKED", issues({ critical: 1 }))).toBe("BLOCKED");
  });

  it("blocks an approval when MAJOR findings hit the threshold (README: 3+ MAJOR blocks)", () => {
    expect(
      deriveDecision(
        "APPROVED",
        issues({ major: DEFAULT_MAJOR_BLOCK_THRESHOLD }),
      ),
    ).toBe("BLOCKED");
  });

  it("leaves an approval intact below the MAJOR threshold and with no criticals", () => {
    expect(
      deriveDecision(
        "APPROVED",
        issues({ major: DEFAULT_MAJOR_BLOCK_THRESHOLD - 1, minor: 5 }),
      ),
    ).toBe("APPROVED");
  });

  it("blocks even a non-approval verdict when MAJORs hit the threshold", () => {
    expect(deriveDecision("CHANGES_REQUESTED", issues({ major: 5 }))).toBe(
      "BLOCKED",
    );
  });

  it("honours a custom major-block threshold", () => {
    expect(
      deriveDecision("APPROVED", issues({ major: 2 }), {
        majorBlockThreshold: 2,
      }),
    ).toBe("BLOCKED");
  });

  it("passes a clean approval through unchanged", () => {
    expect(deriveDecision("APPROVED", issues())).toBe("APPROVED");
  });
});
