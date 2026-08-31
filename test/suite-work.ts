/**
 * Suite: working the checklist, collating, and the run report (TASKS:Y3.3, Y3.4, Y8.3).
 *
 * These are the two stages where a review can quietly lose work — a worker nobody
 * collected, a checklist item nobody finished, a finding nobody deduped — so what is
 * pinned here is the SHELL's half of each: what it drains, what it banks, what it puts
 * back in front of the agent, and what the run report says happened.
 *
 * The model is scripted rather than live: everything asserted below is deterministic code
 * on either side of the model, driven through the BUILT package. No provider is needed and
 * nothing here skips.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  gitWorkspace,
  isBuilt,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("work-collate-report");

type Task = { id: string; title: string; status: string; note?: string };

type WorkerResult = {
  workerId: string;
  ok: boolean;
  summary: string;
  error?: string;
  report?: {
    id: string;
    label: string;
    sizeBytes: number;
    preview: string;
    readBackHint: string;
  };
};

/**
 * A finding with everything the schema demands and nothing it does not. It cites the one
 * file `gitWorkspace` leaves changed — the groundedness gate drops anything else.
 */
const finding = (
  id: string,
  severity: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  file: "app.ts",
  line: 1,
  severity,
  category: "security",
  summary: `${id} summary`,
  impact: "a token reaches the log",
  evidence: [{ kind: "code", ref: "app.ts:1" }],
  ...extra,
});

const worked = (
  taskId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  taskId,
  handledBy: "self",
  note: "read it, nothing else to add",
  findingIds: [],
  ...extra,
});

const BRIEF = {
  persona: "sceptical about auth",
  rules: [],
  focusAreas: ["security"],
  sources: [".yama/rulebook/index.md"],
  gaps: [],
};

const PLAN = {
  changeSummary: "adds a token endpoint",
  riskAreas: ["auth"],
  tasks: [
    {
      title: "check the token endpoint against the auth rules",
      rationale: "the diff adds one",
      scope: ["app.ts"],
      delegate: true,
    },
  ],
  checklistIds: ["t1"],
};

const bankedRef = (id: string) => ({
  id,
  label: id,
  sizeBytes: 1234,
  preview: "# worker report\n",
  readBackHint: `retrieve_context({ artifactId: "${id}", offset: 0, limit: 4000 })`,
});

/**
 * An engine whose model is a function of the prompt. Records every prompt and toolset, so
 * a case can assert what the agent was actually asked and what it was allowed to use.
 */
const stageEngine = (options: {
  answer: (prompt: string, turn: number) => unknown;
  tasks?: Task[];
  /** Runs after each answer — how a case makes the checklist change between turns. */
  onTurn?: (turn: number, tasks: Task[]) => void;
  /** Worker results per drain, in order. */
  collect?: (call: number) => WorkerResult[];
}) => {
  const prompts: string[] = [];
  const toolsSeen: (string[] | undefined)[] = [];
  const tasks: Task[] = options.tasks ?? [];
  let turn = 0;
  let collectCalls = 0;

  const engine = {
    // The scripted answer goes through the stage's own schema, exactly as the seam does:
    // an answer that does not validate reaches the shell as `undefined`, not as itself.
    generateStructured: async (req: {
      prompt: string;
      tools?: string[];
      schema: {
        safeParse: (value: unknown) => { success: boolean; data?: unknown };
      };
    }) => {
      prompts.push(req.prompt);
      toolsSeen.push(req.tools);
      const answer = options.answer(req.prompt, turn);
      options.onTurn?.(turn, tasks);
      turn += 1;
      const parsed = req.schema.safeParse(answer);
      return {
        data: parsed.success ? parsed.data : undefined,
        trusted: parsed.success,
        raw: {
          content: JSON.stringify(answer ?? null),
          structured: answer ?? null,
          repaired: false,
          truncated: false,
          provider: "test-provider",
          model: "test-model",
          stepsUsed: 4,
          toolsUsed: ["read_file"],
        },
      };
    },
    registerTool: () => undefined,
    memoryStatus: () => ({ enabled: true, ready: true, tokenThreshold: 64000 }),
    tasksApi: async (sessionId: string) => ({
      sessionId,
      tasks: tasks.map((task) => ({ ...task })),
    }),
    delegate: async () => ({ workerId: "w-unrequested" }),
    collect: async () => {
      const results = options.collect?.(collectCalls) ?? [];
      collectCalls += 1;
      return results;
    },
    bankReport: async (req: { label: string; payload: string }) => ({
      ...bankedRef(`stage-output-${req.label}`),
      sizeBytes: req.payload.length,
    }),
    backgroundRun: async () => {
      throw new Error("this suite runs no commands");
    },
  };

  return { prompts, toolsSeen, tasks, engine, drains: () => collectCalls };
};

/** Dispatches one scripted answer per stage, whatever round the stage is on. */
const answerFor = (replies: {
  brief?: unknown;
  plan?: unknown;
  work: (turn: number) => unknown;
  collate?: unknown;
}) => {
  return (prompt: string, turn: number): unknown => {
    if (prompt.includes("COLLATE AND DECIDE")) {
      return replies.collate;
    }
    if (prompt.includes("WARM UP.")) {
      return replies.brief;
    }
    // A preparation nudge is a task-insertion turn: the shell asks the same stage again
    // for the same schema, with what is missing attached.
    if (
      prompt.includes("TASK INSERTION.") ||
      prompt.includes("THE CHECKLIST IS NOT USABLE YET")
    ) {
      return replies.plan;
    }
    return replies.work(turn);
  };
};

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section(
    "the work prompt hands over the checklist and the rules for working it",
  );

  await test("it names every item, the delegation tools and the id contract", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildWorkPrompt({
      brief: BRIEF,
      plan: PLAN,
      tasks: [
        { id: "t1", title: "check the token endpoint", status: "pending" },
        { id: "t2", title: "look for missing tests", status: "in_progress" },
      ],
    });
    assertIncludes(prompt, "t1 [pending] check the token endpoint", "item t1");
    assertIncludes(prompt, "t2 [in_progress]", "item t2");
    assertIncludes(prompt, "delegate_task", "how to delegate");
    assertIncludes(prompt, "collect_results", "how to collect");
    assertIncludes(prompt, "retrieve_context", "how to read a report back");
    assertIncludes(prompt, "kebab-case", "the stable-id contract");
    assertIncludes(prompt, "CRITICAL, MAJOR, MINOR, INFO", "the taxonomy");
    assertIncludes(prompt, "unfinished review", "the completeness contract");
    assertIncludes(prompt, "sceptical about auth", "the brief is carried in");
  });

  await test("an empty checklist is stated, not glossed over", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildWorkPrompt({ brief: BRIEF, plan: PLAN, tasks: [] });
    assertIncludes(prompt, "tasks_create", "it says how to fix an empty list");
  });

  section("workers — nothing a worker produced is dropped");

  await test("a worker the agent never collected is drained, banked and handed back", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("work", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const late: WorkerResult = {
        workerId: "w1",
        ok: true,
        summary: "the endpoint logs the raw token",
        report: bankedRef("worker-report-delegate-w1"),
      };
      const scripted = stageEngine({
        tasks: [{ id: "t1", title: "check the endpoint", status: "done" }],
        answer: answerFor({
          work: (turn) =>
            turn === 0
              ? {
                  findings: [],
                  worked: [
                    worked("t1", {
                      handledBy: "worker",
                      workerId: "w1",
                      findingIds: ["auth-token-logged"],
                    }),
                  ],
                  openQuestions: [],
                }
              : {
                  findings: [finding("auth-token-logged", "CRITICAL")],
                  worked: [],
                  openQuestions: [],
                },
        }),
        collect: (call) => (call === 0 ? [late] : []),
      });

      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });
      const result = await mod.runWork({
        session,
        engine: scripted.engine,
        paths,
        brief: BRIEF,
        plan: PLAN,
      });

      assertEqual(
        result.rounds,
        2,
        "the late worker earns one more agent turn",
      );
      assertIncludes(
        scripted.prompts[1],
        "WORKERS THAT CAME BACK",
        "the second turn is told what landed",
      );
      assertIncludes(
        scripted.prompts[1],
        "the endpoint logs the raw token",
        "the worker's summary reaches the agent",
      );
      assertIncludes(
        scripted.prompts[1],
        "retrieve_context(",
        "so does the call that reads the full report back",
      );

      const record = JSON.parse(
        await readFile(path.join(paths.workersDir, "w1.json"), "utf8"),
      );
      assertEqual(record.taskId, "t1", "the worker is bound to its item");
      assertEqual(record.status, "completed", "the worker's status");
      assertEqual(
        record.findings[0]?.id,
        "auth-token-logged",
        "the finding the agent attributed to it",
      );
      assertEqual(result.workers.length, 1, "one worker record returned");
      assertEqual(
        result.findings.length,
        1,
        "findings accumulate across rounds",
      );
    });
  });

  await test("a worker that failed is still banked, with its error", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("work", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const scripted = stageEngine({
        tasks: [{ id: "t1", title: "check the endpoint", status: "done" }],
        answer: answerFor({
          work: () => ({ findings: [], worked: [], openQuestions: [] }),
        }),
        collect: (call) =>
          call === 0
            ? [
                {
                  workerId: "w9",
                  ok: false,
                  summary: "worker w9 failed: it exploded",
                  error: "it exploded",
                  report: bankedRef("worker-report-delegate-w9"),
                },
              ]
            : [],
      });
      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });
      await mod.runWork({
        session,
        engine: scripted.engine,
        paths,
        brief: BRIEF,
        plan: PLAN,
      });
      const record = JSON.parse(
        await readFile(path.join(paths.workersDir, "w9.json"), "utf8"),
      );
      assertEqual(record.status, "failed", "a failed worker is recorded");
      assertEqual(record.error, "it exploded", "with the reason");
    });
  });

  section("the completeness gate loops unfinished work back to the agent");

  await test("a pending item is handed back, and the finished list moves on", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("work", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const scripted = stageEngine({
        tasks: [{ id: "t1", title: "check the endpoint", status: "pending" }],
        answer: answerFor({
          work: (turn) => ({
            findings: [finding(`f${turn}`, "MINOR")],
            worked: [worked("t1")],
            openQuestions: [],
          }),
        }),
        onTurn: (turn, tasks) => {
          if (turn === 1) {
            tasks[0].status = "done";
          }
        },
      });
      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });
      const result = await mod.runWork({
        session,
        engine: scripted.engine,
        paths,
        brief: BRIEF,
        plan: PLAN,
      });

      assertEqual(result.rounds, 2, "one nudge, then the list was finished");
      assertIncludes(
        scripted.prompts[1],
        "CHECKLIST NOT FINISHED",
        "the nudge says what is wrong",
      );
      assertIncludes(
        scripted.prompts[1],
        "t1 [pending] check the endpoint",
        "the nudge names the item",
      );
      assertEqual(result.checklist.complete, true, "the gate is satisfied");
      assertEqual(
        result.findings.map((f: { id: string }) => f.id).join(","),
        "f0,f1",
        "every round's findings are kept",
      );
    });
  });

  await test("an agent that ignores the nudge yields an incomplete report, not a hang", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("work", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const scripted = stageEngine({
        tasks: [
          { id: "t1", title: "check the endpoint", status: "pending" },
          { id: "t2", title: "look at the tests", status: "closed" },
        ],
        answer: answerFor({
          work: () => ({ findings: [], worked: [], openQuestions: [] }),
        }),
      });
      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });
      const result = await mod.runWork({
        session,
        engine: scripted.engine,
        paths,
        brief: BRIEF,
        plan: PLAN,
        maxRounds: 2,
      });

      assertEqual(result.rounds, 3, "the opening turn plus two bounded nudges");
      assertEqual(
        result.checklist.complete,
        false,
        "an ignored nudge leaves the review incomplete",
      );
      assertEqual(result.checklist.pending.length, 1, "the pending item");
      assertEqual(
        result.checklist.unexplained.length,
        1,
        "closing without a reason is unfinished too",
      );
    });
  });

  section("collate — the model dedupes, the policy decides");

  await test("the prompt carries the findings, the banked reports and the gaps", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildCollatePrompt({
      brief: BRIEF,
      plan: PLAN,
      findings: [finding("auth-token-logged", "CRITICAL")],
      workers: [
        {
          workerId: "w1",
          taskId: "t1",
          status: "completed",
          summary: "s",
          reportPath: "/store/reports/worker-report-delegate-w1.md",
          findings: [],
        },
      ],
      checklist: {
        complete: false,
        tasks: [{ id: "t1", title: "check the endpoint", status: "pending" }],
        pending: [{ id: "t1", title: "check the endpoint", status: "pending" }],
        unexplained: [],
      },
    });
    assertIncludes(prompt, "auth-token-logged", "the findings so far");
    assertIncludes(
      prompt,
      "worker-report-delegate-w1.md",
      "where to read back",
    );
    assertIncludes(prompt, "retrieve_context", "how to read it back");
    assertIncludes(
      prompt,
      "NOT finished",
      "the incomplete checklist is stated",
    );
    assertIncludes(
      prompt,
      "You do not decide the verdict",
      "the verdict is the policy's, not the model's",
    );
  });

  await test("duplicates merge and the list is ranked", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("collate", async (dir) => {
      await gitWorkspace(dir);
      const paths = mod.storePathsForDir(
        path.join(dir, ".yama", "artifacts", "local"),
      );
      await mod.ensureStore(paths);
      const config = await mod.loadConfig(dir, { mode: "local" });
      const scripted = stageEngine({
        answer: answerFor({
          work: () => ({ findings: [], worked: [], openQuestions: [] }),
          collate: {
            // Deliberately out of severity order: the shell ranks, not the model.
            findings: [
              finding("style-nit", "MINOR"),
              finding("auth-token-logged", "CRITICAL"),
            ],
            merged: [{ from: "dup-token-log", into: "auth-token-logged" }],
            summary: "one real problem in the token path",
          },
        }),
      });
      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });

      const result = await mod.runCollate({
        session,
        paths,
        config,
        brief: BRIEF,
        plan: PLAN,
        findings: [],
        workers: [],
        checklist: { complete: true, tasks: [], pending: [], unexplained: [] },
      });

      assertEqual(
        result.ranked.findings[0]?.id,
        "auth-token-logged",
        "most serious first, whatever order the model used",
      );
      assertEqual(
        result.ranked.merged?.["dup-token-log"],
        "auth-token-logged",
        "the dropped id points at the one that survived",
      );
      assertEqual(
        result.verdict.decision,
        "block",
        "the policy blocks on CRITICAL",
      );
      assertEqual(mod.exitCodeFor(result.verdict), 1, "block is exit 1");
      // The ledger is written by the SHELL after grounding, not by collate — the
      // end-to-end runReview case owns that assertion now.
    });
  });

  await test("the collate stage is never handed a posting or delegation tool", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("collate", async (dir) => {
      await gitWorkspace(dir);
      const paths = mod.storePathsForDir(
        path.join(dir, ".yama", "artifacts", "local"),
      );
      await mod.ensureStore(paths);
      const config = await mod.loadConfig(dir, { mode: "local" });
      const scripted = stageEngine({
        answer: answerFor({
          work: () => ({ findings: [], worked: [], openQuestions: [] }),
          collate: { findings: [], merged: [], summary: "nothing found" },
        }),
      });
      const session = mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-1",
      });
      await mod.runCollate({
        session,
        paths,
        config,
        brief: BRIEF,
        plan: PLAN,
        findings: [],
        workers: [],
        checklist: { complete: true, tasks: [], pending: [], unexplained: [] },
      });
      const tools = scripted.toolsSeen[0] ?? [];
      assert(tools.includes("read_file"), "collate can still read the repo");
      assert(
        !tools.includes("delegate_task"),
        "collate must not be able to spawn more workers",
      );
    });
  });

  section("the whole run, end to end");

  /** Everything a full `runReview` needs from a scripted model. */
  const fullRun = () => {
    let workTurns = 0;
    return stageEngine({
      tasks: [{ id: "t1", title: "check the endpoint", status: "done" }],
      answer: answerFor({
        brief: BRIEF,
        plan: PLAN,
        // The second work turn exists only to fold in the worker that landed late.
        work: () => {
          workTurns += 1;
          return workTurns > 1
            ? { findings: [], worked: [], openQuestions: [] }
            : {
                findings: [
                  finding("auth-token-logged", "CRITICAL", { confidence: 0.9 }),
                  finding("style-nit", "INFO", { confidence: 0.5 }),
                ],
                worked: [
                  worked("t1", {
                    handledBy: "worker",
                    workerId: "w1",
                    findingIds: ["auth-token-logged"],
                  }),
                ],
                openQuestions: [],
              };
        },
        collate: {
          findings: [
            finding("auth-token-logged", "CRITICAL", { confidence: 0.9 }),
          ],
          merged: [{ from: "style-nit", into: "auth-token-logged" }],
          summary: "the token path logs a secret",
        },
      }),
      collect: (call) =>
        call === 0
          ? [
              {
                workerId: "w1",
                ok: true,
                summary: "found the log line",
                report: bankedRef("worker-report-delegate-w1"),
              },
            ]
          : [],
    });
  };

  await test("runReview drives all four stages and banks every one", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("review", async (dir) => {
      await gitWorkspace(dir);
      const scripted = fullRun();
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const result = await mod.runReview(
        {
          runId: mod.newRunId(),
          target: { mode: "local" },
          root: dir,
          storeDir,
          dryRun: true,
        },
        scripted.engine,
      );

      const paths = mod.storePathsForDir(storeDir);
      for (const stage of ["warmup", "taskInsertion", "work", "collate"]) {
        const banked = await readFile(
          path.join(paths.stagesDir, `${stage}.json`),
          "utf8",
        );
        assertIncludes(banked, `"stage": "${stage}"`, `${stage} is banked`);
      }
      assertEqual(
        result.ranked.findings.length,
        1,
        "the collated list is what comes back",
      );
      assertEqual(result.verdict.decision, "block", "CRITICAL blocks");
      assertEqual(mod.exitCodeFor(result.verdict), 1, "block is exit 1");
      assertEqual(
        result.tasks[0]?.id,
        "t1",
        "the checklist is carried out of the run",
      );
      const ledger = await mod.readLedger(paths);
      assertEqual(
        ledger.findings[0]?.id,
        "auth-token-logged",
        "ledger written",
      );
    });
  });

  await test("the run report carries the stage metrics, the gate stats and the verdict", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("review", async (dir) => {
      await gitWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const result = await mod.runReview(
        {
          runId: mod.newRunId(),
          target: { mode: "local" },
          root: dir,
          storeDir,
          dryRun: true,
        },
        fullRun().engine,
      );

      const onDisk = await mod.readRunReport(mod.storePathsForDir(storeDir));
      assertEqual(onDisk.runId, result.report.runId, "the report is banked");
      assertEqual(
        onDisk.stages.map((s: { stage: string }) => s.stage).join(","),
        "warmup,taskInsertion,work,work,collate",
        "one metric per checkpoint, in execution order",
      );
      assert(
        onDisk.stages.every((s: { durationMs: number }) => s.durationMs >= 0),
        "every stage is timed",
      );
      assertEqual(onDisk.gates.checklistComplete, true, "the checklist gate");
      assertEqual(onDisk.gates.workersCollected, 1, "the worker that landed");
      assertEqual(onDisk.gates.findingsReported, 2, "before dedupe");
      assertEqual(onDisk.gates.findingsAfterDedupe, 1, "after dedupe");
      assertEqual(
        onDisk.gates.untrustedStages,
        0,
        "nothing came back repaired",
      );
      assertEqual(onDisk.verdict.decision, "block", "the verdict is banked");
      assertEqual(onDisk.delivery.posted, 0, "a dry run posts nothing");
      assertIncludes(
        String(onDisk.delivery.skipped),
        "dry-run",
        "and says why it posted nothing",
      );
      assertEqual(
        onDisk.headSha?.length,
        40,
        "the reviewed commit is recorded",
      );
    });
  });

  await test("a plan with no checklist is nudged until there is one, and the run goes on", async () => {
    // The recovery this whole change is about. On yama PR #101 the stage answered with a
    // plan and no items over 15 files, and the run died there. Nothing about that moment
    // was unrecoverable: the diff was banked, the checkout was on disk, and the agent had
    // read most of the change. It just needed to be asked for the one thing missing.
    const mod = await import(DIST_ENTRY);
    await withTempDir("prepare", async (dir) => {
      await gitWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const scripted = stageEngine({
        // Nothing created by the first answer — the engine holds an empty checklist.
        tasks: [],
        answer: answerFor({
          brief: BRIEF,
          plan: PLAN,
          work: () => ({
            findings: [finding("auth-token-logged", "CRITICAL")],
            worked: [worked("t1", { handledBy: "self" })],
            openQuestions: [],
          }),
          collate: {
            findings: [finding("auth-token-logged", "CRITICAL")],
            merged: [],
            summary: "the token path logs a secret",
          },
        }),
        // The nudge is turn 2 (warmup, insertion, then the ask). The agent calls
        // tasks_create this time, which is what the shell has been waiting for.
        onTurn: (turn, tasks) => {
          if (turn === 2) {
            tasks.push({
              id: "t1",
              title: "check the endpoint",
              status: "done",
            });
          }
        },
      });

      const result = await mod.runReview(
        {
          runId: mod.newRunId(),
          target: { mode: "local" },
          root: dir,
          storeDir,
          dryRun: true,
        },
        scripted.engine,
      );

      const nudge = scripted.prompts[2] ?? "";
      assertIncludes(
        nudge,
        "THE CHECKLIST IS NOT USABLE YET",
        "the shell hands the gap back rather than failing the run",
      );
      assertIncludes(
        nudge,
        "tasks_create was never called",
        "naming what was actually missing",
      );
      assertIncludes(
        nudge,
        "THE CHANGE UNDER REVIEW",
        "with the change restated, so the ask stands on its own",
      );
      assertEqual(
        result.verdict.decision,
        "block",
        "and the review that follows is a real one",
      );
      assertEqual(
        result.tasks[0]?.id,
        "t1",
        "over the checklist the second ask produced",
      );
    });
  });

  await test("a run that worked nothing and found nothing fails instead of approving", async () => {
    // curator PR #702 in one test: every checklist item closed unworked, no findings, and
    // a verdict of APPROVE posted to a pull request over a change nobody had read. The
    // run fails BEFORE delivery — an approval nobody earned is worse on a pull request
    // than a red check.
    const mod = await import(DIST_ENTRY);
    await withTempDir("nothing", async (dir) => {
      await gitWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const scripted = stageEngine({
        tasks: [
          {
            id: "t1",
            title: "check the endpoint",
            status: "closed",
            note: "blocked: could not identify the change",
          },
        ],
        answer: answerFor({
          brief: BRIEF,
          plan: PLAN,
          work: () => ({ findings: [], worked: [], openQuestions: [] }),
          collate: { findings: [], merged: [], summary: "nothing to report" },
        }),
      });

      let message = "";
      try {
        await mod.runReview(
          {
            runId: mod.newRunId(),
            target: { mode: "local" },
            root: dir,
            storeDir,
            dryRun: true,
          },
          scripted.engine,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assertIncludes(
        message,
        "not a review that found nothing",
        "the run says why it will not decide",
      );
      const onDisk = await mod.readRunReport(mod.storePathsForDir(storeDir));
      assertEqual(
        onDisk.verdict?.decision,
        "approve",
        "the policy still computed approve over zero findings — that is not the bug",
      );
      assertEqual(
        onDisk.delivery,
        undefined,
        "the bug was posting it, and delivery never ran",
      );
    });
  });

  await test("a stage that fails leaves the failure in the banked report", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("review", async (dir) => {
      await gitWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const scripted = stageEngine({
        // The checklist has to exist for the run to reach the work stage at all — an
        // empty one now fails during preparation, which is a different test.
        tasks: [{ id: "t1", title: "check the endpoint", status: "pending" }],
        answer: answerFor({
          brief: BRIEF,
          plan: PLAN,
          // Schema-invalid: no `worked`, no `openQuestions`.
          work: () => ({ findings: "not a list" }),
        }),
      });
      let message = "";
      try {
        await mod.runReview(
          {
            runId: mod.newRunId(),
            target: { mode: "local" },
            root: dir,
            storeDir,
            dryRun: true,
          },
          scripted.engine,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(
        message,
        "banked output",
        "the failure names its evidence",
      );
      const onDisk = await mod.readRunReport(mod.storePathsForDir(storeDir));
      assertIncludes(
        String(onDisk.error),
        'stage "work"',
        "the report says which stage failed",
      );
      assert(
        onDisk.stages.length >= 2,
        "the stages that did run are still recorded",
      );
    });
  });

  section("the run summary a human reads");

  await test("it prints the stages, the gates, the verdict and where it is banked", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("review", async (dir) => {
      await gitWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const result = await mod.runReview(
        {
          runId: mod.newRunId(),
          target: { mode: "local" },
          root: dir,
          storeDir,
          dryRun: true,
        },
        fullRun().engine,
      );
      const summary = mod.renderRunSummary(result.report, storeDir);
      for (const stage of ["warmup", "taskInsertion", "work", "collate"]) {
        assertIncludes(summary, stage, `${stage} appears in the summary`);
      }
      assertIncludes(summary, "checklist  complete", "the checklist gate");
      assertIncludes(
        summary,
        "2 reported → 1 after dedupe",
        "the dedupe count",
      );
      assertIncludes(summary, "verdict  BLOCK", "the verdict");
      assertIncludes(summary, "switched off for this run", "the degradations");
      assertIncludes(summary, "memory", "an absent optional piece is named");
      assertIncludes(summary, storeDir, "where to read the evidence");
    });
  });
}
