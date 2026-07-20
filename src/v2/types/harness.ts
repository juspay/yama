/**
 * Harness types — the reliability gate between the agent's candidate findings
 * and anything that lands on a pull request.
 */

export type VerificationMode = "off" | "basic" | "strict";

export type SubmittedFinding = {
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";
  category?: string;
  title: string;
  description?: string;
  filePath?: string;
  line?: number | null;
  suggestion?: string;
  ruleId?: string;
  /** file:line citations / snippets backing the claim. */
  evidence?: string;
};

export type CriticVerdictValue = "confirmed" | "refuted" | "uncertain";

export type CriticVerdict = {
  id: string;
  verdict: CriticVerdictValue;
  reason: string;
};

export type SubmitReviewAccepted = SubmittedFinding & { id: string };

export type SubmitReviewRejected = {
  finding: SubmittedFinding & { id: string };
  reason: string;
};

export type SubmitReviewResult = {
  accepted: SubmitReviewAccepted[];
  rejected: SubmitReviewRejected[];
  /** What the agent should do next, stated explicitly. */
  instruction: string;
};
