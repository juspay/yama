import type { VerdictBlockReason, VerdictConfig } from "./config.js";
/**
 * Options for the verdict policy in `core/verdict.ts`.
 */

export type DeriveVerdictOptions = {
  config: Required<Omit<VerdictConfig, "blockOn">> & {
    blockOn: VerdictBlockReason[];
  };
};
