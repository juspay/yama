import type { RankedFindings, TaskItem, Verdict } from "./findings.js";
import type { RunReport } from "./store.js";

/** How a run picks the change it reviews. */
export type RunMode = "local" | "branch" | "pr";

/** The resolved thing under review for one run. */
export type RunTarget =
  | { mode: "local" }
  | { mode: "branch"; branch: string; base?: string }
  /**
   * `base` is the ref the pull request is going into. Yama takes the DIFF from git
   * (deterministic, and no platform pays for it); the platform is only ever asked for
   * comments and the verdict. Absent, the base is resolved from `origin/HEAD`.
   */
  | { mode: "pr"; pr: number; base?: string };

/** Stages of one review run, in execution order. Delivery sits outside the task checklist. */
export type Stage =
  "warmup" | "taskInsertion" | "work" | "collate" | "delivery";

/**
 * Everything a stage needs to know about the run it belongs to.
 * TODO(TASKS:Y2.1): pool tier and the resolved config still hang off the caller.
 */
export type RunContext = {
  /** Identity of this run; the main session and the run report share it. */
  runId: string;
  target: RunTarget;
  /** Repository root the run operates on. */
  root: string;
  /** Absolute path of this run's store directory under `.yama/artifacts/`. */
  storeDir: string;
  /** Analyse only — deliver nothing to the platform. */
  dryRun: boolean;
  /** Cancellation for the whole run: stages, workers and background commands. */
  signal?: AbortSignal;
  /**
   * Called as each stage finishes, so a long run says where it is instead of going
   * silent for twenty minutes and printing everything at the end. Progress only — the
   * run report is still the record, and nothing here is load-bearing.
   */
  onProgress?: (line: string) => void;
};

/**
 * What one `yama review` run resolves to; `runReview` returns it and `--json` writes it.
 * The run report is carried along so the caller has the per-stage metrics and gate stats
 * without re-reading the store (TASKS:Y8.3).
 */
export type ReviewResult = {
  ranked: RankedFindings;
  verdict: Verdict;
  /** Checklist as it stood at the end — a closed item is a documented gap. */
  tasks: TaskItem[];
  report: RunReport;
};
