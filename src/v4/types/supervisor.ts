/**
 * Types for the supervisor layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { RecallEntry } from "./recall.js";

/** What the supervisor can see about a turn that just finished. */
export type TurnObservation = {
  turn: number;
  /** Files the agent said it would review, from its plan. */
  plannedPaths: string[];
  /** Files it has actually examined so far. */
  examinedPaths: string[];
  /** Gate submissions so far. */
  gateSubmissions: number;
  /** Findings accepted but not yet confirmed posted. */
  unpostedFindingIds: string[];
  /** Tool calls in this turn, for waste detection. */
  toolCalls: Array<{
    name: string;
    params: string;
    error?: boolean;
    empty?: boolean;
  }>;
  /** True when the runtime compacted the context during this turn. */
  compacted: boolean;
  /** Free-text claims the agent made about findings, for gate-hygiene checks. */
  claimedFindings: number;
};

export type SupervisorSignal =
  | "coverage-gap"
  | "gate-skipped"
  | "unposted-findings"
  | "duplicate-calls"
  | "empty-streak"
  | "error-streak"
  | "compaction";

export type SupervisorVerdict = {
  /** Whether to send a guidance turn at all. */
  intervene: boolean;
  signals: SupervisorSignal[];
  /** The message to inject, when intervening. */
  guidance: string;
};

export type SuperviseOptions = {
  observation: TurnObservation;
  /** Recall entries, for re-injecting rules that govern the next files. */
  entries: RecallEntry[];
  /** Whether the agent still has work left. Suppresses coverage nagging at the end. */
  moreTurnsExpected: boolean;
};
