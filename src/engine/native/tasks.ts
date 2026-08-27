/**
 * Task checklist, engine-native (TASKS:N1, docs/engine-spec.md section 1).
 *
 * `registerTaskTools()` puts `tasks_create` / `tasks_update` / `tasks_list` on the registry
 * under the same names the fallback used, so every prompt written against the fallback
 * keeps working verbatim. Two things the engine does that the fallback could not:
 *
 *   - the state lives in a module-level map in the ENGINE, so it survives a worker instance
 *     and a second `NeuroLink` in the same process, not just a compaction;
 *   - the toolset registers `cacheable: false`, so a second `tasks_list` inside one run is
 *     never served from the tool-result cache — an argument-less tool is otherwise a perfect
 *     cache hit, and a checklist that appears never to change is the exact failure the
 *     completeness gate exists to catch.
 *
 * Sessions come from the tool execution context, falling back to the host's
 * `setToolContext({ sessionId })` — which `createStructuredCall` stamps before every stage —
 * so `state(sessionId)` reads what the model just wrote.
 */
import type { ChecklistItem, NeuroLink } from "@juspay/neurolink";
import type {
  EngineChecklistApi,
  EngineTask,
  EngineTaskState,
} from "../../types/index.js";

/** Engine item → seam item. Timestamps stay in the engine; the gate never asks for them. */
const toEngineTask = (item: ChecklistItem): EngineTask => ({
  id: item.id,
  title: item.title,
  status: item.status,
  ...(item.note !== undefined ? { note: item.note } : {}),
});

/** Registers the three N1 tools and exposes the host-side read the gate needs. */
export const createChecklistNative = (options: {
  nl: NeuroLink;
}): EngineChecklistApi => {
  options.nl.registerTaskTools();

  return {
    state: (sessionId: string): EngineTaskState => ({
      sessionId,
      tasks: options.nl.getTaskState(sessionId).items.map(toEngineTask),
    }),
    clear: (sessionId: string): boolean => options.nl.clearTaskState(sessionId),
  };
};
