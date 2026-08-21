/**
 * Types for the gate layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ChangeSet } from "./changes.js";
import type { GuardRule } from "./config.js";
import type { IdentifiedFinding } from "./findings.js";

export type GateInput = {
  /** Candidates from this submission. Ids are assigned here if absent. */
  findings: Array<Omit<IdentifiedFinding, "id"> & { id?: string }>;
  /** The parsed diff. Absent means structural checks are skipped. */
  changeSet?: ChangeSet;
  /** Finding ids already posted on this PR, from marker scan plus state. */
  alreadyReported: ReadonlySet<string>;
  /** Ids accepted earlier in THIS run. */
  alreadyAccepted: ReadonlySet<string>;
  /** Learned false positives. */
  suppressed: ReadonlySet<string>;
  /** Findings a configured check already reported, keyed `path:line`. */
  checkFlagged?: ReadonlySet<string>;
  /** Confidence scores by finding id. Absent id means "not yet judged". */
  confidence?: ReadonlyMap<string, number>;
  confidenceThreshold: number;
  /** Only comment on lines the PR changed. */
  changedLinesOnly: boolean;
  /** Guards that raise the severity floor for matching paths. */
  guards?: GuardRule[];
  dryRun: boolean;
};
