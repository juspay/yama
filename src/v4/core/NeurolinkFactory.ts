/**
 * NeuroLink instance construction — the one place model chains become runtime
 * configuration.
 *
 * The important asymmetry, verified against NeuroLink 11.2.3:
 *
 *   - The MAIN generate path pools natively. `modelPool` gives error-class-aware
 *     failover with per-member cooldown, so a rate-limited member steps aside
 *     instead of failing the run.
 *   - Summarization (which context compaction uses), memory condensation, and
 *     file summarization each take a SINGLE provider+model. There is no native
 *     pool for them.
 *
 * For those three, a chain is resolved once by a startup health probe and the
 * first reachable member is passed. That is failover at run start, not mid-run,
 * and `describeSlotEnforcement` reports the difference so `yama doctor` can say
 * so plainly rather than implying every slot fails over.
 */

import type {
  BuildInstanceOptions,
  HealthProbe,
  ModelChain,
  ModelChains,
  ModelSlotEnforcement,
  ModelSlotName,
  ResolvedConfig,
} from "../types/index.js";
import {
  memberAt,
  normalizeModelChain,
  resolveSlot,
} from "../config/ModelChain.js";

/** Which slots NeuroLink can pool, and which are resolved by probe. */
export const SLOT_ENFORCEMENT: Record<ModelSlotName, ModelSlotEnforcement> = {
  review: "pool",
  subAgent: "pool",
  judge: "pool",
  extraction: "pool",
  compaction: "probe",
  memory: "probe",
  // Accepted, and read by nothing. The description is written by the reviewer
  // inside the review session — deliberately, because only that session has the
  // change in context — so it runs on `ai.review`. The scorecard is arithmetic
  // over what the run recorded and makes no model call at all. Both keys stay
  // valid so existing configs keep loading; `doctor` says plainly that setting
  // them changes nothing, which is the honest alternative to quietly ignoring
  // them or to breaking a config that already has them.
  description: "unused",
  scorecard: "unused",
};

export function resolveModelChains(config: ResolvedConfig): ModelChains {
  const base = normalizeModelChain(config.ai, "ai");
  const slot = (name: ModelSlotName): ModelChain =>
    resolveSlot(base, config.ai[name], `ai.${name}`);

  return {
    base,
    review: slot("review"),
    subAgent: slot("subAgent"),
    judge: slot("judge"),
    scorecard: slot("scorecard"),
    description: slot("description"),
    extraction: slot("extraction"),
    compaction: slot("compaction"),
    memory: slot("memory"),
  };
}

/**
 * Pick the first reachable member of a chain.
 *
 * Falls back to the head when every probe fails: a slot with no working member
 * is a real problem, but it is the caller's problem to report — silently
 * returning nothing here would turn a degraded auxiliary pass into a crash in an
 * unrelated part of the run.
 */
export async function probeChain(
  chain: ModelChain,
  probe: HealthProbe,
): Promise<{ index: number; healthy: boolean }> {
  for (let index = 0; index < chain.members.length; index += 1) {
    try {
      if (await probe(chain.members[index])) {
        return { index, healthy: true };
      }
    } catch {
      // A probe that throws is a failed probe, not a failed run.
    }
  }
  return { index: 0, healthy: false };
}

/** NeuroLink's `modelPool` shape, built from a chain. */
export function toModelPool(chain: ModelChain): Record<string, unknown> {
  return {
    members: chain.members.map((member) => ({
      provider: member.provider,
      ...(member.model ? { model: member.model } : {}),
      ...(member.region ? { region: member.region } : {}),
      ...(member.weight !== undefined ? { weight: member.weight } : {}),
    })),
    strategy: chain.pool.strategy,
    cooldownMs: chain.pool.cooldownMs,
    maxAttempts: chain.pool.maxAttempts,
  };
}

/**
 * Build the constructor config for one NeuroLink instance.
 *
 * Returned as a plain object rather than a live instance so the wiring is
 * testable without a provider, and so callers can merge instance-specific
 * options (worker tool-registry sharing, credentials) before constructing.
 */
export function buildInstanceConfig(
  options: BuildInstanceOptions,
): Record<string, unknown> {
  const { chains, config, slot } = options;

  const instance: Record<string, unknown> = {
    modelPool: toModelPool(chains[slot]),
    // Tool schemas are deferred behind a search catalog rather than shipped in
    // full. Combined with the static system instruction, this is what keeps the
    // input small enough for smaller models to stay coherent — measured at
    // roughly 2.4k tokens on the wire against a server advertising 44 tools.
    tools: {
      discovery: true,
      enableBashTool: false,
      // Architecture §4, local tool policy: every read the agent makes is
      // sandboxed to the repository root. The runtime ships its own file tools
      // which are NOT sandboxed and which duplicate Yama's read_file /
      // list_files / search_code — two tools doing the same thing differently is
      // a worse prompt and a hole in the sandbox at once.
      //
      // `exclude` is used rather than the runtime's `disableBuiltinTools` flag
      // because that flag is measurably inert: set on the config or via
      // NEUROLINK_DISABLE_BUILTIN_TOOLS, the built-ins still ship. The names
      // come from config (rule 7) so a runtime that renames them is a config
      // edit, not a patch.
      ...(config.ai.excludeRuntimeTools &&
      config.ai.excludeRuntimeTools.length > 0
        ? { exclude: config.ai.excludeRuntimeTools }
        : {}),
    },
    mcp: {
      cache: { enabled: true },
      outputLimits: {
        strategy: "externalize",
        maxBytes: 100_000,
        warnBytes: 50_000,
      },
    },
  };

  if (!options.conversationMemory) {
    instance.conversationMemory = { enabled: false };
    return instance;
  }

  const compaction = memberAt(
    chains.compaction,
    options.compactionMemberIndex ?? 0,
  );
  const memory = memberAt(chains.memory, options.memoryMemberIndex ?? 0);

  const conversationMemory: Record<string, unknown> = {
    enabled: true,
    // Compaction keeps a long file-by-file review inside the window. Without it
    // a large PR ends the session rather than compacting it.
    contextCompaction: { enabled: true, threshold: 0.8 },
  };

  if (compaction) {
    // NeuroLink's compaction has no model field of its own; it uses the
    // summarization pair. Single-valued, hence the probe.
    conversationMemory.summarizationProvider = compaction.provider;
    if (compaction.model) {
      conversationMemory.summarizationModel = compaction.model;
    }
  }

  if (memory && config.ai.memory) {
    conversationMemory.memory = {
      enabled: true,
      neurolink: {
        provider: memory.provider,
        ...(memory.model ? { model: memory.model } : {}),
      },
    };
  }

  instance.conversationMemory = conversationMemory;
  return instance;
}

/** One row per slot for `yama doctor`. */
export function describeSlotEnforcement(chains: ModelChains): Array<{
  slot: ModelSlotName;
  enforcement: ModelSlotEnforcement;
  chain: string;
}> {
  return (Object.keys(SLOT_ENFORCEMENT) as ModelSlotName[]).map((slot) => ({
    slot,
    enforcement: SLOT_ENFORCEMENT[slot],
    chain: chains[slot].members
      .map((member) =>
        [member.provider, member.model].filter(Boolean).join("/"),
      )
      .join(" → "),
  }));
}
