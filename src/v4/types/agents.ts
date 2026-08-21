import type { z } from "zod";
import type { subAgentReportSchema } from "../agents/subAgents.js";
import type { turnOutcomeSchema } from "../agents/turnContract.js";
/**
 * Types for the agents layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

export type SubAgentReport = z.infer<typeof subAgentReportSchema>;

/** The structured half of a review turn, once validated. */
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

export type SubAgentDefinition = {
  id: string;
  name: string;
  /** Shown to the main agent as the tool description — this drives delegation. */
  description: string;
  instructions: string;
  /** Tools this specialist may use. Never posting. */
  tools: string[];
  /** Cheap specialists run on the cheap chain. */
  tier: "strong" | "cheap";
  /**
   * Step cap for this specialist. Optional and unset by default: a delegate
   * decides its own depth, same as the main agent. Set it only where an
   * operator wants one.
   */
  maxSteps?: number;
};
