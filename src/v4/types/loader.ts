/**
 * Types for the loader layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ResolvedConfig } from "./config.js";

export type LoadOptions = {
  /** Repo root. Defaults to the process working directory. */
  projectRoot?: string;
  /** Explicit config directory or v3 file. Overrides discovery. */
  configPath?: string;
  /** SDK-level overrides, highest precedence. */
  overrides?: Partial<ResolvedConfig>;
  env?: NodeJS.ProcessEnv;
};
