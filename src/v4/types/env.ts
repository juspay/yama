/**
 * Types for the env layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

export type EnvLoadResult = {
  loaded: boolean;
  /** Variable NAMES applied. Never values — this is printed. */
  applied: string[];
  reason?: string;
};
