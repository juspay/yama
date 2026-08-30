/**
 * `yama learn` (TASKS:Y7.2) — the post-merge knowledge update, and the only path in Yama
 * that ever holds git write access.
 *
 * Everything model-facing is inferred from `src/stages/schema.ts`, as every other stage
 * payload is. Everything else here describes the deterministic half: which memory files
 * would be written, and the exact commit that would carry them.
 */
import type { z } from "zod";
import type {
  FindingResolutionSchema,
  LearnTriageSchema,
  MemoryFactSchema,
  ResolutionSchema,
} from "../stages/schema.js";
import type { EngineBankedRef } from "./engine.js";

/** What a merged pull request's reviewers did with one finding. */
export type FindingResolutionKind = z.infer<typeof ResolutionSchema>;

/** One finding and what the discussion settled about it. */
export type FindingResolution = z.infer<typeof FindingResolutionSchema>;

/** One durable fact, as it is written to its own file under `.yama/memory/`. */
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

/** The single structured triage pass learn makes over the merged discussion. */
export type LearnTriage = z.infer<typeof LearnTriageSchema>;

/** One memory file, rendered and ready to write. Paths are absolute. */
export type MemoryFile = {
  path: string;
  content: string;
};

/**
 * The commit `yama learn` would make, decided before anything is written (TASKS:Y7.2).
 *
 * It exists as data so that `--dry-run` is the same code path as the real thing minus the
 * writes: a test can assert exactly what would have been staged, committed and pushed
 * without a repository ever changing.
 */
export type GitWritePlan = {
  root: string;
  /** Branch the commit lands on. */
  branch: string;
  remote: string;
  /** Repo-relative paths to stage. Every one of them is under `.yama/`. */
  paths: string[];
  /** Commit subject, `[skip ci]` included — a learn commit must not re-trigger CI. */
  subject: string;
  body: string;
  push: boolean;
  /** Reasons this plan must not be executed. Non-empty means the write is refused. */
  refusals: string[];
};

/** What the git write actually did. Every field is observed, never assumed. */
export type GitWriteResult = {
  plan: GitWritePlan;
  /** Nothing was written, staged, committed or pushed. */
  dryRun: boolean;
  /** Files written to the work tree. */
  written: string[];
  /** Commit sha, present only when a commit was actually made. */
  commit?: string;
  pushed: boolean;
  /** Why nothing happened, when nothing did. */
  skipped?: string;
  /**
   * True when there was NOTHING TO WRITE — the knowledge this run distilled is
   * already committed. Distinct from `skipped`, which means there WAS something and
   * the write was refused or failed: a run that learned nothing new is a successful
   * run, and reporting it as a failure trains people to ignore a red learn job.
   */
  nothingToCommit?: boolean;
};

/** What one `yama learn` run came to (TASKS:Y7.2). */
export type LearnResult = {
  root: string;
  pr: number;
  /** Comments read off the merged pull request. */
  commentsRead: number;
  /** Findings the review left in the store's ledger for this pull request. */
  findingsKnown: number;
  triage?: LearnTriage;
  /** The whole comment thread, banked verbatim before a model saw a word of it. */
  banked?: EngineBankedRef;
  facts: MemoryFact[];
  files: MemoryFile[];
  write: GitWriteResult;
  /** Capabilities and pieces that were off; the same degradation matrix as a review. */
  notes: string[];
};
