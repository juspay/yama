/**
 * Model chain normalization — the single place a user's provider/model config
 * becomes an ordered fallback chain.
 *
 * Yama exposes arrays on every model slot so a failing provider or model falls
 * through to the next candidate. NeuroLink consumes this as an instance-level
 * `modelPool`, whose members are independent — which is what makes "same
 * provider, different model" a valid chain entry rather than a special case.
 *
 * Pure and total: same input always yields the same chain, and every failure is
 * a thrown ConfigError naming both the problem and the fix. Nothing here reads
 * the environment or the filesystem.
 */

import { parseDurationMs } from "../core/RunContext.js";
import type {
  ModelChain,
  ModelChainMember,
  ModelSlotConfig,
} from "../types/index.js";

/** Defaults applied when `pool` is omitted. Mirrors NeuroLink's own defaults. */
const DEFAULT_STRATEGY = "priority" as const;
const DEFAULT_COOLDOWN_MS = 60_000;

export class ModelChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelChainError";
  }
}

const asArray = (value: string | string[] | undefined): string[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
};

const clean = (values: string[], field: string, slot: string): string[] => {
  const trimmed = values.map((value) => {
    if (typeof value !== "string") {
      throw new ModelChainError(
        `${slot}.${field} must contain only strings; found ${typeof value}.`,
      );
    }
    return value.trim();
  });
  const empty = trimmed.findIndex((value) => value.length === 0);
  if (empty !== -1) {
    throw new ModelChainError(
      `${slot}.${field}[${empty}] is empty. Remove the entry or give it a value.`,
    );
  }
  return trimmed;
};

/**
 * Zip providers and models into members.
 *
 * Broadcasting is deliberate and one-directional per side: a single provider
 * spreads across many models (one backend, several models to try) and a single
 * model spreads across many providers (same model served by several backends).
 * Two arrays of different lengths is always a mistake — silently truncating or
 * cycling would quietly change which model runs, so it fails loudly instead.
 */
function zip(
  providers: string[],
  models: string[],
  slot: string,
): ModelChainMember[] {
  if (providers.length === 0) {
    throw new ModelChainError(
      `${slot}.provider is required. Set a provider name, or a list of them for fallback.`,
    );
  }

  if (models.length === 0) {
    return providers.map((provider) => ({ provider }));
  }

  if (providers.length === 1) {
    return models.map((model) => ({ provider: providers[0], model }));
  }

  if (models.length === 1) {
    return providers.map((provider) => ({ provider, model: models[0] }));
  }

  if (providers.length !== models.length) {
    throw new ModelChainError(
      `${slot}.provider has ${providers.length} entries but ${slot}.model has ` +
        `${models.length}. They are paired by position, so the lists must match ` +
        `in length — or set exactly one of them to broadcast across the other. ` +
        `To pair them explicitly, use ${slot}.fallback: [{ provider, model }, ...].`,
    );
  }

  return providers.map((provider, index) => ({
    provider,
    model: models[index],
  }));
}

/** Validate an explicit `fallback` list. */
function fromExplicit(
  fallback: ModelChainMember[],
  slot: string,
): ModelChainMember[] {
  if (!Array.isArray(fallback) || fallback.length === 0) {
    throw new ModelChainError(
      `${slot}.fallback must be a non-empty list of { provider, model } entries.`,
    );
  }
  return fallback.map((member, index) => {
    const provider =
      typeof member?.provider === "string" ? member.provider.trim() : "";
    if (!provider) {
      throw new ModelChainError(
        `${slot}.fallback[${index}].provider is required and must be a non-empty string.`,
      );
    }
    const normalized: ModelChainMember = { provider };
    if (typeof member.model === "string" && member.model.trim()) {
      normalized.model = member.model.trim();
    }
    if (typeof member.region === "string" && member.region.trim()) {
      normalized.region = member.region.trim();
    }
    if (typeof member.weight === "number" && Number.isFinite(member.weight)) {
      if (member.weight <= 0) {
        throw new ModelChainError(
          `${slot}.fallback[${index}].weight must be greater than 0.`,
        );
      }
      normalized.weight = member.weight;
    }
    return normalized;
  });
}

/**
 * Drop members that repeat an earlier (provider, model, region) triple.
 *
 * A duplicate is never a useful fallback — the second attempt would fail exactly
 * as the first did — and it inflates `maxAttempts`, so the pool would burn real
 * attempts on a candidate already known to be down.
 */
function dedupe(members: ModelChainMember[]): ModelChainMember[] {
  const seen = new Set<string>();
  const unique: ModelChainMember[] = [];
  for (const member of members) {
    const key = `${member.provider}\u0000${member.model ?? ""}\u0000${member.region ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(member);
  }
  return unique;
}

/**
 * Normalize one slot's config into a fallback chain.
 *
 * @param config Raw slot config as written by the user. May be undefined when
 *               the slot inherits from a base chain — see {@link resolveSlot}.
 * @param slot   Config path used in error messages (e.g. "ai.judge").
 */
export function normalizeModelChain(
  config: ModelSlotConfig | undefined,
  slot = "ai",
): ModelChain {
  if (!config) {
    throw new ModelChainError(
      `${slot} is not configured. Set ${slot}.provider (and optionally ${slot}.model).`,
    );
  }

  const members = dedupe(
    config.fallback
      ? fromExplicit(config.fallback, slot)
      : zip(
          clean(asArray(config.provider), "provider", slot),
          clean(asArray(config.model), "model", slot),
          slot,
        ),
  );

  const pool = config.pool ?? {};
  const maxAttempts =
    typeof pool.maxAttempts === "number" && Number.isFinite(pool.maxAttempts)
      ? Math.max(1, Math.floor(pool.maxAttempts))
      : members.length;

  const chain: ModelChain = {
    members,
    pool: {
      strategy: pool.strategy ?? DEFAULT_STRATEGY,
      cooldownMs:
        typeof pool.cooldownMs === "number" && Number.isFinite(pool.cooldownMs)
          ? Math.max(0, Math.floor(pool.cooldownMs))
          : DEFAULT_COOLDOWN_MS,
      maxAttempts,
    },
  };

  if (config.temperature !== undefined) {
    chain.temperature = config.temperature;
  }
  if (config.maxTokens !== undefined) {
    chain.maxTokens = config.maxTokens;
  }
  if (config.timeout !== undefined) {
    // The schema accepts "10m"-style strings; downstream consumers need
    // milliseconds and silently disarm on a non-number (Number.isFinite
    // guards in the runtime), so the parse happens here, loudly.
    const parsed =
      typeof config.timeout === "number"
        ? config.timeout
        : parseDurationMs(config.timeout);
    if (parsed === undefined) {
      throw new ModelChainError(
        `${slot}.timeout: "${config.timeout}" is not a duration. Use milliseconds ` +
          `or a suffixed string like "90s", "10m", "2h".`,
      );
    }
    chain.timeout = parsed;
  }

  return chain;
}

/**
 * Resolve a named slot against a base chain.
 *
 * A slot may override the chain entirely (its own provider/model/fallback) or
 * only tune the call knobs (temperature/maxTokens/timeout) while inheriting the
 * base members — the common case for cheap auxiliary passes that should follow
 * whatever the base is configured with.
 */
export function resolveSlot(
  base: ModelChain,
  override: ModelSlotConfig | undefined,
  slot: string,
): ModelChain {
  if (!override) {
    return base;
  }

  const declaresMembers =
    override.fallback !== undefined ||
    override.provider !== undefined ||
    override.model !== undefined;

  if (declaresMembers) {
    return normalizeModelChain(override, slot);
  }

  return {
    ...base,
    ...(override.temperature !== undefined
      ? { temperature: override.temperature }
      : {}),
    ...(override.maxTokens !== undefined
      ? { maxTokens: override.maxTokens }
      : {}),
    ...(override.timeout !== undefined ? { timeout: override.timeout } : {}),
  };
}

/**
 * The head of a chain — used for slots NeuroLink cannot pool (summarization,
 * memory condensation, file summarization). Callers pass the first member that
 * a startup health probe reports reachable; `index` selects it.
 */
export function memberAt(
  chain: ModelChain,
  index = 0,
): ModelChainMember | undefined {
  return chain.members[index];
}

/** Human-readable chain, for `yama doctor` and run reports. */
export function describeChain(chain: ModelChain): string {
  return chain.members
    .map((member) =>
      [member.provider, member.model, member.region].filter(Boolean).join("/"),
    )
    .join(" → ");
}
