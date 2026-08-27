/**
 * Reading the target, deterministically (TASKS:Y4.3, Y7.1).
 *
 * Two things in a run must know what is actually on the pull request rather than what a
 * model says is: the preflight marker scan that makes a re-review recognise itself, and
 * the dedup that stops Delivery posting the same finding twice. Both call the capability
 * themselves — asking an agent to transcribe a comment thread would be dearer, slower and
 * less reliable than reading the tool result.
 *
 * A failing or unavailable read is reported, never thrown: it costs dedup, and a duplicate
 * comment is a smaller failure than a review that never lands.
 */
import type {
  CapabilityRegistry,
  Engine,
  ExistingComment,
} from "../types/index.js";
import { readComments } from "./results.js";

/** Comments on the target, or the reason there are none to be had. */
export const readTargetComments = async (options: {
  engine: Engine;
  registry: CapabilityRegistry;
}): Promise<{ comments: ExistingComment[]; problem?: string }> => {
  const tool = options.registry.toolFor("comment.list");
  if (tool === undefined) {
    return {
      comments: [],
      problem:
        'capability "comment.list" is not available, so nothing could be deduped against what is already on the target',
    };
  }
  try {
    const result = await options.engine.callTool(
      tool,
      options.registry.argsFor("comment.list"),
    );
    return { comments: readComments(result) };
  } catch (error) {
    return {
      comments: [],
      problem: `reading the existing comments with "${tool}" failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
