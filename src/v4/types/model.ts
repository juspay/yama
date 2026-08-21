/**
 * Model selection types.
 *
 * Every model slot in Yama is a FALLBACK CHAIN, never a single pinned model. The
 * config surface accepts scalars (backward compatible) or arrays, and normalizes
 * both into an ordered list of {@link ModelChainMember} — the shape NeuroLink's
 * instance-level `modelPool` consumes.
 */

/** One candidate in a fallback chain. Mirrors NeuroLink's ModelPoolMember. */
export type ModelChainMember = {
  provider: string;
  model?: string;
  /** Provider region, where the provider distinguishes them (e.g. Vertex). */
  region?: string;
  /** Relative weight, used only by the "weighted" strategy. Default 1. */
  weight?: number;
};

/** How the pool picks among available members. Mirrors NeuroLink's strategy set. */
export type ModelPoolStrategy = "priority" | "round-robin" | "weighted";

/** Pool behaviour shared by every chain. */
export type ModelPoolSettings = {
  /** Default "priority": always try the first member that is not cooling down. */
  strategy?: ModelPoolStrategy;
  /**
   * How long a member that failed with a retryable error class (rate_limit,
   * server, network) stays out of rotation. Default 60_000.
   */
  cooldownMs?: number;
  /** Max total attempts across members for one call. Default: member count. */
  maxAttempts?: number;
};

/**
 * The raw config shape a user writes for any model slot.
 *
 * Accepted forms, all equivalent once normalized:
 *
 *   provider: vertex                       model: claude-sonnet-4-6
 *   provider: [vertex, litellm]            model: [claude-sonnet-4-6, glm-4.6]
 *   provider: [vertex, vertex]             model: [claude-sonnet-4-6, gemini-2.5-pro]
 *   provider: vertex                       model: [claude-sonnet-4-6, gemini-2.5-pro]
 *   fallback: [{ provider, model, region, weight }, ...]
 *
 * `fallback` wins outright when present; it is the only form that carries region
 * and weight.
 */
export type ModelSlotConfig = {
  provider?: string | string[];
  model?: string | string[];
  /** Explicit member list. Takes precedence over provider/model entirely. */
  fallback?: ModelChainMember[];
  pool?: ModelPoolSettings;
  temperature?: number;
  maxTokens?: number;
  timeout?: string | number;
};

/** A normalized, ready-to-wire chain. Always carries at least one member. */
export type ModelChain = {
  members: ModelChainMember[];
  pool: Required<Pick<ModelPoolSettings, "strategy" | "cooldownMs">> & {
    maxAttempts: number;
  };
  temperature?: number;
  maxTokens?: number;
  timeout?: string | number;
};

/** Named model slots. Each inherits the base `ai` chain when unset. */
export type ModelSlotName =
  | "review"
  | "subAgent"
  | "judge"
  | "scorecard"
  | "description"
  | "extraction"
  | "compaction"
  | "memory";

/**
 * How a slot's chain is actually enforced at runtime.
 *
 * NeuroLink 11.x pools natively only on the main generate path. The
 * summarization / memory-condensation / file-summarization slots each accept a
 * single provider+model, so their chain is resolved once by a startup health
 * probe. `yama doctor` prints this distinction rather than implying every slot
 * fails over mid-run.
 */
/**
 * How a slot's chain is actually honoured.
 *
 *  - `pool`   the whole chain fails over mid-run
 *  - `probe`  a single value upstream; the first reachable member is picked at
 *             startup, so it fails over between runs and not within one
 *  - `unused` accepted for compatibility, read by nothing. Reported as such
 *             rather than printed beside the live slots, because a chain that
 *             looks configured and does nothing is worse than no chain at all
 */
export type ModelSlotEnforcement = "pool" | "probe" | "unused";
