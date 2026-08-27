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
export const checkChecklist = (state: EngineTaskState): ChecklistGateResult => {
  const pending = state.tasks.filter(
    (task) => task.status === "pending" || task.status === "in_progress",
  );
  const unexplained = state.tasks.filter(
    (task) => task.status === "closed" && (task.note ?? "").trim() === "",
  );
  return {
    complete: pending.length === 0 && unexplained.length === 0,
    tasks: state.tasks,
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
