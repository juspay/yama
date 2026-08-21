/**
 * Types for the factory layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ResolvedConfig } from "./config.js";
import type { ModelChain, ModelSlotName } from "./model.js";

/** Every slot's chain, each inheriting the base `ai` chain when unset. */
export type ModelChains = Record<ModelSlotName, ModelChain> & {
  base: ModelChain;
};

/** Probes whether a candidate is usable. Injected so this stays testable. */
export type HealthProbe = (member: {
  provider: string;
  model?: string;
}) => Promise<boolean>;

export type BuildInstanceOptions = {
  chains: ModelChains;
  config: ResolvedConfig;
  /** Which chain drives this instance's main generate path. */
  slot: ModelSlotName;
  /** Sessions are per-agent; sub-agents and judges run without memory. */
  conversationMemory: boolean;
  /** Index of the probed-healthy member for the probe-only slots. */
  compactionMemberIndex?: number;
  memoryMemberIndex?: number;
};
