/**
 * Config types. Every shape that comes out of a `.yama/` file is inferred from the zod
 * schema that validates it, so the schema and the type can never drift apart.
 */
import type { z } from "zod";
import type {
  CapabilityBindingSchema,
  CapabilityIdSchema,
  CheckSpecSchema,
  ChecksConfigSchema,
  DeliveryActionSchema,
  DeliveryConfigSchema,
  DescribeSectionSchema,
  LearnConfigSchema,
  MemoryConfigSchema,
  McpConfigSchema,
  McpServerSchema,
  ModelChainLinkSchema,
  ModelChainSpecSchema,
  ModelChainsSpecSchema,
  ModelRoleSchema,
  PoolConfigSchema,
  PoolTierSchema,
  ReviewConfigSchema,
  VerdictConfigSchema,
  YamaConfigSchema,
} from "../config/schema.js";

/* ------------------------------------------------------------------ yama.yaml */

/** Which chain a call uses: the main session, a delegated worker, or a summarizer. */
export type ModelRole = z.infer<typeof ModelRoleSchema>;

/** A fallback chain as written in `yama.yaml` — parallel scalars and/or arrays. */
export type ModelChainSpec = z.infer<typeof ModelChainSpecSchema>;

/** The whole `models:` block, before normalization. */
export type ModelChainsSpec = z.infer<typeof ModelChainsSpecSchema>;

/** One link of a normalized fallback chain, tried in order until one answers. */
export type ModelChainLink = z.infer<typeof ModelChainLinkSchema>;

/** Normalized chains — every role resolved, no role left undefined. */
export type ModelChains = Record<ModelRole, ModelChainLink[]>;

/** Worker-pool sizing tier. */
export type PoolTier = z.infer<typeof PoolTierSchema>;

export type PoolConfig = z.infer<typeof PoolConfigSchema>;

/** The `memory:` block: the run's own short-term memory across stages (TASKS:Y2.5). */
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export type LearnConfig = z.infer<typeof LearnConfigSchema>;

/** One thing Delivery may do. Delivery is config-driven, never agent-chosen (TASKS:Y3.5). */
export type DeliveryAction = z.infer<typeof DeliveryActionSchema>;

/** One section description enhancement may add, inside Yama's block (TASKS:Y7.3). */
export type DescribeSection = z.infer<typeof DescribeSectionSchema>;

/** The `delivery:` block: what Delivery runs, and the bounds it runs within. */
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;

/** The `verdict:` block — the whole input to the verdict policy besides the findings. */
export type VerdictConfig = z.infer<typeof VerdictConfigSchema>;

/**
 * What a review never looks at. Excluded paths are dropped from the diff before any stage
 * sees them, so a generated file cannot crowd out the change or attract a finding.
 */
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/** Validated `.yama/yama.yaml`. */
export type YamaConfig = z.infer<typeof YamaConfigSchema>;

/* ------------------------------------------------------------------- mcp.yaml */

/** One MCP server declaration, discriminated by transport. */
export type McpServerConfig = z.infer<typeof McpServerSchema>;

/** Transport of an MCP server declaration. */
export type McpTransport = McpServerConfig["transport"];

/** Validated `.yama/mcp.yaml`. */
export type McpConfig = z.infer<typeof McpConfigSchema>;

/** A capability Yama knows how to use, mapped to a tool by `mcp.yaml`. */
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/** How `mcp.yaml` declares one binding: the tool alone, or the tool plus its arguments. */
export type CapabilityBindingSpec = z.infer<typeof CapabilityBindingSchema>;

/** Review-phase capabilities are readable by anyone; delivery ones only in Delivery. */
export type CapabilityPhase = "review" | "delivery";

/** Arguments a capability's tool is always called with — resolved, never templated. */
export type CapabilityArgs = Record<string, string | number | boolean>;

/**
 * A capability resolved to the server, the tool and the platform coordinates that reach
 * it. Nothing above the config layer knows what any of these strings mean (TASKS:Y5.4).
 */
export type CapabilityBinding = {
  capability: CapabilityId;
  server: string;
  tool: string;
  args: CapabilityArgs;
};

/** Capability → binding. A missing entry means that capability is off. */
export type CapabilityBindings = Partial<
  Record<CapabilityId, CapabilityBinding>
>;

/* ---------------------------------------------------------------- checks.yaml */

/** One check command, run as argv (TASKS:Y5.2). */
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

/** Validated `.yama/checks.yaml`. */
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;

/* -------------------------------------------------------------------- layout */

/** Absolute locations of every `.yama/` entry. */
export type ConfigPaths = {
  root: string;
  dir: string;
  yamaFile: string;
  mcpFile: string;
  checksFile: string;
  rulebookDir: string;
  memoryDir: string;
  artifactsDir: string;
};

/** Rulebook on disk. WarmUp reads `index` first, then follows it (TASKS:Y3.1). */
export type RulebookLayout = {
  dir: string;
  index?: string;
};

/** One capability that is off because an optional piece is absent — never an error. */
export type ConfigDegradation = {
  /** The capability that is off, e.g. "checks" or "rulebook". */
  what: string;
  /** Why it is off, naming the path that would turn it on. */
  reason: string;
};

/** Everything the shell needs from `.yama/`, validated and normalized. */
export type ResolvedConfig = {
  paths: ConfigPaths;
  yama: YamaConfig;
  mcp: McpConfig;
  /** Absent when `checks.yaml` is not present — the checks capability is simply off. */
  checks?: ChecksConfig;
  chains: ModelChains;
  capabilities: CapabilityBindings;
  /**
   * Delivery actions this run can actually perform: enabled in config AND backed by a
   * mapped capability AND reachable in this target mode. Anything config asked for that
   * is missing from here has a matching entry in `degradations`.
   */
  deliveryActions: DeliveryAction[];
  /** Absent when `rulebook/` is not present. */
  rulebook?: RulebookLayout;
  /** Absent when `memory/` is not present. */
  memoryDir?: string;
  degradations: ConfigDegradation[];
};
