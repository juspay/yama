/**
 * Types for the runtime layer — the live binding between Yama's ports and the
 * provider SDK.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { SubAgentDefinition } from "./agents.js";
import type { McpRole, ResolvedConfig, StageName } from "./config.js";
import type { CapabilityReport } from "./connections.js";
import type { ModelChains } from "./factory.js";
import type { ModelChainMember } from "./model.js";
import type { ToolInvoker } from "./posting.js";
import type { McpHost, RegistryLogger } from "./registry.js";
import type { RunContext } from "./run.js";
import type { GenerateHost } from "./session.js";
import type { YamaTool } from "./tools.js";

/** The live host: one instance satisfying every port the run needs. */
export type RuntimeHost = GenerateHost & McpHost;

export type CreateRuntimeOptions = {
  config: ResolvedConfig;
  chains: ModelChains;
  context: RunContext;
  /** Which server set to register. */
  role: McpRole;
  logger?: RegistryLogger;
  env?: NodeJS.ProcessEnv;
};

/**
 * A constructed runtime, with its connections registered and its capabilities
 * probed against what the servers actually advertise.
 */
export type YamaRuntime = {
  host: RuntimeHost;
  invoke: ToolInvoker;
  capabilities: CapabilityReport;
  /** Delegation tools the main agent may call, by sub-agent id. */
  delegates: string[];
  shutdown(): Promise<void>;
};

/** What a delegated specialist needs in order to run isolated. */
export type DelegationOptions = {
  host: RuntimeHost;
  definitions: SubAgentDefinition[];
  /** Read-only tools the specialist may use. Never posting. */
  tools: YamaTool[];
  /** Tool names from MCP servers the specialist may reach. */
  mcpTools: string[];
  /** The model a given tier runs on, from the resolved chains. */
  member(tier: "strong" | "cheap"): ModelChainMember | undefined;
  /** Process-wide delegation pool size, from `concurrency.power`. */
  maxConcurrent: number;
  /** Delegations the main agent may make in one turn. */
  delegationsPerTurn: number;
};

/**
 * Progress an agent declared during one turn.
 *
 * The pipeline's exit predicates read real state wherever real state exists —
 * the ledger for gating, the posting tool results for comments. Plan and
 * completion have no such source: only the agent knows what it grouped and when
 * it considers itself finished, so it declares them through a tool whose input
 * schema the provider validates natively.
 */
export type TurnProgress = {
  plan?: {
    groups: Array<{ id: string; paths: string[] }>;
    declined: Array<{ path: string; reason: string }>;
  };
  completedGroups: string[];
  cleanGroups: string[];
  claimedFindings: number;
  resolved?: { pullRequestId?: number; headSha?: string; baseSha?: string };
  descriptionUpdated?: boolean;
  descriptionSections: string[];
  done: boolean;
};

export type TurnBinding = {
  /** Reset before a turn; read after it. */
  begin(stage: StageName): void;
  /** What the agent declared during the turn just taken. */
  drain(): TurnProgress;
  /** The tool through which the agent declares it. */
  tool: YamaTool;
};
