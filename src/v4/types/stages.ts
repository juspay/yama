/**
 * Types for the stages layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { StageName } from "./config.js";
import type { StageCheck, StageOutcome } from "./run.js";

export type StageDefinition = {
  name: StageName;
  /** Whether this stage runs at all for this configuration. */
  enabled?: boolean;
  /** Do the work. Called once, then again per remediation attempt. */
  run(attempt: number): Promise<void>;
  /** Did the work actually land? Pure inspection of real state. */
  check(): Promise<StageCheck> | StageCheck;
  /** Ask the agent to close the gap. Absent means the stage cannot remediate. */
  remediate?(check: Extract<StageCheck, { ok: false }>): Promise<void>;
};

export type StageMachineOptions = {
  maxAttemptsPerStage: number;
  now?: () => number;
  onStage?: (outcome: StageOutcome) => void;
  /** Aborts the whole run. A cancelled run stops between stages, cleanly. */
  signal?: AbortSignal;
};

export type StageMachineResult = {
  outcomes: StageOutcome[];
  /** True when any stage ended degraded or failed. Blocks approval. */
  partial: boolean;
  degradedStages: StageName[];
};
