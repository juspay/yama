/**
 * Task checklist, seam-local (TASKS:N1 fallback, docs/engine-spec.md section 5.1).
 *
 * The checklist is the completeness contract: pending items mean an incomplete review. So
 * the state lives in a map keyed by session, NOT in the conversation — compaction rewrites
 * messages and would quietly erase the contract. Every tool returns the WHOLE list, so a
 * post-compaction call re-anchors the model for free.
 *
 * Tool names and result shapes are identical to the engine-native N1 primitive; when it
 * lands, this file is deleted and nothing above the seam changes.
 */
import { z } from "zod";
import type {
  EngineChecklistApi,
  EngineDelegateCounts,
  EngineTask,
  EngineTaskState,
  EngineTaskStatus,
  EngineToolRegistrar,
} from "../../types/index.js";
import {
  jsonSchemaOf,
  readParams,
  refuse,
  sessionOf,
} from "../../util/tool.js";

const STATUSES = ["pending", "in_progress", "done", "closed"] as const;

const CreateSchema = z.object({
  titles: z.array(z.string().min(1)).min(1),
});

const UpdateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(STATUSES),
  note: z.string().min(1).optional(),
});

const ListSchema = z.object({});

const countsOf = (tasks: EngineTask[]): Record<EngineTaskStatus, number> => {
  const counts: Record<EngineTaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    done: 0,
    closed: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
};

/**
 * Registers `tasks_create` / `tasks_update` / `tasks_list` and hands the host a read-only
 * view of the checklist — the completeness gate is one call (TASKS:Y4.2).
 */
export const createChecklistFallback = (options: {
  register: EngineToolRegistrar;
  /** Outstanding background work, piggybacked on every result so no polling is needed. */
  delegates: () => EngineDelegateCounts;
  /** Session of the stage currently running, used when a tool call carries no context. */
  currentSession: () => string;
}): EngineChecklistApi => {
  const checklists = new Map<string, EngineTask[]>();

  const tasksOf = (sessionId: string): EngineTask[] => {
    const existing = checklists.get(sessionId);
    if (existing) {
      return existing;
    }
    const fresh: EngineTask[] = [];
    checklists.set(sessionId, fresh);
    return fresh;
  };

  const result = (
    tasks: EngineTask[],
  ): {
    items: EngineTask[];
    counts: Record<EngineTaskStatus, number>;
    delegatesPending: number;
    delegatesReady: number;
  } => {
    const delegates = options.delegates();
    return {
      items: tasks.map((task) => ({ ...task })),
      counts: countsOf(tasks),
      delegatesPending: delegates.pending,
      delegatesReady: delegates.ready,
    };
  };

  options.register("tasks_create", {
    description:
      "Create the review checklist for this run. Every concrete review pointer you commit to finishing becomes one item. Returns the whole checklist with engine-assigned ids.",
    inputSchema: jsonSchemaOf(CreateSchema),
    execute: async (params, context) => {
      const parsed = readParams(CreateSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const tasks = tasksOf(sessionOf(context, options.currentSession()));
      for (const title of parsed.value.titles) {
        tasks.push({ id: `t${tasks.length + 1}`, title, status: "pending" });
      }
      return result(tasks);
    },
  });

  options.register("tasks_update", {
    description:
      "Move one checklist item to pending | in_progress | done | closed. Closing an item is abandoning it, so it always needs a note saying why. Returns the whole checklist.",
    inputSchema: jsonSchemaOf(UpdateSchema),
    execute: async (params, context) => {
      const parsed = readParams(UpdateSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const { id, status, note } = parsed.value;
      const tasks = tasksOf(sessionOf(context, options.currentSession()));
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        return refuse(
          `no checklist item "${id}". Valid ids: ${tasks.map((item) => item.id).join(", ") || "(none — call tasks_create first)"}.`,
        );
      }
      if (status === "closed" && note === undefined) {
        return refuse(
          `closing "${id}" abandons it unfinished. Call tasks_update again with a note saying why it will not be done.`,
        );
      }
      task.status = status;
      if (note !== undefined) {
        task.note = note;
      }
      return result(tasks);
    },
  });

  options.register("tasks_list", {
    description:
      "Read the checklist back, with counts per status and how many delegated workers are pending or ready to collect.",
    inputSchema: jsonSchemaOf(ListSchema),
    execute: async (_params, context) =>
      result(tasksOf(sessionOf(context, options.currentSession()))),
  });

  return {
    state: (sessionId: string): EngineTaskState => ({
      sessionId,
      tasks: (checklists.get(sessionId) ?? []).map((task) => ({ ...task })),
    }),
    clear: (sessionId: string): boolean => checklists.delete(sessionId),
  };
};
