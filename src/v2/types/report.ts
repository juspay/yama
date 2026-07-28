/**
 * Run-report types — the structured record of one review run, from which the
 * markdown/JSON report artifact is rendered.
 */

import { ReviewCompletion } from "./review.js";

export type RunReportMeta = {
  sessionId: string;
  workspace?: string;
  repository?: string;
  pullRequestId?: number;
  provider?: string;
  aiProvider?: string;
  aiModel?: string;
  dryRun: boolean;
  startedAt: string;
};

export type RunReportFindingRef = {
  severity: string;
  title: string;
  filePath?: string;
  line?: number | null;
};

export type RunReportEvent =
  | { kind: "bootstrap"; chars: number }
  | { kind: "explore"; task: string; cached: boolean; summary: string }
  | {
      kind: "submit";
      mode: string;
      accepted: RunReportFindingRef[];
      rejected: Array<RunReportFindingRef & { reason: string }>;
    }
  | {
      kind: "finalization";
      outcome: "verdict" | "no-verdict" | "error";
      detail?: string;
    }
  | { kind: "note"; text: string };

export type RunReportTimelineEntry = RunReportEvent & { at: string };

export type RunReportOutcome = {
  decision?: string;
  completion?: ReviewCompletion;
  durationSeconds?: number;
  issues?: RunReportFindingRef[];
  ungatedIssues?: RunReportFindingRef[];
  summary?: string;
  tokenUsage?: { input: number; output: number; total: number };
  costEstimate?: number;
  error?: string;
};
