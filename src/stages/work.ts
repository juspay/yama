/**
 * Work the checklist (TASKS:Y3.3) — the stage where the review actually happens.
 *
 * The agent decides, item by item, whether to investigate itself or hand the work to a
 * background worker. What the shell owns is everything the agent must not be trusted to
 * do for itself:
 *
 *   - **Nothing a worker produced is dropped.** Before every agent turn, and again after
 *     the last one, the shell collects every finished worker, banks its full report to the
 *     run store, and hands the bounded summary plus the read-back call back to the agent.
 *     A worker the agent forgot to collect still reaches the conversation and the store.
 *   - **Pending items are an incomplete review.** The completeness gate (TASKS:Y4.2) reads
 *     the checklist the engine holds — not the conversation, which compaction rewrites —
 *     and puts unfinished work back in front of the agent, bounded by `maxRounds`. An
 *     agent that ignores the nudge yields an incomplete report, never a hang.
 */
import {
  checkChecklist,
  checkpointWithSchemaGate,
  enforceChecklist,
} from "../gates/index.js";
import { payloadPath, writeWorkerReport } from "../store/index.js";
import {
  CHECKLIST_TOOLS,
  DELEGATION_TOOLS,
  READ_ONLY_TOOLS,
} from "../tools/index.js";
import type {
  Engine,
  EngineTask,
  EngineWorkerResult,
  Finding,
  InsertionPlan,
  OperatingBrief,
  RunStorePaths,
  SessionRunner,
  Stage,
  StageOutput,
  WorkOutcome,
  WorkStageResult,
  WorkerReport,
} from "../types/index.js";
import { SEVERITIES } from "../util/severity.js";
import { WorkOutcomeSchema } from "./schema.js";

/**
 * Room to read files, delegate, collect and write up — one round of work. Sized from
 * live evidence: a repository-rewrite pull request exhausted 64 steps mid-review with
 * the checklist still open, and a round that dies on the step cap loses everything it
 * gathered. The finalize fallback in the schema gate is the floor under this ceiling.
 */
const WORK_MAX_STEPS = 160;

/** Agent turns after the first. Each one is a nudge with unfinished work attached. */
const WORK_MAX_ROUNDS = 3;

/**
 * Bound on one drain. `collect({ mode: "all" })` waits for outstanding workers, which is
 * what we want — their findings are the review — but a stuck worker must not stall the run.
 */
const COLLECT_WAIT_MS = 300_000;

/** Read, delegate, collect, and keep the checklist honest. No write tool, ever. */
const WORK_TOOLS: readonly string[] = [
  ...READ_ONLY_TOOLS,
  ...CHECKLIST_TOOLS,
  ...DELEGATION_TOOLS,
];

const describeTask = (task: EngineTask): string =>
  `  ${task.id} [${task.status}] ${task.title}${task.note ? ` — ${task.note}` : ""}`;

/** The checklist, the change and the rules of engagement for working it. */
export const buildWorkPrompt = (input: {
  brief: OperatingBrief;
  plan: InsertionPlan;
  tasks: readonly EngineTask[];
  /** Check ids the base branch declares, if any (TASKS:Y5.2). */
  checks?: readonly string[];
}): string => {
  const { brief, plan, tasks } = input;
  const checks = input.checks ?? [];
  return [
    "WORK THE CHECKLIST. Every item on it is a review pointer you committed to. Finish them.",
    "",
    `Review posture: ${brief.persona}`,
    `What this change does: ${plan.changeSummary}`,
    plan.riskAreas.length > 0
      ? `Where you said the risk sits: ${plan.riskAreas.join("; ")}.`
      : "You named no specific risk areas — work from the diff itself.",
    "",
    "Your checklist, as the engine holds it:",
    ...(tasks.length > 0
      ? tasks.map(describeTask)
      : ["  (empty — call tasks_create before you do anything else)"]),
    "",
    "How to do it:",
    "  1. Move an item to in_progress before you start it, and to done the moment its result is in.",
    "  2. Delegate the large, self-contained items with delegate_task. It returns a workerId immediately and the worker runs in the background with its own session and read-only tools. Give it the slice of the brief it needs and the files it may look at — never the whole rulebook.",
    "  3. Do the small and cross-cutting items yourself with read_file and list_files.",
    "     Every changed file is already in this checkout — read code LOCALLY, never through",
    "     platform tools. Platform tools are for the pull request's comments and metadata",
    "     only; they are slow and can time out on a large change.",
    "  4. Workers finish in ANY order. Call collect_results (mode 'any' while you still have work in hand, 'all' when you have run out) and use each result as it lands — every result is handed over exactly once.",
    "  5. Each worker's full report is banked and its summary names the artifactId. Read the whole report with retrieve_context before you turn any part of it into a finding.",
    "  6. An item you will genuinely not do is closed with a note saying why. A pending item is an unfinished review.",
    checks.length > 0
      ? `  7. This repository declares checks you can run as evidence: ${checks.join(", ")}. Call run_check with one id to run it; its full output is banked and the result names the call that reads it back. A check result is evidence — cite it.`
      : "  7. This repository declares no checks you can run, so every claim has to rest on something you read.",
    "",
    "Report every finding you are willing to stand behind:",
    "  - id: stable and kebab-case, from the problem and the place ('auth-token-logged'). The same problem must get the same id on a later run — that is what stops it being posted twice.",
    `  - severity: one of ${SEVERITIES.join(", ")}, most serious first.`,
    "  - evidence: at least one ref you actually read — 'path:line', a check id, or a rule id from the brief. No evidence, no finding.",
    "  - confidence: how sure you are, 0 to 1. Lower it rather than inventing certainty.",
    "Say nothing about an area you did not read. Silence about a clean area beats a filler finding.",
    "",
    "Then report, for each checklist item you touched: who handled it, the workerId if you delegated it, what it concluded, and the ids of the findings it produced.",
  ].join("\n");
};

/** The prompt for a round that exists only because workers landed after the agent stopped. */
export const WORK_TRAILING_PROMPT = [
  "These workers finished after your last turn, so their findings are not in your report yet.",
  "Read each banked report with retrieve_context, then report the findings it produced and mark the checklist items they belong to.",
  "Report only what is new — the findings you already reported are recorded.",
].join("\n");

/** Worker results as the agent sees them: bounded summary inline, full report one call away. */
export const renderCollectedWorkers = (
  results: readonly EngineWorkerResult[],
): string =>
  [
    "WORKERS THAT CAME BACK (their full reports are banked — read one before you rely on it):",
    ...results.flatMap((result) => [
      `  ${result.workerId} [${result.ok ? "completed" : "failed"}]${result.error ? ` error: ${result.error}` : ""}`,
      `    summary: ${result.summary || "(the worker said nothing)"}`,
      ...(result.report
        ? [`    full report: ${result.report.readBackHint}`]
        : []),
    ]),
  ].join("\n");

/** One collected worker as a store record. Its findings are whatever the agent attributed. */
const toWorkerReport = (
  paths: RunStorePaths,
  result: EngineWorkerResult,
  taskId: string,
  findings: readonly Finding[],
): WorkerReport => ({
  workerId: result.workerId,
  taskId,
  status: result.ok ? "completed" : "failed",
  summary: result.summary,
  reportPath:
    result.reportPath ??
    (result.report ? payloadPath(paths, result.report.id) : ""),
  findings: [...findings],
  ...(result.error !== undefined ? { error: result.error } : {}),
});

/**
 * Writes one store record per collected worker, carrying the checklist item it served and
 * the findings the agent attributed to it. Idempotent: records are written as workers land
 * and rewritten here, once the attribution the agent reported later is known.
 */
const bankWorkerRecords = async (input: {
  paths: RunStorePaths;
  collected: readonly EngineWorkerResult[];
  findings: readonly Finding[];
  taskOfWorker: ReadonlyMap<string, string>;
  findingsOfWorker: ReadonlyMap<string, string[]>;
}): Promise<WorkerReport[]> => {
  const byId = new Map(input.findings.map((finding) => [finding.id, finding]));
  const records: WorkerReport[] = [];
  for (const result of input.collected) {
    const produced = (
      input.findingsOfWorker.get(result.workerId) ?? []
    ).flatMap((id) => {
      const finding = byId.get(id);
      return finding ? [finding] : [];
    });
    const record = toWorkerReport(
      input.paths,
      result,
      input.taskOfWorker.get(result.workerId) ?? "",
      produced,
    );
    await writeWorkerReport(input.paths, record);
    records.push(record);
  }
  return records;
};

/**
 * Runs the work stage: one opening turn, then the completeness gate, then however many
 * trailing rounds it takes to fold in workers that landed late — all bounded.
 */
export const runWork = async (options: {
  session: SessionRunner;
  engine: Engine;
  paths: RunStorePaths;
  brief: OperatingBrief;
  plan: InsertionPlan;
  /** Nudge rounds after the opening turn. Default 3. */
  maxRounds?: number;
  /** Bound on one collect. Default five minutes. */
  collectWaitMs?: number;
  /** Live review-phase capability tools plus `run_check` when there is one (TASKS:Y5.1). */
  extraTools?: readonly string[];
  /** Check ids the base branch declares (TASKS:Y5.2). */
  checks?: readonly string[];
}): Promise<WorkStageResult> => {
  const { session, engine, paths } = options;
  const maxRounds = options.maxRounds ?? WORK_MAX_ROUNDS;
  const waitMs = options.collectWaitMs ?? COLLECT_WAIT_MS;

  const findings: Finding[] = [];
  /** workerId → the checklist item the agent says it was for. */
  const taskOfWorker = new Map<string, string>();
  /** workerId → the finding ids the agent attributed to it. */
  const findingsOfWorker = new Map<string, string[]>();
  const collected = new Map<string, EngineWorkerResult>();
  let output: StageOutput<Stage, WorkOutcome> | undefined;
  let rounds = 0;

  /** Banks every finished worker and returns them, so the next turn can be told. */
  const drain = async (): Promise<EngineWorkerResult[]> => {
    const results = await engine.collect({ mode: "all", waitMs });
    for (const result of results) {
      collected.set(result.workerId, result);
      await writeWorkerReport(
        paths,
        toWorkerReport(
          paths,
          result,
          taskOfWorker.get(result.workerId) ?? "",
          [],
        ),
      );
    }
    return results;
  };

  /** One agent turn. Whatever came back from workers is handed over before the ask. */
  const turn = async (
    prompt: string,
    workers: readonly EngineWorkerResult[],
  ): Promise<void> => {
    const text =
      workers.length > 0
        ? [renderCollectedWorkers(workers), "", prompt].join("\n")
        : prompt;
    output = await checkpointWithSchemaGate({
      session,
      request: {
        stage: "work",
        prompt: text,
        schema: WorkOutcomeSchema,
        tools: [...WORK_TOOLS, ...(options.extraTools ?? [])],
        maxSteps: WORK_MAX_STEPS,
      },
    });
    rounds += 1;
    findings.push(...output.data.findings);
    for (const worked of output.data.worked) {
      if (worked.workerId !== undefined && worked.workerId.length > 0) {
        taskOfWorker.set(worked.workerId, worked.taskId);
        findingsOfWorker.set(worked.workerId, worked.findingIds);
      }
    }
  };

  const tasks = await engine.tasksApi(session.sessionId);
  await turn(
    buildWorkPrompt({
      brief: options.brief,
      plan: options.plan,
      tasks: tasks.tasks,
      ...(options.checks !== undefined ? { checks: options.checks } : {}),
    }),
    [],
  );

  let checklist = await enforceChecklist({
    engine,
    sessionId: session.sessionId,
    maxRounds,
    nudge: async (nudge: string): Promise<void> => {
      await turn(nudge, await drain());
    },
  });

  // Workers that landed after the agent's last turn still hold findings nobody has read.
  for (let round = 0; round < maxRounds; round += 1) {
    const late = await drain();
    if (late.length === 0) {
      break;
    }
    await turn(WORK_TRAILING_PROMPT, late);
    checklist = checkChecklist(await engine.tasksApi(session.sessionId));
  }

  // Re-bank the records now the agent's task and finding attribution is complete.
  const workers = await bankWorkerRecords({
    paths,
    collected: [...collected.values()],
    findings,
    taskOfWorker,
    findingsOfWorker,
  });

  if (output === undefined) {
    // Unreachable: `turn` either sets the envelope or throws StageError first.
    throw new Error("the work stage produced no envelope");
  }
  return { output, findings, workers, checklist, rounds };
};
