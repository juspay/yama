/**
 * The preparation gate (TASKS:Y4.6) — is there a checklist, and is it one you can work?
 *
 * The checklist is the spine of the whole run: Work picks items off it, delegates the big
 * ones, collects what the workers found, and Collate turns that into findings. Without one
 * there is nothing to delegate and nothing to collect, so a review with no checklist is not
 * a degraded review — it is an absent one. Two live runs proved both halves of that:
 *
 *   - curator PR #702: three pointers, every one scoped `<UNKNOWN>`, no items created. The
 *     work stage invented four items about not knowing what to review, closed them all, and
 *     the run APPROVED a change nobody had read.
 *   - yama PR #101: the stage ran out of steps twice, answered on the third try with a
 *     generic plan and no items at all, over a change of 15 files.
 *
 * So the gate asks two questions, in order, and both are about the CHANGE rather than
 * about the model's prose:
 *
 *   1. Is a checklist owed at all? A change with no reviewable file owes nothing.
 *   2. Does the checklist account for the change — every file named by some item's scope?
 *
 * What it deliberately does NOT do is say how many items there should be, how to group
 * them, or what to look for. A file is "accounted for" whether the item that claims it
 * plans a deep audit or plans to dismiss it; dismissing it is a decision the work stage
 * still has to close with a reason. The gate only refuses to let a file be forgotten.
 */
import { matchesAnyGlob } from "../util/glob.js";
import type {
  ChecklistCoverage,
  EngineTask,
  InsertionTask,
} from "../types/index.js";

/**
 * How many changed files a single unscoped item may stand for.
 *
 * `scope: []` means "the whole change" (`InsertionTaskSchema`), which is honest on a
 * two-file change and meaningless on a thirty-file one — and an item that claims
 * everything is exactly how a plan looks when the model never read the diff. Past this
 * many files an unscoped item is a cross-cutting note, not coverage: it stays on the
 * checklist, it just does not answer for any particular file.
 */
const WHOLE_CHANGE_MAX_FILES = 3;

/** Scope entries a model writes when it does not know — never a path in any repository. */
const PLACEHOLDER = /^[<(]?(unknown|tbd|n\/a|none|todo|\.\.\.)[>)]?$/i;

/**
 * A scope entry as a glob. A bare directory covers what is under it, which is how anyone
 * reading `src/stages` would take it — `matchesAnyGlob` alone would want `src/stages/**`.
 */
const asPatterns = (scope: readonly string[]): string[] =>
  scope
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !PLACEHOLDER.test(entry))
    .flatMap((entry) =>
      entry.includes("*") || entry.includes(".")
        ? [entry]
        : [entry, `${entry.replace(/\/$/, "")}/**`],
    );

/**
 * Which changed files the plan accounts for, and which it leaves out.
 *
 * Pure, and computed against the file list the run actually holds — the same list the
 * groundedness gate uses — so "covered" cannot mean anything but "named by an item".
 */
export const checkCoverage = (input: {
  /** Reviewable files: the change, after `review.exclude` has taken its part. */
  files: readonly string[];
  /** The plan's items, whose `scope` is the only place file information lives. */
  tasks: readonly InsertionTask[];
}): ChecklistCoverage => {
  // An item with NO scope claims the whole change. An item whose scope is `<UNKNOWN>`
  // tried to name something and named nothing — the #702 shape — and claims nothing at
  // all; treating the two alike would let the exact plan this gate exists to catch pass.
  const wholeChange =
    input.files.length <= WHOLE_CHANGE_MAX_FILES &&
    input.tasks.some((task) => task.scope.length === 0);
  const patterns = input.tasks.flatMap((task) => asPatterns(task.scope));
  const unresolved = [
    ...new Set(
      input.tasks
        .flatMap((task) => asPatterns(task.scope))
        .filter(
          (pattern) =>
            !input.files.some((file) => matchesAnyGlob(file, [pattern])),
        ),
    ),
  ];

  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const file of input.files) {
    if (wholeChange || matchesAnyGlob(file, patterns)) {
      covered.push(file);
    } else {
      uncovered.push(file);
    }
  }
  return { covered, uncovered, unresolved, complete: uncovered.length === 0 };
};

/**
 * What is wrong with this checklist. Empty means the run may proceed to Work.
 *
 * Existence is checked against the ENGINE's checklist rather than the plan's `tasks`,
 * because a plan is prose until `tasks_create` turns it into items — and the schema pins
 * `tasks` at `.min(1)`, so a plan that validates always claims one. The engine's checklist
 * is the thing that can be empty, and on PR #101 it was.
 */
export const checklistProblems = (input: {
  /** Reviewable files. None ⇒ no checklist is owed and this returns nothing. */
  files: readonly string[];
  /** The plan the agent wrote. */
  tasks: readonly InsertionTask[];
  /** The checklist the engine really holds. */
  checklist: readonly EngineTask[];
}): string[] => {
  if (input.files.length === 0) {
    return [];
  }
  if (input.checklist.length === 0) {
    return [
      `no checklist exists for a change of ${input.files.length} file(s) — the plan was written but tasks_create was never called, so there is nothing for the work stage to pick up, delegate, or report against`,
    ];
  }
  const coverage = checkCoverage({ files: input.files, tasks: input.tasks });
  if (coverage.complete) {
    return [];
  }
  return [
    `${coverage.uncovered.length} of ${input.files.length} changed file(s) are on no checklist item, so nothing in this review answers for them`,
  ];
};

/**
 * Whether what is left after every preparation round is fatal, or merely a gap to name.
 *
 * The two are not the same and treating them alike would be its own failure. A run with no
 * checklist, or one whose items answer for NOT ONE changed file, has nothing to work — the
 * `<UNKNOWN>`-scoped plan from curator PR #702 and the item-less plan from yama PR #101 are
 * both this shape, and both ended in a review of nothing. But a run that accounted for
 * ninety files of a hundred has reviewed ninety files, and killing it would throw away a
 * real review to punish an incomplete plan. That one proceeds, and the shell reports the
 * ten by name — a review that quietly narrows what it looked at is the failure this
 * project exists to prevent, and a review that says what it missed is not that.
 */
export const preparationFatal = (input: {
  files: readonly string[];
  tasks: readonly InsertionTask[];
  checklist: readonly EngineTask[];
}): boolean => {
  if (input.files.length === 0) {
    return false;
  }
  if (input.checklist.length === 0) {
    return true;
  }
  return (
    checkCoverage({ files: input.files, tasks: input.tasks }).covered.length ===
    0
  );
};

/** A bounded list — a nudge naming forty files teaches less than one naming eight. */
const NAMED = 12;

const listOf = (paths: readonly string[]): string[] => [
  ...paths.slice(0, NAMED).map((path) => `  ${path}`),
  ...(paths.length > NAMED ? [`  … and ${paths.length - NAMED} more`] : []),
];

/**
 * What the agent is told when preparation has not converged.
 *
 * Self-contained on purpose: it names the change, what is missing and what to do about it,
 * so it reads the same whether or not the conversation before it survived summarization.
 * It prescribes no content — which files need what is still the reviewer's judgement, and
 * "this file needs no review" is a legitimate answer as long as an item says so.
 */
export const buildPreparationNudge = (input: {
  problems: readonly string[];
  files: readonly string[];
  coverage: ChecklistCoverage;
  checklist: readonly EngineTask[];
  /** The run's ground truth, restated. */
  facts?: string;
  /** Last round: ask for the smallest thing that can still work. */
  final?: boolean;
}): string => {
  const lines = [
    "THE CHECKLIST IS NOT USABLE YET, so this review cannot start.",
    "",
    ...(input.facts !== undefined ? [input.facts, ""] : []),
    ...input.problems.map((problem) => `- ${problem}`),
    "",
  ];

  if (input.checklist.length === 0) {
    lines.push(
      "You have created no checklist items. The work stage takes its work from the items tasks_create returns — a plan that exists only in your answer is a plan nobody can work, delegate, or report against.",
      "",
    );
  } else {
    lines.push(
      "The checklist as the engine holds it:",
      ...input.checklist.map(
        (task) => `  ${task.id} [${task.status}] ${task.title}`,
      ),
      "",
    );
  }

  if (input.coverage.uncovered.length > 0) {
    lines.push(
      "Changed files no item accounts for:",
      ...listOf(input.coverage.uncovered),
      "",
    );
  }
  if (input.coverage.unresolved.length > 0) {
    lines.push(
      "Scope entries that match nothing in this change (a scope has to name real paths in the diff above):",
      ...listOf(input.coverage.unresolved),
      "",
    );
  }

  lines.push(
    input.final === true
      ? "LAST ROUND. Create one item per file or group above and nothing else — call tasks_create now, then answer with the plan and put the ids it returns in checklistIds. Do not read anything further first."
      : "Call tasks_create now for the work that is missing, then answer with the full plan and put the ids it returns in checklistIds. Give every item a scope naming the files it is about.",
    "",
    "A file that genuinely needs no review is still accounted for by an item saying so — the work stage closes that item with the reason. What you may not do is leave a file out: it is being merged either way.",
  );
  return lines.join("\n");
};
