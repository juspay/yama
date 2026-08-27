/**
 * Gate shapes (TASKS:Y4). Gates are the deterministic half of a run: between two agentic
 * stages, plain code checks something the model is not allowed to decide for itself —
 * whether the output validated, whether the checklist is finished, whether a finding was
 * already posted, whether a post actually happened.
 *
 * Every gate here returns a RESULT rather than throwing, except the schema gate, whose
 * only honest outcome after a retry is the failure the session already banked. A gate
 * result is data: it goes in the run report and it reads the same in a test.
 */
import type { PriorFindingReview } from "./stages.js";
import type { Engine, EngineTask } from "./engine.js";
import type { Finding } from "./findings.js";
import type { SessionCheckpointRequest, SessionRunner } from "./session.js";

/** One schema-gated stage call: the checkpoint, plus how many retries it may have. */
export type SchemaGateRequest<T> = {
  session: SessionRunner;
  request: SessionCheckpointRequest<T>;
  /** Extra attempts after the first. Default 1 — TASKS:Y4.1 asks for one agentic retry. */
  retries?: number;
};

/** What the completeness gate reads off the checklist (TASKS:Y4.2). */
export type ChecklistGateResult = {
  /** No item is unfinished and no closed item is unexplained. */
  complete: boolean;
  /** The checklist as the engine holds it. */
  tasks: EngineTask[];
  /** Still `pending` or `in_progress` — an incomplete review. */
  pending: EngineTask[];
  /** `closed` with no reason. Abandoning an item silently is also incomplete. */
  unexplained: EngineTask[];
};

/** Where the completeness gate reads from, and how it hands work back to the agent. */
export type ChecklistGateRequest = {
  engine: Engine;
  sessionId: string;
  /**
   * Puts the unfinished items back in front of the agent (finish, delegate, or close with
   * a reason). Called once per round; omitted means "report, do not nudge".
   */
  nudge?: (prompt: string) => Promise<void>;
  /** Nudges before giving up and reporting an incomplete checklist. Default 1. */
  maxRounds?: number;
};

/** A comment already on the target, as read back through the platform (TASKS:Y4.3). */
export type ExistingComment = {
  id: string;
  body: string;
};

/** A finding bound to the comment that carries it — the marker is what binds them. */
export type PostedComment = {
  findingId: string;
  commentId: string;
};

/** Marker dedup, decided before anything is posted (TASKS:Y4.3). */
export type MarkerDedupResult = {
  /** Findings with no marker on the target yet. Only these get posted. */
  post: Finding[];
  /** Findings whose marker is already on the target, with the comment carrying it. */
  alreadyPosted: PostedComment[];
  /**
   * Marker ids on the target that this run did not find again — a previous run's
   * findings, now fixed or moot. Y7.1 classifies them; the gate only reports them.
   */
  stale: string[];
};

/** Posted = confirmed (TASKS:Y4.4): what the platform's own results prove happened. */
export type PostingConfirmation = {
  /** Findings whose comment id came back from the platform. */
  posted: PostedComment[];
  /** Finding ids with no confirming result. The run must say so out loud. */
  unposted: string[];
  /** Comment ids that came back carrying no known marker — posted, unattributable. */
  unmatched: string[];
  /** Everything intended was confirmed, and nothing unexpected was created. */
  ok: boolean;
};

/**
 * What a recurring run made of the findings the previous review left open (TASKS:Y7.1).
 *
 * The agent classifies — only something that has read the current code can say whether a
 * problem is fixed — and this gate holds it to accounting for EVERY prior id. A finding it
 * said nothing about stays OPEN: silence is not evidence that something was fixed, and the
 * verdict is taken over the full open set, so the safe direction is the honest one.
 */
export type PriorFindingsGateResult = {
  /** Still open: re-found this run, claimed still-open, or never accounted for. */
  open: Finding[];
  /** Ids the agent showed are fixed in the current code. */
  fixed: string[];
  /** Ids the change no longer touches — the finding is about code that is not in it. */
  moot: string[];
  /** Prior ids the agent never classified. Carried as open, and reported. */
  unresolved: string[];
  /** The agent's own account, verbatim, for the run report and the store. */
  reviewed: PriorFindingReview[];
};

/** One finding dropped by the groundedness gate, with the reason a human can read. */
export type UngroundedFinding = {
  id: string;
  file: string;
  reason: string;
};
