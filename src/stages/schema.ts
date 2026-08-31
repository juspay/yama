/**
 * Structured output schemas for the agentic stages (TASKS:Y3.1, Y3.2).
 *
 * These are the contracts the model is held to: each one is passed straight to
 * `engine.generateStructured`, and `src/types/stages.ts` infers its type from here, so the
 * prompt, the validator and the TypeScript shape can never drift apart. Nothing in this
 * file may import the types barrel — the inference runs the other way.
 *
 * Objects are lenient about EXTRA keys and strict about the ones that matter: an extra key
 * from a chatty model is noise, a missing `title` is a broken stage. No `.default()` and no
 * `.catch()` either — several providers reject those in constrained decoding.
 */
import { z } from "zod";
import { SeverityLevelSchema } from "../util/severity.js";

const Line = z.string().min(1);

/* ---------------------------------------------------------------- warm up */

/** One rule the agent lifted out of the rulebook, with where it came from. */
export const BriefRuleSchema = z.object({
  /** Stable id: the rulebook's own id when it has one, else a slug of the statement. */
  id: Line,
  /** The rule in one sentence, as the reviewer must apply it. */
  statement: Line,
  /** Repo-relative path (plus heading/line when useful) the statement came from. */
  source: Line,
  severity: SeverityLevelSchema.optional(),
});

/**
 * The distilled personality of this repository's review (PLAN.md section 1, WARMUP).
 * Workers get a slice of this, never the raw rulebook.
 */
export const OperatingBriefSchema = z.object({
  /** How this repo wants to be reviewed, in the agent's own words. */
  persona: Line,
  rules: z.array(BriefRuleSchema),
  /** What this repo cares about most, most important first. */
  focusAreas: z.array(Line),
  /** Every file actually read, repo-relative — the audit trail for the brief. */
  sources: z.array(Line),
  /** What the rulebook does NOT say, so a later stage does not invent it. */
  gaps: z.array(z.string()),
});

/* --------------------------------------------------------- task insertion */

/** One review pointer the agent commits to finishing this run. */
export const InsertionTaskSchema = z.object({
  /** Imperative and concrete: "check the new /token endpoint against the auth rules". */
  title: Line,
  /** Why this change needs it — the evidence in the diff. */
  rationale: Line,
  /** Files or globs the task is about. Empty means "the whole change". */
  scope: z.array(z.string()),
  /** The agent's own call: big enough to hand to a worker (TASKS:Y3.3). */
  delegate: z.boolean(),
});

/**
 * What became of a finding the previous review left open (TASKS:Y7.1).
 *
 * `fixed` is a claim about the current code and has to be earned by reading it. `moot`
 * means the change no longer touches what the finding was about. Anything else is `open` —
 * and so is anything the agent says nothing about, because the verdict is taken over the
 * full open set and silence is not evidence.
 */
export const PriorFindingStateSchema = z.enum(["fixed", "open", "moot"]);

export const PriorFindingReviewSchema = z.object({
  /** The prior finding's id, exactly as the previous run wrote it. */
  id: Line,
  state: PriorFindingStateSchema,
  /** What was actually checked. "Looks fine" is not a reason; the line that changed is. */
  reason: Line,
});

/** The checklist this run must finish, plus the reading of the change that produced it. */
export const InsertionPlanSchema = z.object({
  /** What this change does, from the diff — not from the PR title. */
  changeSummary: Line,
  /** Where the risk sits, most serious first. */
  riskAreas: z.array(z.string()),
  tasks: z.array(InsertionTaskSchema).min(1),
  /**
   * The ids `tasks_create` handed back. The shell cross-checks these against the real
   * checklist, so a plan the agent never actually created is caught on the spot.
   */
  checklistIds: z.array(z.string()),
  /**
   * One entry per finding the previous review left open (TASKS:Y7.1). Optional because a
   * first review has none to account for; on a recurring run the shell holds the agent to
   * covering every id, and carries anything it skipped as still open.
   */
  priorFindings: z.array(PriorFindingReviewSchema).optional(),
});

/* ---------------------------------------------------------------- findings */

/**
 * Where a finding's claim comes from. Evidence is not decoration: a finding whose ref
 * nobody can open is an opinion, and this run does not post opinions.
 */
export const FindingEvidenceSchema = z.object({
  kind: z.enum(["code", "check", "rule", "comment"]),
  /** `path:line` for code, the check id for a check, the rule id, or a comment id. */
  ref: Line,
  /** Short quoted material. Anything long stays banked and is referenced instead. */
  excerpt: z.string().optional(),
  /** artifactId of the banked payload this excerpt was cut from. */
  artifact: z.string().optional(),
});

/**
 * One reviewable issue, exactly as the model must report it.
 *
 * This is the single definition of the finding contract: `src/store/schema.ts` validates
 * the ledger with this same schema, held to the hand-written `Finding` type, so what the
 * model produces and what the store keeps cannot drift apart.
 */
export const FindingSchema = z.object({
  /** Stable across runs — the `<!-- yama:finding:id -->` marker carries it (TASKS:Y4.3). */
  id: Line,
  file: Line,
  line: z.number().int(),
  severity: SeverityLevelSchema,
  category: Line,
  /** One line: what is wrong. */
  summary: Line,
  /** What breaks if this ships. */
  impact: Line,
  /** The concrete change to make; omitted when the fix is a judgement call. */
  fix: z.string().optional(),
  evidence: z.array(FindingEvidenceSchema),
  /** 0..1. The verdict policy drops anything under the configured floor. */
  confidence: z.number().min(0).max(1).optional(),
});

/* ------------------------------------------------------------ work the list */

/** What the agent did with one checklist item, and what came of it. */
export const WorkedTaskSchema = z.object({
  /** Id from the checklist, as `tasks_list` reports it. */
  taskId: Line,
  /** Who did the work: the main agent itself, or a background worker. */
  handledBy: z.enum(["self", "worker"]),
  /** The worker that did it, when it was delegated. */
  workerId: z.string().optional(),
  /** What the investigation concluded — including "this area is clean". */
  note: Line,
  /** Ids of the findings this item produced. Empty when it found nothing. */
  findingIds: z.array(z.string()),
});

/** One round of working the checklist (TASKS:Y3.3). */
export const WorkOutcomeSchema = z.object({
  findings: z.array(FindingSchema),
  worked: z.array(WorkedTaskSchema),
  /** What could not be settled, so the collate stage knows where the holes are. */
  openQuestions: z.array(z.string()),
});

/* ------------------------------------------------------ collate and decide */

/** A duplicate folded into the finding that survived it. */
export const MergedFindingSchema = z.object({
  /** The id that was dropped. */
  from: Line,
  /** The id it was merged into. */
  into: Line,
});

/**
 * The collated result (TASKS:Y3.4). The model dedupes and ranks; it does NOT decide the
 * verdict — that is `decideVerdict`, a pure function of these findings and the config.
 */
export const CollationSchema = z.object({
  /** Deduped, most serious first. Ids stay stable across runs. */
  findings: z.array(FindingSchema),
  merged: z.array(MergedFindingSchema),
  /** One paragraph: what was reviewed, and what it amounts to. */
  summary: Line,
});

/* ---------------------------------------------------------------- delivery */

/**
 * The agent's own account of Delivery (TASKS:Y3.5). It is a CLAIM: the shell confirms
 * every line of it against the platform's tool results (TASKS:Y4.4), and where the two
 * disagree the tool results win. It is asked for anyway, because what the agent believed
 * it did is the fastest way to read a delivery that went wrong.
 */
export const DeliveryReportSchema = z.object({
  /** Finding ids it believes it posted an inline comment for. */
  posted: z.array(z.string()),
  /** What it could not post, and why. */
  failed: z.array(z.object({ findingId: Line, reason: Line })),
  summaryPosted: z.boolean(),
  verdictSet: z.boolean(),
  /**
   * True when this platform has NO review state that means the decision — several have
   * approve and needs-work but nothing meaning "commented", and forcing one of those on
   * would say something the review did not decide. Saying so is an outcome; leaving the
   * state unset WITHOUT saying so is still a failure.
   */
  verdictStateless: z.boolean().optional(),
  described: z.boolean(),
  /** Anything a human should know about how delivery went. */
  notes: z.string(),
});

/* ------------------------------------------------------------------- learn */

/** What the reviewers on a merged pull request did with one of Yama's findings. */
export const ResolutionSchema = z.enum([
  /** A human agreed, and the change was made. */
  "accepted",
  /** A human said no. The reason is what becomes a suppression. */
  "dismissed",
  /** Nobody engaged with it either way. */
  "unanswered",
]);

/** One finding, and what the merged pull request's discussion settled about it. */
export const FindingResolutionSchema = z.object({
  findingId: Line,
  resolution: ResolutionSchema,
  /** Comment ids the judgement rests on. Empty means it was inferred from the merge. */
  evidence: z.array(z.string()),
  /** One line: what the reviewers actually said. */
  note: Line,
});

/**
 * One durable fact this repository just taught the reviewer (TASKS:Y7.2).
 *
 * A fact is a decision, not an observation: something a future review should apply. It is
 * written to its own file under `.yama/memory/`, so a human can read it, edit it or delete
 * it — the memory is a document, not a database.
 */
export const MemoryFactSchema = z.object({
  /** Stable, kebab-case: the file name and the identity across learn runs. */
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case, letters and digits only"),
  kind: z.enum([
    /** Something true about this codebase a reviewer needs to know. */
    "knowledge",
    /** A rule the repository follows that the rulebook does not state. */
    "convention",
    /** A class of finding this repository has decided it does not want raised. */
    "suppression",
  ]),
  /** The fact in one sentence, in the imperative where it is a rule. */
  statement: Line,
  /** Why the repository decided this — quoting the reviewer where they said it. */
  rationale: Line,
  /** Paths or globs it applies to. Empty means the whole repository. */
  scope: z.array(z.string()),
  /** Comment ids, finding ids or file paths this was drawn from. */
  sources: z.array(z.string()),
});

/**
 * The single triage pass `yama learn` makes (TASKS:Y7.2). One structured call: what the
 * discussion settled about each finding, and the facts worth keeping. Everything after
 * this is deterministic — rendering files, staging them, and one commit.
 */
export const LearnTriageSchema = z.object({
  resolutions: z.array(FindingResolutionSchema),
  facts: z.array(MemoryFactSchema),
  /** One paragraph: what this pull request taught, for the commit body. */
  summary: Line,
});
