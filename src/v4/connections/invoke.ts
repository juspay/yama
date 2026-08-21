/**
 * Calling a capability.
 *
 * One helper, used by every code-driven call, because the alternative is each
 * call site remembering to merge the arguments its config pinned to the tool —
 * and the one that forgets fails at runtime with "missing required parameter",
 * in production, on a real pull request.
 *
 * Target identifiers are spread in several spellings deliberately. Servers
 * disagree (`pullNumber` / `pull_number` / `prId`, `repo` / `repository`) and a
 * tool that receives one it does not know ignores it. Sending all of them is how
 * one code path drives every VCS without Yama knowing which is which.
 */

import type {
  CapabilityName,
  ResolvedCapability,
  ToolInvoker,
} from "../types/index.js";
import type { CapabilityResolver } from "./Capabilities.js";

/** Merge pinned args, target identifiers, and call arguments in that order. */
export function capabilityParams(
  capability: Pick<ResolvedCapability, "args">,
  target: Record<string, unknown>,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  // Call arguments win over pinned ones so a caller can override a default;
  // pinned args win over the target, which is only identifiers.
  return { ...target, ...capability.args, ...params };
}

/** Every spelling of "which pull request" that a configured server might want. */
export function targetParams(identity: {
  owner: string;
  repo: string;
  pullRequestId?: number;
}): Record<string, unknown> {
  return {
    owner: identity.owner,
    repo: identity.repo,
    repository: identity.repo,
    ...(identity.pullRequestId !== undefined
      ? {
          pullNumber: identity.pullRequestId,
          pull_number: identity.pullRequestId,
          prId: identity.pullRequestId,
          // GitHub's add_issue_comment (the usual postSummary mapping) takes
          // the pull request number under this name — a PR is an issue there.
          // Without it every summary post failed with a missing-parameter
          // error, and no run ever landed its verdict comment.
          issue_number: identity.pullRequestId,
        }
      : {}),
  };
}

/**
 * Invoke a capability, or return undefined when it is not available here.
 *
 * Undefined rather than a throw: a missing capability in a stage is a
 * configuration fact the caller reports in its own terms, not an exception to
 * unwind a review over.
 */
export async function invokeCapability(options: {
  resolver: CapabilityResolver;
  invoke: ToolInvoker;
  capability: CapabilityName;
  stage: Parameters<CapabilityResolver["find"]>[1];
  target: Record<string, unknown>;
  params?: Record<string, unknown>;
}): Promise<{ found: boolean; result?: unknown }> {
  const found = options.resolver.find(options.capability, options.stage);
  if (!found) {
    return { found: false };
  }
  return {
    found: true,
    result: await options.invoke(
      found.toolName,
      capabilityParams(found, options.target, options.params),
    ),
  };
}
