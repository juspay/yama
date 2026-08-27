/**
 * A stage that produced nothing usable (TASKS:Y4.1 will retry these once, agentically).
 *
 * The verbatim model output is banked BEFORE this is thrown, so the failure always comes
 * with a file to read — a stage can fail, but it cannot fail invisibly.
 */
import type { Stage } from "../types/index.js";

export class StageError extends Error {
  readonly stage: Stage;
  /** Run-store path of the verbatim output that failed to validate. */
  readonly rawPath: string;

  constructor(stage: Stage, message: string, rawPath: string) {
    super(`stage "${stage}": ${message}\n  banked output: ${rawPath}`);
    this.name = "StageError";
    this.stage = stage;
    this.rawPath = rawPath;
  }
}
