/**
 * Review-run types.
 *
 * Every exported type in the codebase lives under `src/v4/types/` — a feature
 * module never exports one. The types barrel re-exports everything, so a type
 * declared next to its logic is unreachable through the sanctioned import path
 * and its name can collide silently with another module's.
 */

import type { IdentifiedFinding } from "./findings.js";

/**
 * A group of files the agent intends to review together.
 *
 * The agent decides the grouping. Yama only tracks whether each group has been
 * reviewed and gated, which is what the review stage's exit predicate checks.
 */
export type ReviewGroup = {
  id: string;
  paths: string[];
  /** The agent produced findings for this group, or declared it clean. */
  reviewed: boolean;
  /** The gate was called at least once for this group. */
  gated: boolean;
  /** Present when the agent declared the group clean rather than finding issues. */
  declaredClean?: boolean;
};

/** The agent's plan for the review, produced during orientation. */
export type ReviewPlan = {
  groups: ReviewGroup[];
  /** Files the agent declined to review, with its reason. */
  declined: Array<{ path: string; reason: string }>;
};

/** What one agent turn reported back. */
export type TurnReport = {
  /** Groups the agent finished this turn. */
  completedGroups?: string[];
  /** Groups it called the gate for this turn. */
  gatedGroups?: string[];
  /** A plan, when the turn produced one. */
  plan?: ReviewPlan;
  /** Findings described in prose — feeds gate-discipline checking. */
  claimedFindings?: number;
  /** Identifiers the resolve stage established. */
  resolved?: {
    pullRequestId?: number;
    headSha?: string;
    baseSha?: string;
  };
  descriptionUpdated?: boolean;
  descriptionSections?: string[];
  /** Tool calls, for waste detection. */
  toolCalls: Array<{
    name: string;
    params: string;
    error?: boolean;
    empty?: boolean;
  }>;
  /** True when the runtime compacted the context during this turn. */
  compacted?: boolean;
  /**
   * True when the turn ended for a reason other than finishing its work —
   * a stall, a wedged tool, or the caller's abort.
   */
  partial: boolean;
  /**
   * True when the agent has nothing further to do. This is how the review
   * stage's turn loop ends: the agent says so, not a counter.
   */
  done?: boolean;
};

/** Accumulated state the stage exit predicates read. */
export type ReviewState = {
  plan: ReviewPlan;
  claimedFindings: number;
  gateSubmissions: number;
  descriptionUpdated: boolean;
  descriptionSections: string[];
  /** Accepted findings with no confirmed comment. Read from the ledger. */
  unposted: IdentifiedFinding[];
};

/** Why the review stage's turn loop ended. */
export type TurnLoopEnd =
  | "agent-finished"
  | "predicate-satisfied"
  | "waste"
  | "stalled"
  | "cancelled";

export type ReviewRunOutcome = {
  /** How the review stage's turn loop ended. */
  turnLoopEnd: TurnLoopEnd;
  turns: number;
  /** Supervisor signals that produced a guidance turn, in order. */
  interventions: string[];
  /**
   * The plan as it finally stood, with each group's reviewed/gated flags.
   *
   * Reported rather than kept internal because coverage is measured from it:
   * "files examined" means files in a group the agent actually finished, which
   * only the accumulated plan knows.
   */
  plan?: ReviewPlan;
};
