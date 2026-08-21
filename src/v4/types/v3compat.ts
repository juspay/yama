import type { ConfigNotice } from "./config.js";
/**
 * Types for the v3compat layer.
 */

export type AdaptedV3 = {
  yama: Record<string, unknown>;
  mcp: Record<string, unknown>;
  review?: Record<string, unknown>;
  checks?: Record<string, unknown>;
  /** Content that has no v4 home and needs a human decision. */
  orphans: Array<{ from: string; suggestedPath: string; content: string }>;
  notices: ConfigNotice[];
};
