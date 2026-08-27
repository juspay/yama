/**
 * Where one run's artifacts live (TASKS:Y2.3, PLAN.md section 4).
 *
 * `.yama/artifacts/` is a CI artifact, never committed: it is carried between runs so a
 * recurring review can read what the last one found, and an absent store simply means the
 * run rebuilds what it needs.
 */
import { join, resolve } from "node:path";
import type { RunStorePaths, RunTarget } from "../types/index.js";

/** Run-store root, relative to the repository root. */
export const STORE_ROOT = ".yama/artifacts";

/** Entries inside one run's store directory. */
export const STORE_ENTRIES = {
  stages: "stages",
  reports: "reports",
  checks: "checks",
  workers: "workers",
  ledger: "findings.json",
  run: "run.json",
} as const;

/** Per-run directory name: `pr-42`, `branch-feat-x`, or `local`. */
export const runStoreSlug = (target: RunTarget): string => {
  switch (target.mode) {
    case "pr":
      return `pr-${target.pr}`;
    case "branch":
      return `branch-${target.branch.replace(/[^\w.-]+/g, "-")}`;
    default:
      return "local";
  }
};

/** Sub-paths of an already-resolved run directory — the seam only ever gets the directory. */
export const storePathsForDir = (dir: string): RunStorePaths => ({
  dir,
  stagesDir: join(dir, STORE_ENTRIES.stages),
  reportsDir: join(dir, STORE_ENTRIES.reports),
  checksDir: join(dir, STORE_ENTRIES.checks),
  workersDir: join(dir, STORE_ENTRIES.workers),
  ledgerFile: join(dir, STORE_ENTRIES.ledger),
  runFile: join(dir, STORE_ENTRIES.run),
});

/** Absolute locations for one run, derived from the repository root and the target. */
export const resolveStorePaths = (
  root: string,
  target: RunTarget,
): RunStorePaths =>
  storePathsForDir(join(resolve(root), STORE_ROOT, runStoreSlug(target)));
