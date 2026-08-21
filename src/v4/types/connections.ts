/**
 * Connection layer types: what a registered server looks like once it is live,
 * and how a capability resolves to a callable tool.
 */

import type { CapabilityName, McpRole, StageName } from "./config.js";

/** Outcome of registering one server. */
export type ServerRegistration = {
  id: string;
  ok: boolean;
  /** Tool names the server advertised. Empty on failure. */
  tools: string[];
  error?: string;
  /** True when an allowlist was enforced by re-registering with a denylist. */
  allowlistEnforced?: boolean;
};

/** A capability that resolved to a tool on a live server. */
export type ResolvedCapability = {
  capability: CapabilityName;
  serverId: string;
  toolName: string;
  /** Arguments merged into every call, from the config's object binding form. */
  args?: Record<string, unknown>;
  /** Stages during which this tool may be exposed or invoked. */
  stages: StageName[];
  roles: McpRole[];
};

/** A capability a config declared but the live server does not provide. */
export type MissingCapability = {
  capability: CapabilityName;
  serverId: string;
  /** The tool name the config named. */
  declared: string;
  /** What the server actually advertises, so the fix is copy-pasteable. */
  available: string[];
};

export type CapabilityReport = {
  resolved: ResolvedCapability[];
  missing: MissingCapability[];
  registrations: ServerRegistration[];
};

/** Capabilities without which a live run cannot do its job. */
export const REQUIRED_LIVE_CAPABILITIES: CapabilityName[] = [
  "readPullRequest",
  "postInlineComment",
  "postSummary",
];

/**
 * Capabilities that only make sense together.
 *
 * A provider that needs a review opened before inline comments can be attached
 * also needs it submitted afterwards — comments on a review that is never
 * submitted are invisible to everyone, which is the worst possible outcome:
 * Yama reports success and the team sees nothing.
 */
export const CAPABILITY_PAIRS: Array<[CapabilityName, CapabilityName]> = [
  ["beginReview", "submitReview"],
];
