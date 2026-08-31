/**
 * The completeness gate (TASKS:Y4.2) — pending tasks are an incomplete review.
 *
 * This is the contract that makes an agentic review trustworthy (PLAN.md section 1): the
 * agent writes its own checklist, but it does not get to decide when the checklist is
 * finished. The shell reads the state the engine holds — not the conversation, which
 * compaction rewrites — and puts anything unfinished back in front of the agent, to
 * finish, delegate, or close WITH A REASON.
 *
 * A closed item with no reason is treated as unfinished too. "Closed" is how a review
 * documents a gap; without the reason it is just a task quietly dropped.
 */
import type {
  ChecklistGateRequest,
  ChecklistGateResult,
  EngineTask,
  EngineTaskState,
} from "../types/index.js";

/** Nudges before the gate gives up and reports an incomplete checklist. */
const DEFAULT_MAX_ROUNDS = 1;

const describe = (task: EngineTask): string =>
  `  ${task.id} [${task.status}] ${task.title}`;

/** Reads a checklist state as a gate result. Pure — the whole judgement is four filters. */
/** How far along a status is, so a group of identical items reports its best state. */
const PROGRESS: Record<string, number> = {
  done: 3,
  closed: 2,
  in_progress: 1,
  pending: 0,
};

/**
 * The checklist as DISTINCT work (TASKS:Y4.2).
 *
 * `tasks_create` appends, and a model that calls it twice with overlapping titles gets
 * two items for one piece of work. Measured on this repository's own pull request: 327
 * items over 86 distinct titles — one of them created seventeen times — from a plan whose
 * own 25 tasks were all unique. The work stage would then have to render all 327 and the
 * completeness gate would demand every one of them be settled, so a stutter in one tool
 * call becomes an unfinishable review.
 *
 * Two items with the same title are the same task; nothing downstream can tell them apart,
 * and neither can a human reading the report. So the shell reads the checklist as the set
 * of distinct titles, each carrying the furthest state any of its copies reached — work
 * done once is done, whichever copy it was recorded against.
 *
 * The agent is not corrected for this and nothing is deleted: the engine keeps whatever it
 * was told, and the shell simply declines to count the same work twice.
 *
 * The trade-off, deliberately taken and pinned by test: two GENUINELY different items that
 * happen to share a title also collapse, so a `done` one can mask a `pending` one here.
 * Keying on scope would separate them, but the engine's checklist has no scope — only the
 * plan does (`InsertionTask.scope`, which is why `mergeTasks` can key on it and this
 * cannot) — and collapsing conservatively instead would restore the failure this exists to
 * fix: 327 items, 317 of them pending stutter copies, and a review that could never finish.
 * The exposure is bounded on the other side: per-file coverage is checked at PREPARATION
 * against the plan's scopes, so work that answers for a distinct file is accounted for
 * before the completeness gate ever sees it. Two items with byte-identical titles are also
 * indistinguishable to the human reading the checklist.
 */
export const distinctTasks = (tasks: readonly EngineTask[]): EngineTask[] => {
  const byTitle = new Map<string, EngineTask>();
  for (const task of tasks) {
    const key = task.title.trim().toLowerCase();
    const seen = byTitle.get(key);
    if (
      seen === undefined ||
      (PROGRESS[task.status] ?? 0) > (PROGRESS[seen.status] ?? 0)
    ) {
      byTitle.set(key, {
        ...task,
        // A reason recorded against any copy explains the work, not the copy.
        ...(task.note === undefined && seen?.note !== undefined
          ? { note: seen.note }
          : {}),
      });
    }
  }
  return [...byTitle.values()];
};

export const checkChecklist = (state: EngineTaskState): ChecklistGateResult => {
  const tasks = distinctTasks(state.tasks);
  const pending = tasks.filter(
    (task) => task.status === "pending" || task.status === "in_progress",
  );
  const unexplained = tasks.filter(
    (task) => task.status === "closed" && (task.note ?? "").trim() === "",
  );
  return {
    complete: pending.length === 0 && unexplained.length === 0,
    tasks,
    pending,
    unexplained,
  };
};

/** What the agent is told when the gate hands unfinished work back. */
export const buildChecklistNudge = (result: ChecklistGateResult): string => {
  const lines = [
    "CHECKLIST NOT FINISHED. A review with unfinished items is an incomplete review, so this run cannot move on yet.",
    "",
  ];
  if (result.pending.length > 0) {
    lines.push(
      "Still open:",
      ...result.pending.map(describe),
      "",
      "For each one: do the work now and mark it done with tasks_update, delegate it with delegate_task and collect the result, or close it with a note saying why it will not be done.",
      "",
    );
  }
  if (result.unexplained.length > 0) {
    lines.push(
      "Closed without a reason:",
      ...result.unexplained.map(describe),
      "",
      "Call tasks_update again on each with a note. A closed item is a documented gap in the review; without the note it is just missing work.",
      "",
    );
  }
  lines.push(
    "Do not create new checklist items for work you have already done — finish what is on the list.",
  );
  return lines.join("\n");
};

/**
 * Reads the checklist through the engine and, when `nudge` is given, hands unfinished work
 * back to the agent up to `maxRounds` times. Returns the final state either way: an
 * incomplete checklist is reported, not thrown — the run report has to carry what was left
 * undone, and the caller decides whether that is fatal.
 */
export const enforceChecklist = async (
  gate: ChecklistGateRequest,
): Promise<ChecklistGateResult> => {
  const rounds = gate.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let result = checkChecklist(await gate.engine.tasksApi(gate.sessionId));
  if (gate.nudge === undefined) {
    return result;
  }
  for (let round = 0; round < rounds && !result.complete; round += 1) {
    await gate.nudge(buildChecklistNudge(result));
    result = checkChecklist(await gate.engine.tasksApi(gate.sessionId));
  }
  return result;
};
