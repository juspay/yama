/**
 * Types for schema-bound, one-shot model calls.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ModelChain } from "./model.js";
import type { RunContext } from "./run.js";
import type { GenerateHost } from "./session.js";

/**
 * One structured call.
 *
 * Deliberately not a session: these are stateless passes (score this batch,
 * parse this output, write this description) where carrying a conversation
 * would only mean paying for context the task does not use — and, worse, would
 * mix a judge's reasoning into the reviewer's transcript.
 */
export type StructuredCallOptions<T> = {
  host: GenerateHost;
  chain: ModelChain;
  context: RunContext;
  /** The instruction, resolved from the prompt catalog by the caller. */
  systemPrompt: string;
  message: string;
  /** A zod schema. Validated after the call, never trusted from the wire. */
  schema: { safeParse(value: unknown): { success: boolean; data?: T } };
  /** Names the call in traces and in the session id. */
  operation: string;
  /**
   * Whether the model may call tools. Off by default: these passes reason over
   * text already in the message, and a tool loop on a cheap chain is how a
   * bounded classification turns into an unbounded exploration.
   */
  allowTools?: boolean;
};

export type StructuredCallResult<T> = {
  /** Absent when the model returned nothing the schema accepts. */
  data?: T;
  /** Raw text, kept for diagnostics when parsing failed. */
  content: string;
  /** Which chain member answered. */
  member?: string;
  /** Populated whenever the answer was unusable or arrived damaged. */
  warnings: string[];
};
