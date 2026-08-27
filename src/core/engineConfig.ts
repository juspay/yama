/**
 * Config → engine wiring (TASKS:Y2.1's mappers).
 *
 * Two taxonomies meet here on purpose: `.yama/yama.yaml` speaks in fallback chains of
 * provider+model+region, and the engine speaks in one provider plus an ordered list of
 * model names. This module is the only place that knows both.
 */
import { POOL_TIER_CONCURRENCY } from "../config/index.js";
import { READ_ONLY_TOOLS } from "../tools/index.js";
import { SYSTEM_INSTRUCTION } from "./instruction.js";
import type {
  ChecksConfig,
  EngineCommandPolicy,
  EngineConfig,
  EngineModel,
  ModelChainLink,
  ResolvedConfig,
  RunContext,
} from "../types/index.js";

/**
 * Collapses a fallback chain onto the engine's shape. NeuroLink's `modelChain` swaps the
 * MODEL and keeps the provider, so only the leading run of same-provider links can be
 * expressed; a chain that changes provider mid-way needs a `providerFallback` callback.
 * TODO(TASKS:Y1.4): wire cross-provider links once the seam exposes that callback.
 */
export const toEngineModel = (chain: ModelChainLink[]): EngineModel => {
  const head = chain[0];
  if (head === undefined) {
    return {};
  }
  const sameProvider = chain
    .slice(
      0,
      chain.findIndex((link) => link.provider !== head.provider) + 1 ||
        chain.length,
    )
    .filter((link) => link.provider === head.provider);
  const models = sameProvider
    .map((link) => link.model)
    .filter((model): model is string => model !== undefined);
  return {
    provider: head.provider,
    ...(head.model !== undefined ? { model: head.model } : {}),
    ...(models.length > 1 ? { modelChain: models } : {}),
  };
};

/**
 * What the agent is allowed to execute: exactly the executables `checks.yaml` declares,
 * inside the repository. No declared check means no policy, which means every command is
 * refused — a repo that never declared a check never gets one run on its behalf.
 *
 * `checks` overrides what config read out of the working tree, because the commands a
 * review runs come from the BASE branch (TASKS:Y5.2): a change does not get to add the
 * command that reviews it.
 */
export const toCommandPolicy = (
  config: ResolvedConfig,
  checks?: ChecksConfig,
): EngineCommandPolicy | undefined => {
  const declared = (checks ?? config.checks)?.checks ?? [];
  const executables = [...new Set(declared.map((check) => check.command[0]))];
  return executables.length > 0
    ? { allowedExecutables: executables, cwdRoot: config.paths.root }
    : undefined;
};

/** Everything the seam needs to boot this run's main session. */
export const buildEngineConfig = (
  config: ResolvedConfig,
  run: RunContext,
  options: { checks?: ChecksConfig } = {},
): EngineConfig => {
  const policy = toCommandPolicy(config, options.checks);
  return {
    model: toEngineModel(config.chains.main),
    workerModel: toEngineModel(config.chains.worker),
    // A HANG detector, not a budget (PLAN.md §1: the run is bounded by work). Left
    // unset, the engine's own scaled default (~180s) governed the largest turn of the
    // first live trial and cut a slow self-hosted model off mid-answer. Self-hosted
    // deployments answer far slower than hosted APIs without being broken.
    timeoutMs: 600_000,
    // Explicit, because ABSENT is what bites: a hosted vLLM defaults an uncapped
    // request to half the context window as OUTPUT (128k of 256k), and a live run's
    // fifth work round crossed the other half with input — the review died on input
    // 128001. No stage's structured answer comes anywhere near 32k; the head-room is
    // for input.
    maxTokens: 32_000,
    systemPrompt: SYSTEM_INSTRUCTION,
    storeDir: run.storeDir,
    // TASKS:Y5.1 — a worker reads and reports. It never posts, and it never delegates.
    workerTools: READ_ONLY_TOOLS,
    maxConcurrentWorkers: POOL_TIER_CONCURRENCY[config.yama.pool.tier],
    ...(policy !== undefined ? { commandPolicy: policy } : {}),
  };
};
