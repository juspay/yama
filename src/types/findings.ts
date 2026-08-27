/**
 * Yama's core review domain: what the agent finds, how the run ranks it, what the
 * checklist tracks, what a worker hands back, and the envelope every stage banks.
 * Self-contained on purpose — nothing here depends on the run or engine taxonomy.
 */
import type { SEVERITIES } from "../util/severity.js";

/**
 * Severity taxonomy, most serious first. Derived from the ordered array the ranking and
 * the validator share, so the type cannot list a severity the policy cannot rank. Block
 * thresholds are config (TASKS:Y5.5).
 */
export type Severity = (typeof SEVERITIES)[number];

/** Where a finding's claim comes from, so a reviewer can check it without re-reading the PR. */
export type FindingEvidence = {
  kind: "code" | "check" | "rule" | "comment";
  /** `path:line-line` for code, check name for a check run, rule id, or comment id. */
  ref: string;
  /** Short quoted material. Anything long stays in the run store (PLAN.md section 2.3). */
  excerpt?: string;
  /** Run-store path of the banked artifact this excerpt was cut from. */
  artifact?: string;
};

/**
 * One reviewable issue. `id` is stable across runs — it is what the
 * `<!-- yama:finding:id -->` marker carries, so recurring runs dedupe on it (TASKS:Y4.3).
 */
export type Finding = {
  id: string;
  file: string;
  line: number;
  severity: Severity;
  /** Free-form until the taxonomy is settled — TODO(TASKS:Y5.5). */
  category: string;
  /** One line: what is wrong. */
  summary: string;
  /** What breaks if this ships. */
  impact: string;
  /** Concrete change to make. Absent when the fix is a judgement call. */
  fix?: string;
  evidence: FindingEvidence[];
  /** 0..1. Used to drop low-confidence noise before posting. */
  confidence?: number;
};

/** Terminal output of the collate stage (PLAN.md section 1, TASKS:Y3.4). */
export type RankedFindings = {
  /** Most serious first. */
  findings: Finding[];
  /** Finding ids dropped in dedupe, mapped to the id they merged into (TASKS:Y4.3). */
  merged?: Record<string, string>;
};

/** What the run decided. `comment` posts findings without gating the merge. */
export type VerdictDecision = "approve" | "block" | "comment";

/** Output of the verdict policy — a pure function of (findings, config) (TASKS:Y5.5). */
export type Verdict = {
  decision: VerdictDecision;
  /** Why, in the policy's own words. Empty only for a clean approve. */
  reasons: string[];
};

/** Checklist states. `closed` means "will not be done", and always carries a reason. */
export type TaskStatus = "pending" | "in_progress" | "done" | "closed";

/**
 * One item on the run's review checklist (NeuroLink task primitive, TASKS:N1.1).
 * Pending items are an incomplete review — the completeness gate enforces it (TASKS:Y4.2).
 */
export type TaskItem = {
  id: string;
  title: string;
  status: TaskStatus;
  /** Progress note; required in practice when `status` is `closed`. */
  note?: string;
};

/** How a delegated worker ended. `cut_short` is resumable via a continuation handle. */
export type WorkerStatus = "completed" | "failed" | "cut_short";

/**
 * A delegated worker's result (TASKS:N3.1). The main session sees `summary` inline and
 * reads `reportPath` back on demand, so evidence never dies to context pressure.
 */
export type WorkerReport = {
  workerId: string;
  /** Checklist item this worker was delegated (TASKS:Y3.3). */
  taskId: string;
  status: WorkerStatus;
  /** Bounded text injected into the main conversation. */
  summary: string;
  /** Run-store path of the full report. */
  reportPath: string;
  findings: Finding[];
  /** Set when `status` is not `completed`. */
  error?: string;
};

/**
 * Envelope banked per stage (TASKS:Y2.3). `TStage` stays a parameter so this module
 * never imports the run taxonomy; callers pass their own `Stage` union.
 */
export type StageOutput<TStage extends string, TPayload> = {
  stage: TStage;
  /** Whatever the stage's `generate({ schema })` returned. */
  data: TPayload;
  /** Run-store path this envelope was written to; absent until banked. */
  path?: string;
  /** Complete, unrepaired and schema-valid JSON. The schema gate reads this (TASKS:Y4.1). */
  trusted?: boolean;
  /**
   * The engine salvaged a partial JSON body (`jsonTruncated`). The schema gate rejects
   * the stage and retries once (TASKS:Y4.1).
   */
  truncated?: boolean;
  /** ISO-8601 completion time. */
  completedAt: string;
};
