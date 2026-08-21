/**
 * Types for the judge layer.
 */
import type { GenerateHost } from "./session.js";
import type { ModelChain } from "./model.js";
import type { RunContext } from "./run.js";
import type { IdentifiedFinding } from "./findings.js";

export type ConfidenceScore = {
  id: string;
  score: number;
  reason: string;
};

/**
 * The judge, as the gate sees it.
 *
 * A function rather than a class so the gate tool can be tested with a stub and
 * so a project that turned scoring off simply has none.
 */
export type InlineJudge = (
  findings: IdentifiedFinding[],
) => Promise<{ scores: Map<string, number>; warnings: string[] }>;

export type InlineJudgeOptions = {
  host: GenerateHost;
  chain: ModelChain;
  context: RunContext;
  /** The rubric, resolved from the prompt catalog. */
  instruction: string;
  /** Below this, a finding is refused. Zero disables scoring entirely. */
  threshold: number;
  /** How many independent reporters raised each finding, by finding id. */
  agreement?: ReadonlyMap<string, number>;
};
