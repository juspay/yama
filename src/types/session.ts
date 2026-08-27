/**
 * The main session (TASKS:Y2.2). One run is one session: every stage is a structured
 * checkpoint on it, so the agent carries what it learned in WarmUp into Task Insertion
 * without the shell re-explaining anything.
 */
import type { ZodType } from "zod";
import type { EngineToolResult } from "./engine.js";
import type { StageOutput } from "./findings.js";
import type { Stage } from "./run.js";
import type { RunStageMetric } from "./store.js";

/** One stage checkpoint: a prompt, the shape the answer must take, and the tools allowed. */
export type SessionCheckpointRequest<T> = {
  stage: Stage;
  prompt: string;
  schema: ZodType<T>;
  /** Tool allowlist for this stage (TASKS:Y5.1). Omitted means every registered tool. */
  tools?: string[];
  maxSteps?: number;
};

/** The run's single session, driven stage by stage and banked at every step. */
export type SessionRunner = {
  sessionId: string;
  /**
   * Runs one stage, banks the verbatim output and the structured envelope, and returns
   * the envelope. Throws `StageError` when nothing schema-valid came back — the evidence
   * is already on disk by then, so the failure is diagnosable.
   */
  checkpoint: <T>(
    req: SessionCheckpointRequest<T>,
  ) => Promise<StageOutput<Stage, T>>;
  /** What each stage cost so far; goes straight into the run report. */
  metrics: () => RunStageMetric[];
  /**
   * Tool results of the MOST RECENT checkpoint. Delivery reads these to confirm what
   * actually landed on the platform (TASKS:Y4.4) — the agent's own account is a claim.
   */
  toolResults: () => EngineToolResult[];
};
