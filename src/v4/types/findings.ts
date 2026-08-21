/**
 * Finding types — what the agent proposes, what the gate accepts, and what
 * actually reached the pull request.
 *
 * The distinction between "accepted" and "posted" is load-bearing. v3 counted a
 * tool CALL as a comment, which is how runs reported findings that never
 * appeared on the PR. Here, `postedCommentId` is only ever set from a tool
 * RESULT.
 */

import type { FindingSeverity } from "./config.js";

/** Where a finding came from. Drives whether it needs a confidence judgement. */
export type FindingSource = "agent" | "check" | "policy";

/** A finding as proposed, before the gate has ruled on it. */
export type CandidateFinding = {
  severity: FindingSeverity;
  title: string;
  description?: string;
  filePath?: string;
  line?: number | null;
  /** The concrete fix. Required for CRITICAL and MAJOR — the gate enforces it. */
  suggestion?: string;
  /** What breaks, and for whom. */
  impact?: string;
  /** file:line citations or quoted code backing the claim. */
  evidence?: string;
  category?: string;
  /** Rule this finding enforces, if any. Rendered as a citation. */
  ruleId?: string;
  source: FindingSource;
  /** Check that produced it, when source is "check". */
  checkId?: string;
};

/** A candidate with its content-derived identity. */
export type IdentifiedFinding = CandidateFinding & {
  /** Stable hash of severity + path + line + title. Survives rephrasing poorly
   *  on purpose: a materially reworded finding IS a different finding. */
  id: string;
};

/** Why the gate refused a finding. */
export type RejectionReason =
  | "duplicate-in-batch"
  | "already-reported"
  | "already-accepted"
  | "suppressed"
  | "file-not-in-change"
  | "line-not-changed"
  | "missing-fix"
  | "below-confidence"
  | "already-flagged-by-check";

export type RejectedFinding = {
  finding: IdentifiedFinding;
  reason: RejectionReason;
  /** Human-readable explanation, and what the agent could do about it. */
  detail: string;
};

export type GateResult = {
  accepted: IdentifiedFinding[];
  rejected: RejectedFinding[];
  /** What the agent should do next, phrased for the agent. */
  instruction: string;
};

/** A finding that reached the pull request, with proof it did. */
export type PostedFinding = IdentifiedFinding & {
  /** Comment id from the posting tool's RESULT. Never inferred from a call. */
  postedCommentId: string;
  postedAt: string;
};

/** The run's accounting of every finding's fate. */
export type FindingLedgerSnapshot = {
  submitted: number;
  accepted: IdentifiedFinding[];
  rejected: RejectedFinding[];
  posted: PostedFinding[];
  /** Accepted but never confirmed posted — the gap the post stage must close. */
  unposted: IdentifiedFinding[];
};

// ── Comment markers ──────────────────────────────────────────────────────────

/** Marker kinds Yama writes into comment bodies for idempotent re-runs. */
export type MarkerKind = "finding" | "summary" | "owners";

export type ParsedMarker = {
  kind: MarkerKind;
  /** Finding id, for `finding` markers. */
  id?: string;
};

/** A comment as read back from the pull request. */
export type ExistingComment = {
  id: string;
  body: string;
  /** Author handle. Only bot-authored comments are trusted as markers. */
  author?: string;
  filePath?: string;
  line?: number | null;
};

// ── Verdict ──────────────────────────────────────────────────────────────────

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED";

export type VerdictInput = {
  posted: PostedFinding[];
  /**
   * Everything the gate accepted, posted or not.
   *
   * Severity counting works from THIS set, not from `posted`: a CRITICAL
   * finding whose comment failed to post must still block, and a dry run —
   * where nothing ever posts — must still be able to say BLOCKED. Counting
   * only posted findings made `--dry-run` report APPROVED on critically
   * broken changes and let a posting failure silently clear a blocker.
   */
  accepted: Array<{ severity: FindingSeverity; id: string; title: string }>;
  /** Guard violations and unmet ownership, which block independently. */
  blockingRuleIds: string[];
  failedBlockingCheckIds: string[];
  unapprovedOwnershipRuleIds: string[];
  /** True when any stage ended degraded. A partial run may never approve. */
  partial: boolean;
};

export type Verdict = {
  decision: ReviewDecision;
  /** Every reason that contributed, for the summary comment. */
  reasons: string[];
  /** True when the project turned the verdict off — decision is advisory. */
  advisory: boolean;
};

export type MarkerScan = {
  /** Finding ids already posted, from bot-authored comments only. */
  reportedFindingIds: Set<string>;
  /** Comment id → finding id, for resolving threads on re-runs. */
  commentByFinding: Map<string, string>;
  /** The bot's summary comment, when one exists. Updated rather than duplicated. */
  summaryCommentId?: string;
  /** The bot's ownership comment, when one exists. */
  ownersCommentId?: string;
  /** Markers seen in comments Yama did not author — reported, never trusted. */
  untrustedMarkers: number;
};
