/**
 * Capability → tool name (TASKS:Y5.4).
 *
 * This module exists so that no other module ever spells a platform tool name. GitHub
 * calls it `create_pull_request_review_comment`, Bitbucket calls it something else, and
 * the next platform will call it a third thing; Yama only ever knows the CAPABILITY. The
 * mapping lives in `mcp.yaml`, is proved by the probe, and is resolved here.
 *
 * It is also where stage-scoped exposure is decided (TASKS:Y5.1): review-phase tools come
 * out of `reviewTools`, posting tools come out of `deliveryTools` and nowhere else, and
 * workers are never handed either — they get `READ_ONLY_TOOLS` and nothing more.
 */
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  DELIVERY_CAPABILITIES,
} from "../config/capabilities.js";
import { ConfigError } from "../config/errors.js";
import type {
  CapabilityArgs,
  CapabilityBindings,
  CapabilityId,
  CapabilityRegistry,
  DeliveryAction,
} from "../types/index.js";

/** Deduped, order preserved — a tool mapped to two capabilities is still one tool. */
const unique = (names: readonly (string | undefined)[]): string[] => [
  ...new Set(names.filter((name): name is string => name !== undefined)),
];

/**
 * Builds the registry over the capabilities that are actually live. Pass the PROBE's
 * `live` map rather than the config's: what config asked for and what the servers serve
 * are two different things, and only one of them can be called.
 */
export const createCapabilityRegistry = (
  bindings: CapabilityBindings,
): CapabilityRegistry => {
  const toolFor = (capability: CapabilityId): string | undefined =>
    bindings[capability]?.tool;

  const toolsFor = (capabilities: readonly CapabilityId[]): string[] =>
    unique(capabilities.map(toolFor));

  return {
    has: (capability) => bindings[capability] !== undefined,
    toolFor,
    requireTool: (capability) => {
      const tool = toolFor(capability);
      if (tool === undefined) {
        throw new ConfigError(
          `capability "${capability}" is needed here and is not available`,
          {
            hint: `map it in .yama/mcp.yaml as "${capability}: <server>.<tool>", and check \`yama doctor\` reports the server exposing that tool`,
          },
        );
      }
      return tool;
    },
    argsFor: (capability): CapabilityArgs => ({
      ...(bindings[capability]?.args ?? {}),
    }),
    toolsFor,
    reviewTools: () =>
      toolsFor(
        CAPABILITY_IDS.filter(
          (capability) => CAPABILITIES[capability].phase === "review",
        ),
      ),
    deliveryTools: (actions: readonly DeliveryAction[]) =>
      unique([
        ...actions.flatMap((action) => {
          const capability = DELIVERY_CAPABILITIES[action];
          // Posting also needs reading: a comment is deduped by the marker on it.
          return [
            toolFor(capability),
            ...CAPABILITIES[capability].requires.map(toolFor),
          ];
        }),
        // The pending-review lifecycle rides with inline posting when the forge maps it
        // (both-or-neither, enforced by the probe). It is not in inline's own `requires`,
        // so forges where an inline comment is one call are untouched.
        ...(actions.includes("inlineComments")
          ? [toolFor("review.begin"), toolFor("review.submit")]
          : []),
        // Replying is not one of the configured ACTIONS — nothing schedules it and nothing
        // counts it. It rides along whenever this run is posting at all, because whether a
        // thread is worth answering is a judgement made while delivering, not a box a
        // repository ticks in advance. Unmapped, it simply is not there.
        ...(actions.length > 0 ? [toolFor("comment.reply")] : []),
      ]),
  };
};
