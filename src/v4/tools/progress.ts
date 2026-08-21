/**
 * How a turn tells the pipeline what it did.
 *
 * The stage predicates prefer real state: the ledger knows what was gated, the
 * posting tool results know what carries a comment id. Two things have no such
 * source — how the agent chose to group the change, and whether it considers
 * itself finished — because only the agent knows them.
 *
 * They are declared through a tool rather than through a per-turn output schema
 * on purpose. A schema alongside tools is supported unevenly across providers,
 * and the fallback is coerced JSON parsed out of prose, which is exactly the
 * failure mode v3 died of. A tool's input schema is validated natively by every
 * provider that can call tools at all, and the call itself is observable in the
 * trace.
 *
 * Nothing here is a budget. `done` is the agent saying it is finished; the exit
 * predicate still has to agree.
 */

import type {
  StageName,
  TurnBinding,
  TurnProgress,
  YamaTool,
} from "../types/index.js";

const empty = (): TurnProgress => ({
  completedGroups: [],
  cleanGroups: [],
  claimedFindings: 0,
  descriptionSections: [],
  done: false,
});

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * Build the progress tool and the accumulator the adapter drains after a turn.
 *
 * Accumulating rather than replacing: an agent may call this more than once in a
 * turn — declaring a plan, then finishing a group — and the last call must not
 * erase the earlier ones.
 */
export function createTurnBinding(): TurnBinding {
  let progress = empty();
  let stage: StageName = "resolve";

  const tool: YamaTool = {
    name: "report_progress",
    description:
      "Tell the harness what you just did. Call it when you produce your plan, when " +
      "you finish a group, and when you have nothing left to do. Everything is " +
      "optional — send only what changed. This posts nothing and reviews nothing; it " +
      "is how the run knows your work landed.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          description:
            "Your review plan. Send it once, during orientation. Every changed file " +
            "must appear in exactly one group, or in `declined` with a reason.",
          properties: {
            groups: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  paths: { type: "array", items: { type: "string" } },
                },
                required: ["id", "paths"],
              },
            },
            declined: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["path", "reason"],
              },
            },
          },
          required: ["groups"],
        },
        completedGroups: {
          type: "array",
          items: { type: "string" },
          description: "Group ids you finished reviewing this turn.",
        },
        cleanGroups: {
          type: "array",
          items: { type: "string" },
          description:
            "Group ids you reviewed and found nothing worth reporting in. Use this " +
            "instead of submitting nothing silently — silence is indistinguishable " +
            "from an unreviewed group.",
        },
        claimedFindings: {
          type: "number",
          description:
            "How many issues you described in this turn's prose. The harness compares " +
            "it against what reached the gate.",
        },
        resolved: {
          type: "object",
          description:
            "Identifiers you established while resolving the pull request.",
          properties: {
            pullRequestId: { type: "number" },
            headSha: { type: "string" },
            baseSha: { type: "string" },
          },
        },
        descriptionUpdated: { type: "boolean" },
        descriptionSections: {
          type: "array",
          items: { type: "string" },
          description: "Section headings you wrote into the description.",
        },
        done: {
          type: "boolean",
          description:
            "True when you have nothing further to do in this stage. The harness still " +
            "verifies coverage; if something is missing you will be told exactly what.",
        },
      },
    },
    stages: [
      "resolve",
      "orient",
      "review",
      "post",
      "checks",
      "enhance",
      "verdict",
    ],
    roles: ["main"],
    execute: async (params) => {
      const plan = params.plan as TurnProgress["plan"] | undefined;
      if (plan && Array.isArray(plan.groups)) {
        progress.plan = {
          groups: plan.groups
            .filter((group) => group && typeof group.id === "string")
            .map((group) => ({
              id: group.id,
              paths: asStrings(group.paths),
            })),
          declined: (Array.isArray(plan.declined) ? plan.declined : []).filter(
            (entry) =>
              entry &&
              typeof entry.path === "string" &&
              typeof entry.reason === "string",
          ),
        };
      }

      progress.completedGroups.push(...asStrings(params.completedGroups));
      progress.cleanGroups.push(...asStrings(params.cleanGroups));
      progress.descriptionSections.push(
        ...asStrings(params.descriptionSections),
      );

      if (typeof params.claimedFindings === "number") {
        progress.claimedFindings += params.claimedFindings;
      }
      if (params.resolved && typeof params.resolved === "object") {
        const resolved = params.resolved as Record<string, unknown>;
        progress.resolved = {
          ...progress.resolved,
          ...(typeof resolved.pullRequestId === "number"
            ? { pullRequestId: resolved.pullRequestId }
            : {}),
          ...(typeof resolved.headSha === "string"
            ? { headSha: resolved.headSha }
            : {}),
          ...(typeof resolved.baseSha === "string"
            ? { baseSha: resolved.baseSha }
            : {}),
        };
      }
      if (params.descriptionUpdated === true) {
        progress.descriptionUpdated = true;
      }
      // `done` latches on: a turn that says it is finished and then makes one
      // more tool call has still said it is finished.
      if (params.done === true) {
        progress.done = true;
      }

      return {
        acknowledged: true,
        stage,
        // Echoed back so the agent can see the harness's view of its own
        // progress without having to remember it across a compaction.
        groups: progress.plan?.groups.map((group) => group.id) ?? [],
        completed: [...new Set(progress.completedGroups)],
      };
    },
  };

  return {
    begin: (next) => {
      stage = next;
      progress = empty();
    },
    drain: () => progress,
    tool,
  };
}
