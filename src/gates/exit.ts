/**
 * Verdict → process exit code (TASKS:Y4.5).
 *
 * The numbers are a CI contract (`src/cli/exitCodes.ts`): add codes, never renumber them.
 */
import { EXIT_CODES } from "../cli/exitCodes.js";
import type { Verdict } from "../types/index.js";

/**
 * Only `block` gates the merge. `comment` posts findings and still exits 0, so a noisy
 * review never fails a pipeline on its own — that is the whole difference between the two.
 */
export const exitCodeFor = (verdict: Verdict): number =>
  verdict.decision === "block" ? EXIT_CODES.block : EXIT_CODES.ok;
