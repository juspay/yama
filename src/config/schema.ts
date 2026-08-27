/**
 * Zod schemas for the `.yama/` config files (TASKS:Y1.1). This module is the single source
 * of truth for the config surface — `src/types/config.ts` infers its types from here, so
 * nothing in this file may import from the types barrel.
 *
 * Objects are strict: an unknown key is a typo, and a silently ignored typo is a config bug
 * that only shows up as odd behaviour three stages later.
 */
import { z } from "zod";
import { SeverityLevelSchema } from "../util/severity.js";
import { CAPABILITY_IDS } from "./capabilities.js";

/** Config-file schema version this build understands. */
export const CONFIG_VERSION = 1;

const NonEmptySchema = z.string().min(1);

/** A field of a fallback chain: one value broadcast to every link, or one value per link. */
const scalarOrArray = <S extends z.ZodType>(inner: S) =>
  z.union([inner, z.array(inner).min(1)]);

const VersionSchema = z
  .literal(CONFIG_VERSION, {
    message: `unsupported config version — this build understands version ${CONFIG_VERSION}`,
  })
  .default(CONFIG_VERSION);

/* ------------------------------------------------------------------ yama.yaml */

/** Roles a model chain can be configured for. `worker`/`summarizer` fall back to `main`. */
export const MODEL_ROLES = ["main", "worker", "summarizer"] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLES);

/** One resolved link of a fallback chain — shaped to drop straight into a NeuroLink pool. */
export const ModelChainLinkSchema = z.strictObject({
  provider: NonEmptySchema,
  model: NonEmptySchema.optional(),
  region: NonEmptySchema.optional(),
});

/**
 * A fallback chain as written by hand: parallel fields, each a scalar (broadcast to the
 * whole chain) or an array (one entry per link). Normalized by `normalizeModelChain`.
 */
export const ModelChainSpecSchema = z.strictObject({
  provider: scalarOrArray(NonEmptySchema),
  model: scalarOrArray(NonEmptySchema).optional(),
  region: scalarOrArray(NonEmptySchema).optional(),
});

export const ModelChainsSpecSchema = z.strictObject({
  main: ModelChainSpecSchema,
  worker: ModelChainSpecSchema.optional(),
  summarizer: ModelChainSpecSchema.optional(),
});

/** Worker-pool sizing tier (PLAN.md section 2.2). Concurrency mapping below. */
export const POOL_TIERS = ["low", "medium", "high"] as const;

export const PoolTierSchema = z.enum(POOL_TIERS);

/** Maximum concurrent delegated workers per tier. TODO(TASKS:N2.4): tune against real runs. */
export const POOL_TIER_CONCURRENCY: Record<
  z.infer<typeof PoolTierSchema>,
  number
> = {
  low: 1,
  medium: 3,
  high: 6,
};

export const PoolConfigSchema = z
  .strictObject({ tier: PoolTierSchema.default("medium") })
  .prefault({});

/** `yama learn` settings — the only path that ever holds git write access (TASKS:Y7.2). */
export const LearnConfigSchema = z
  .strictObject({
    /** Opt-in: an unconfigured repo never grows a write path by accident. */
    enabled: z.boolean().default(false),
    /** Where knowledge is written, relative to `.yama/`. */
    memoryDir: NonEmptySchema.default("memory"),
    /** Branch to commit knowledge to. Default: the branch the merge landed on. */
    branch: NonEmptySchema.optional(),
    commitPrefix: z.string().default("chore(yama): "),
    /** Appended to the commit subject so the learn commit cannot re-trigger CI. */
    skipCiToken: z.string().default("[skip ci]"),
    /** Remote to push to. Never force, and never through a URL carrying a credential. */
    remote: NonEmptySchema.default("origin"),
    /**
     * Push the knowledge commit. Off by default: committing is recoverable with one
     * `git reset`, publishing is not, and a repository should say out loud that it wants
     * an agent pushing to it.
     */
    push: z.boolean().default(false),
  })
  .prefault({});

/* ------------------------------------------------------- delivery & verdict */

/**
 * What Delivery may do (PLAN.md section 1, TASKS:Y3.5). Delivery sits OUTSIDE the task
 * checklist: the agent executes it, but this list decides what it executes, so a review
 * cannot invent extra delivery work or plan the required work away.
 *
 * Each action needs its capability mapped in `mcp.yaml`; an action whose capability is
 * absent is a degradation, never an error (`resolveDeliveryActions`).
 */
export const DELIVERY_ACTIONS = [
  "inlineComments",
  "summaryComment",
  "verdict",
  "describe",
] as const;

export const DeliveryActionSchema = z.enum(DELIVERY_ACTIONS);

/**
 * Sections description enhancement may add (TASKS:Y7.3). Config-gated, because what
 * belongs in a pull request's description is a house decision: some repositories want the
 * review's reading of the change there, some want only the risks, some want none of it.
 *
 * Whatever is on, it goes inside Yama's own marked block. The author's text is never
 * touched — see `mergeDescription`.
 */
export const DESCRIBE_SECTIONS = [
  /** What the change does, as the review read it off the diff. */
  "summary",
  /** Where the risk sits. */
  "risk",
  /** The findings this review is posting, most serious first. */
  "findings",
  /** What was reviewed, and anything the review could not finish. */
  "coverage",
] as const;

export const DescribeSectionSchema = z.enum(DESCRIBE_SECTIONS);

export const DeliveryConfigSchema = z
  .strictObject({
    /** One comment per finding, on the line it is about, carrying its dedup marker. */
    inlineComments: z.boolean().default(true),
    /** One summary comment per run: what was reviewed, what was found, the verdict. */
    summaryComment: z.boolean().default(true),
    /** Set the platform's own review state. Off by default — that is a merge gate. */
    verdict: z.boolean().default(false),
    /** Description enhancement (TASKS:Y7.3). Off by default — it rewrites the author. */
    describe: z.boolean().default(false),
    /** Inline comments one run may post. The rest are carried by the summary. */
    maxInlineComments: z.number().int().min(1).default(25),
    /** Findings less serious than this never get an inline comment. */
    minSeverity: SeverityLevelSchema.default("MINOR"),
    /**
     * Which sections `describe` adds (TASKS:Y7.3). Only ever inside Yama's marked block:
     * the author's own text is preserved byte for byte, whatever is listed here.
     */
    describeSections: z
      .array(DescribeSectionSchema)
      .default(["summary", "risk"]),
  })
  .prefault({});

/**
 * The verdict policy (TASKS:Y5.5), as data. `decideVerdict` is a pure function of the
 * findings and this block, so what a run decides is auditable from config alone.
 *
 * Defaults: any CRITICAL blocks, MAJOR-only comments, anything else approves.
 */
export const VerdictConfigSchema = z
  .strictObject({
    /** A finding at any of these severities blocks the merge. */
    blockOn: z.array(SeverityLevelSchema).default(["CRITICAL"]),
    /** A finding at any of these posts and reports, but does not gate. */
    commentOn: z.array(SeverityLevelSchema).default(["MAJOR"]),
    /** Findings below this confidence are noise: they never move the verdict. */
    minConfidence: z.number().min(0).max(1).default(0),
    /** Block once this many `commentOn` findings pile up. 0 disables the threshold. */
    blockAfter: z.number().int().min(0).default(0),
  })
  .prefault({});

export const YamaConfigSchema = z.strictObject({
  version: VersionSchema,
  models: ModelChainsSpecSchema,
  pool: PoolConfigSchema,
  learn: LearnConfigSchema,
  delivery: DeliveryConfigSchema,
  verdict: VerdictConfigSchema,
});

/* ------------------------------------------------------------------- mcp.yaml */

const ServerTimeoutSchema = z.number().int().positive().optional();

const StdioServerSchema = z.strictObject({
  transport: z.literal("stdio"),
  command: NonEmptySchema,
  args: z.array(z.string()).default([]),
  /** `${VAR}` values are expanded from the environment by the loader. */
  env: z.record(NonEmptySchema, z.string()).default({}),
  cwd: NonEmptySchema.optional(),
  timeoutMs: ServerTimeoutSchema,
  /** Tools from this server offered to the review stages (main session), by bare tool
   * name. Each is checked against what the server advertises at connect time — a name
   * the server does not advertise is a named degradation, never a silent absence. */
  expose: z.array(NonEmptySchema).default([]),
});

const remoteShape = {
  url: z.url(),
  /** `${VAR}` values are expanded from the environment by the loader. */
  headers: z.record(NonEmptySchema, z.string()).default({}),
  timeoutMs: ServerTimeoutSchema,
  /** Tools from this server offered to the review stages (main session), by bare tool
   * name. Each is checked against what the server advertises at connect time — a name
   * the server does not advertise is a named degradation, never a silent absence. */
  expose: z.array(NonEmptySchema).default([]),
};

const HttpServerSchema = z.strictObject({
  transport: z.literal("http"),
  ...remoteShape,
});

const SseServerSchema = z.strictObject({
  transport: z.literal("sse"),
  ...remoteShape,
});

export const McpServerSchema = z.discriminatedUnion("transport", [
  StdioServerSchema,
  HttpServerSchema,
  SseServerSchema,
]);

export const CapabilityIdSchema = z.enum(CAPABILITY_IDS, {
  message: `unknown capability — Yama knows: ${CAPABILITY_IDS.join(", ")}`,
});

/** A capability binding: `"<server>.<tool>"`, split on the first dot. */
export const ToolRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.\S+$/, 'must be "<server>.<tool>"');

/** What a capability's tool is always called with — the platform coordinates. */
export const CapabilityArgsSchema = z.record(
  NonEmptySchema,
  z.union([z.string(), z.number(), z.boolean()]),
);

/**
 * How `mcp.yaml` binds one capability. The short form is just the tool:
 *
 *     comment.list: github.get_pull_request_comments
 *
 * The long form adds the arguments every call of that tool needs — which repository,
 * which pull request. They belong in config because they are platform vocabulary, and
 * Yama's code is not allowed to know any:
 *
 *     comment.list:
 *       tool: github.get_pull_request_comments
 *       args: { owner: "${GITHUB_OWNER}", repo: "${GITHUB_REPO}", pullNumber: "${pr}" }
 *
 * `${pr}` / `${branch}` / `${base}` / `${mode}` come from the run target; anything else
 * is an environment variable, expanded by the loader and loud when it is not set.
 */
export const CapabilityBindingSchema = z.union([
  ToolRefSchema,
  z.strictObject({
    tool: ToolRefSchema,
    args: CapabilityArgsSchema.default({}),
  }),
]);

export const McpConfigSchema = z.strictObject({
  version: VersionSchema,
  servers: z.record(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "server id must be letters, digits, - or _"),
    McpServerSchema,
  ),
  /** capability → tool. Unmapped capability = that capability is off. */
  capabilities: z
    .partialRecord(CapabilityIdSchema, CapabilityBindingSchema)
    .default({}),
});

/* ---------------------------------------------------------------- checks.yaml */

/** One command Yama may run as evidence. Argv, never a shell string (PLAN.md section 3). */
export const CheckSpecSchema = z.strictObject({
  id: NonEmptySchema,
  command: z.array(NonEmptySchema).min(1),
  cwd: NonEmptySchema.optional(),
  timeoutMs: z.number().int().positive().default(300_000),
  /** A failing optional check is evidence, not a blocker. */
  optional: z.boolean().default(false),
});

export const ChecksConfigSchema = z.strictObject({
  version: VersionSchema,
  checks: z.array(CheckSpecSchema).default([]),
});
