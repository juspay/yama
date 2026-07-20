/**
 * Cross-run review state — the memory that makes run N+1 incremental instead
 * of a duplicate-posting fresh start. Persisted by a config-selected backend
 * (file / inline / CI-artifact wrappers); small enough to travel anywhere.
 */

import { ReviewCompletion } from "./review.js";

export type StateFindingStatus = "open" | "fixed" | "dismissed" | "carried";

export type ReviewStateFinding = {
  /** Stable content-derived id: hash(file|severity|category|title). */
  id: string;
  ruleId?: string;
  filePath?: string;
  line?: number | null;
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";
  title: string;
  status: StateFindingStatus;
  /** Run index (into ReviewState.runs) that first reported this finding. */
  firstReportedRun: number;
  /** How many consecutive runs the team left it unaddressed/dismissed. */
  dismissCount?: number;
};

export type ReviewStateRun = {
  at: string;
  sha?: string;
  decision: string;
  stopReason?: ReviewCompletion["stopReason"];
  newFindings: number;
  resolvedFindings: number;
};

export type ReviewState = {
  schemaVersion: 1;
  key: string;
  lastReviewedSha?: string;
  runs: ReviewStateRun[];
  findings: ReviewStateFinding[];
};

export type StateStoreKind =
  | "file"
  | "inline"
  | "github-artifact"
  | "jenkins-artifact";

export type StateConfig = {
  enabled?: boolean;
  /** Backend. `github-artifact`/`jenkins-artifact` wrap the file store and
   *  rely on the CI workflow to move the file across runs. */
  store?: StateStoreKind;
  /** Directory (file/artifact stores) holding `<key>.json` state files. */
  path?: string;
  /** Inline serialized state (SDK consumers pass state directly). */
  content?: string;
};
