/**
 * Types for the session layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ModelChain, ModelChainMember } from "./model.js";
import type { RunContext } from "./run.js";

/** The subset of NeuroLink a session needs. Structural, so it can be faked. */
export type GenerateHost = {
  generate(options: Record<string, unknown>): Promise<GenerateResponse>;
  registerTool?(name: string, tool: Record<string, unknown>): void;
  unregisterTool?(name: string): boolean;
  setToolContext?(context: Record<string, unknown>): void;
  getConversationHistory?(sessionId: string): Promise<unknown[]>;
};

export type GenerateResponse = {
  content?: string;
  structuredData?: unknown;
  /** How the turn ended. Anything but a natural finish means partial. */
  stopReason?: string;
  /**
   * The runtime had to repair malformed JSON to satisfy the schema. The answer
   * is usable; that it needed repairing is worth saying out loud.
   */
  jsonRepaired?: boolean;
  /**
   * The structured answer hit the output token cap and may be incomplete.
   * Reported rather than parsed around: half an answer that validates is the
   * most dangerous kind, because nothing downstream can tell it is half.
   */
  jsonTruncated?: boolean;
  toolExecutions?: Array<{
    toolName?: string;
    params?: unknown;
    result?: unknown;
    isError?: boolean;
    durationMs?: number;
  }>;
  usage?: { input?: number; output?: number; total?: number };
};

/** A turn's result, normalised for the supervisor. */
export type TurnResult = {
  turn: number;
  content: string;
  structuredData?: unknown;
  stopReason?: string;
  toolCalls: Array<{
    name: string;
    params: string;
    error?: boolean;
    empty?: boolean;
  }>;
  /** What each specialist returned this turn, unvalidated. */
  delegateResults: Array<{ agent: string; result: unknown }>;
  /** True when the turn ended for a reason other than finishing its work. */
  partial: boolean;
  usage?: GenerateResponse["usage"];
  /** The structured answer needed repairing to parse. */
  jsonRepaired?: boolean;
  /** The structured answer was cut off by the output token cap. */
  jsonTruncated?: boolean;
};

export type SessionOptions = {
  host: GenerateHost;
  context: RunContext;
  chain: ModelChain;
  systemInstruction: string;
  /**
   * Per-turn step cap. NO DEFAULT — set it only if an operator asked for one.
   * The agent controls the flow; a step cap invented here would override that.
   */
  maxStepsPerTurn?: number;
  /** Hang protection. Not a budget — a wedged tool detector. */
  stallTimeoutMs?: number;
  toolTimeoutMs?: number;
  onTurn?: (result: TurnResult) => void;
  /**
   * Reports that no model in the chain can serve this run.
   *
   * Fired once. Every later turn fails immediately with the same error rather
   * than repeating the outage per stage.
   */
  onChainExhausted?: (error: Error) => void;
  /** Reports a move to the next model in the chain, so the run says it happened. */
  onFailover?: (event: {
    from: ModelChainMember;
    to?: ModelChainMember;
    reason: string;
  }) => void;
};
