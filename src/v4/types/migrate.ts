/**
 * Types for the migrate layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ConfigNotice } from "./config.js";

export type MigrationFile = {
  path: string;
  content: string;
  /** Why this file exists, shown in the summary table. */
  from: string;
};

export type MigrationPlan = {
  files: MigrationFile[];
  /** Keys accepted by v3 that nothing reads any more. */
  dropped: string[];
  notices: ConfigNotice[];
  /** Content that has no v4 home and needs a human decision. */
  orphans: Array<{ from: string; suggestedPath: string; content: string }>;
};
