/**
 * The platform layer (TASKS:Y1.3, Y5.4) — MCP servers, the capability probe, and the
 * registry every stage asks for a tool name.
 *
 * The ruling this file exists to serve: **product code never spells a platform tool
 * name**. `mcp.yaml` maps a capability to `"<server>.<tool>"`; the registry resolves it;
 * the probe proves the tool is actually there before a run leans on it. Swapping GitHub
 * for Bitbucket is then a config edit, not a code change.
 */
import type {
  CapabilityArgs,
  CapabilityBindings,
  CapabilityId,
  ConfigDegradation,
  DeliveryAction,
} from "./config.js";

/** One MCP server after `connectMcp`: what it exposed, or why it exposed nothing. */
export type McpConnection = {
  id: string;
  /** Tool names the server actually advertised. Empty when it did not connect. */
  tools: string[];
  /** Present when the connection failed; carried into the report verbatim. */
  error?: string;
};

/**
 * What the probe made of one mapped capability.
 * `tool-missing` is a config LIE (the server is up and has no such tool) and is always
 * loud; `server-unavailable` is an outage, which only fails a run that needs it.
 */
export type CapabilityStatus =
  | "ok"
  | "unmapped"
  | "tool-missing"
  | "server-unknown"
  | "server-unavailable"
  | "pair-missing";

/** One row of the probe table — capability, verdict, and the fix when there is one. */
export type CapabilityProbeEntry = {
  capability: CapabilityId;
  status: CapabilityStatus;
  server?: string;
  tool?: string;
  /** Why, in one line. Names the fix for anything broken. */
  detail: string;
};

/**
 * The startup probe (TASKS:Y1.3). `live` is the only capability map a run may act on:
 * config said what it wanted, the probe says what is actually there.
 */
export type CapabilityProbe = {
  connections: McpConnection[];
  entries: CapabilityProbeEntry[];
  /** Capabilities backed by a tool a connected server really exposes. */
  live: CapabilityBindings;
  /** Capabilities that are off, with the reason — the degradation matrix (TASKS:Y1.2). */
  degradations: ConfigDegradation[];
  /** Loud failures: a mapped tool nobody serves, or a broken pair. */
  problems: string[];
};

/**
 * Capability → tool name, and the per-stage tool lists built from it (TASKS:Y5.1).
 * Posting tools come out of `deliveryTools` and nowhere else, so a stage that is not
 * Delivery cannot be handed one by accident.
 */
export type CapabilityRegistry = {
  has: (capability: CapabilityId) => boolean;
  /** The tool `mcp.yaml` mapped, or undefined when that capability is off. */
  toolFor: (capability: CapabilityId) => string | undefined;
  /** Same, but a capability the caller cannot proceed without — throws naming the fix. */
  requireTool: (capability: CapabilityId) => string;
  /**
   * The platform coordinates every call of that capability's tool needs — which
   * repository, which pull request. Config's words, resolved; never code's.
   */
  argsFor: (capability: CapabilityId) => CapabilityArgs;
  /** Resolved tool names for the capabilities that are live; unmapped ones drop out. */
  toolsFor: (capabilities: readonly CapabilityId[]) => string[];
  /** Every live REVIEW-phase tool: what the stages before Delivery may call. */
  reviewTools: () => string[];
  /** Tools for exactly these delivery actions. Delivery's allowlist, nobody else's. */
  deliveryTools: (actions: readonly DeliveryAction[]) => string[];
};

/** What `connectPlatform` hands the run: the probe it ran and the registry it produced. */
export type PlatformSession = {
  probe: CapabilityProbe;
  registry: CapabilityRegistry;
  /** Delivery actions config asked for that the probe proved reachable. */
  deliveryActions: DeliveryAction[];
  /** `server.tool` names config exposed to the review stages and the servers proved. */
  exposedTools: string[];
};
