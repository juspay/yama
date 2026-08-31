/**
 * The shell: one main session driven through the stages, with deterministic gates between
 * them (PLAN.md section 1). Stages are agentic; everything that bounds them is plain code.
 *
 * The run report is written before the first stage and rewritten after every one, so a run
 * that dies in the middle still leaves a store a human can read.
 */
import { loadConfig } from "../config/index.js";
import { StageError } from "./errors.js";
import { connectPlatform } from "../platform/index.js";
import {
  detectRecurrence,
  runCollate,
  runDelivery,
  runTaskInsertion,
  runWarmUp,
  runWork,
  scanReportedFindings,
  withReportedMarkers,
} from "../stages/index.js";
import {
  ensureStore,
  storePathsForDir,
  writeLedger,
  writeRunReport,
} from "../store/index.js";
import {
  CHECK_TOOLS,
  gitDefaultBranch,
  gitHeadSha,
  guardChecks,
  isGitRepo,
  LegacyChecksError,
  readChecksAtRef,
  registerCheckTools,
  registerFsTools,
} from "../tools/index.js";
import {
  checkCoverage,
  decideVerdict,
  distinctTasks,
  groundFindings,
  reviewEstablishedNothing,
  withRecoveryCaveat,
} from "../gates/index.js";
import type {
  ChecksConfig,
  ChecksGuard,
  ConfigDegradation,
  EngineMemoryStatus,
  Engine,
  Finding,
  GitDiff,
  PlatformSession,
  RankedFindings,
  RecurrenceState,
  ResolvedConfig,
  ReviewResult,
  RunContext,
  RunReport,
  RunStorePaths,
  SessionRunner,
  TaskItem,
  Verdict,
  VerdictConfig,
} from "../types/index.js";
import { buildEngineConfig } from "./engineConfig.js";
import {
  deliveryStats,
  gateStats,
  recurrenceStats,
  startRunReport,
} from "./report.js";
import { createSessionRunner } from "./session.js";

/**
 * What is wrong with this run's memory, if anything (TASKS:Y2.5).
 *
 * Two different failures, and only the first was ever visible. Memory OFF means every
 * stage starts from nothing. Memory ON WITH NOTHING EVICTING is worse, because it looks
 * healthy: a summarization that cannot finish evicts nothing and returns, so the history
 * grows on every call until the context window ends the run. Raised by this change's own
 * review — "the failure is silent context growth" — and it is only silent while nobody
 * says it, so the run report says it.
 */
export const memoryDegradation = (
  memory: EngineMemoryStatus,
): ConfigDegradation | undefined => {
  if (!memory.enabled) {
    return {
      what: "memory",
      reason:
        "conversation memory is off — every stage, retry and nudge round starts from nothing",
    };
  }
  if (memory.evicting === true) {
    return undefined;
  }
  return {
    what: "memory.eviction",
    reason: `conversation memory is on but nothing will evict it — the history grows for the whole run and every call carries more of it${
      memory.tokenThreshold !== undefined
        ? ` (the ${memory.tokenThreshold}-token threshold will be crossed and not acted on)`
        : ""
    }`,
  };
};

/** A run id that sorts by time and is safe in a file name. */
export const newRunId = (now = new Date()): string =>
  `run-${now.toISOString().replace(/[:.]/g, "-")}`;

/**
 * The checks this run may execute, read out of git at the ref the change is going into
 * (TASKS:Y5.2). A local run's base is its own HEAD: the working tree is the change, so
 * everything already committed is the state it is being reviewed against.
 *
 * An absent `checks.yaml` on the base is not an error — it is a repository that declares
 * no checks there, which includes the case of a change that has just added some. Those are
 * exactly the commands a review must not run.
 */
export const resolveBaseChecks = async (
  run: RunContext,
  config: ResolvedConfig,
): Promise<{ ref?: string; checks?: ChecksConfig }> => {
  const ref =
    run.target.mode === "local"
      ? "HEAD"
      : (run.target.base ??
        (await gitDefaultBranch(run.root, run.signal)) ??
        undefined);
  if (ref === undefined) {
    return {};
  }
  let checks: ChecksConfig | undefined;
  try {
    checks = await readChecksAtRef({
      root: run.root,
      ref,
      ...(run.signal ? { signal: run.signal } : {}),
    });
  } catch (error) {
    // The migration case: a pre-v5 checks.yaml on the base is a degradation for this
    // run, never a failed review. A v5-shaped-but-invalid file still fails loudly.
    if (!(error instanceof LegacyChecksError)) {
      throw error;
    }
    config.degradations.push({ what: "checks", reason: error.message });
    return { ref };
  }
  if (config.checks !== undefined && checks === undefined) {
    config.degradations.push({
      what: "checks",
      reason: `.yama/checks.yaml is not on ${ref} — a check the change itself introduces is not one this review will run`,
    });
  }
  return { ref, ...(checks !== undefined ? { checks } : {}) };
};

/**
 * Findings must cite the change — schema-valid fabrication reached a pull request once,
 * citing files that do not exist. Carried-over findings answer to their own run's diff,
 * so their ids pass through. A drop re-derives the verdict from what survived and says
 * so in the verdict's own reasons — a silent narrowing is the failure mode this gate
 * exists to prevent.
 */
const groundRanked = (input: {
  ranked: RankedFindings;
  verdict: Verdict;
  diff: GitDiff;
  carriedOver: readonly Finding[];
  policy: VerdictConfig;
}): { ranked: RankedFindings; verdict: Verdict } => {
  const grounding = groundFindings({
    findings: input.ranked.findings,
    diff: input.diff,
    allow: new Set(input.carriedOver.map((finding) => finding.id)),
  });
  if (grounding.dropped.length === 0) {
    return { ranked: input.ranked, verdict: input.verdict };
  }
  const decided = decideVerdict(grounding.grounded, input.policy);
  return {
    ranked: { ...input.ranked, findings: grounding.grounded },
    verdict: {
      ...decided,
      reasons: [
        ...decided.reasons,
        `${grounding.dropped.length} ungrounded finding(s) dropped: ${grounding.dropped
          .map((entry) => `${entry.id} (${entry.reason})`)
          .join("; ")}`,
      ],
    },
  };
};

/**
 * Registers `run_check` once the diff is known, because what the change touched decides
 * which checks are refused. Returns the toolset and the ids the work stage may name.
 */
const registerChecks = (input: {
  engine: Engine;
  config: ResolvedConfig;
  checks: ChecksConfig | undefined;
  diff: GitDiff;
}): { tools: readonly string[]; ids: string[]; guard: ChecksGuard } => {
  const guard = guardChecks({ checks: input.checks, diff: input.diff });
  const declared = input.checks?.checks ?? [];
  if (declared.length === 0) {
    return { tools: [], ids: [], guard };
  }
  registerCheckTools({
    register: input.engine.registerTool,
    run: input.engine.backgroundRun,
    checks: input.checks,
    root: input.config.paths.root,
    guard,
  });
  return {
    tools: CHECK_TOOLS,
    ids: declared
      .filter(
        (check) =>
          guard.allBlocked === undefined &&
          guard.blocked[check.id] === undefined,
      )
      .map((check) => check.id),
    guard,
  };
};

/**
 * Everything a run needs before its first agent turn: config, store, recurrence, the base
 * branch's checks, the engine, and a platform whose capability map has been proved against
 * the tools the servers really expose. Split out so `runReview` reads as the stage flow it
 * is, rather than as a boot sequence with a stage flow at the bottom.
 */
const bootRun = async (
  run: RunContext,
  engine: Engine | undefined,
): Promise<{
  config: ResolvedConfig;
  paths: RunStorePaths;
  recurrence: RecurrenceState;
  base: { ref?: string; checks?: ChecksConfig };
  report: RunReport;
  active: Engine;
  platform: PlatformSession;
}> => {
  const config = await loadConfig(run.root, run.target);
  if (!(await isGitRepo(run.root))) {
    throw new Error(
      `${run.root} is not a git work tree — Yama reviews changes, and there is no history here to compare against`,
    );
  }

  const paths = storePathsForDir(run.storeDir);
  await ensureStore(paths);
  // Read BEFORE this run's report overwrites the previous one.
  const recurrence = await detectRecurrence(paths, run.runId);
  const headSha = await gitHeadSha(run.root);
  const base = await resolveBaseChecks(run, config);

  const report: RunReport = startRunReport({
    run,
    degradations: config.degradations,
    ...(headSha !== undefined ? { headSha } : {}),
  });
  await writeRunReport(paths, report);

  const active =
    engine ??
    (await import("../engine/index.js")).createEngine(
      buildEngineConfig(config, run, {
        ...(base.checks !== undefined ? { checks: base.checks } : {}),
      }),
    );
  registerFsTools({
    register: active.registerTool,
    config: { root: config.paths.root },
  });

  // Said out loud, because its absence is otherwise invisible: with no memory every stage
  // answers having forgotten the one before it, and a stage that fails cannot be helped
  // up — it can only be asked the same question again (TASKS:Y2.5).
  const memoryProblem = memoryDegradation(active.memoryStatus());
  if (memoryProblem !== undefined) {
    config.degradations.push(memoryProblem);
  }

  // MCP servers up, capability map proved against the tools they really expose, and the
  // delivery actions narrowed to what this run can actually perform (TASKS:Y1.3, Y5.4).
  const platform = await connectPlatform({
    engine: active,
    config,
    target: run.target,
    degradations: config.degradations,
  });

  // The preflight marker scan (TASKS:Y7.1): what this repository has ALREADY said on the
  // target. It runs before the first stage, and it is what lets a run whose store CI lost
  // still know it is a re-review.
  const seen = platform.registry.has("comment.list")
    ? withReportedMarkers(
        recurrence,
        await scanReportedFindings({
          engine: active,
          registry: platform.registry,
        }),
      )
    : recurrence;

  return { config, paths, recurrence: seen, base, report, active, platform };
};

/** Rewrites the report where the run has got to: after every stage, and on failure. */
const reportWriter = (input: {
  report: RunReport;
  session: SessionRunner;
  engine: Engine;
  paths: RunStorePaths;
}): ((error?: unknown) => Promise<void>) => {
  const { report, session, engine, paths } = input;
  return async (error?: unknown): Promise<void> => {
    report.stages = session.metrics();
    report.finishedAt = new Date().toISOString();
    const tasks = await engine.tasksApi(session.sessionId);
    // Distinct work, not every copy of it: a report listing one task seventeen times
    // tells a reader nothing except that a tool call stuttered.
    report.tasks = distinctTasks(tasks.tasks).map((task): TaskItem => ({
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.note !== undefined ? { note: task.note } : {}),
    }));
    if (error !== undefined) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    await writeRunReport(paths, report);
  };
};

/**
 * Runs one review, end to end: WarmUp → Task Insertion → Work the checklist → Collate and
 * decide → Delivery. Collate is terminal for local and dry-run targets (PLAN.md section 1);
 * Delivery is config-driven and confirmed by code, never by the agent's account of it.
 *
 * The engine is injectable. A caller that already has one hands it in; everyone else gets
 * the seam, imported lazily so that using Yama as a config or store library never drags
 * the provider stack in with it.
 */
export const runReview = async (
  run: RunContext,
  engine?: Engine,
): Promise<ReviewResult> => {
  const { config, paths, recurrence, base, report, active, platform } =
    await bootRun(run, engine);
  // Capability-mapped read tools, plus whatever config exposed from extra servers
  // (e.g. a code-graph MCP) — review stages only, never delivery.
  const reviewTools = [
    ...platform.registry.reviewTools(),
    ...platform.exposedTools,
  ];
  const session = createSessionRunner({
    engine: active,
    paths,
    sessionId: run.runId,
  });
  const persist = reportWriter({ report, session, engine: active, paths });

  /**
   * One line per finished stage, as it finishes. A review is minutes of silence
   * otherwise — measured at 956s on a real pull request — and silence is
   * indistinguishable from a hang while it is happening. Reads the metrics the session
   * already records, so it invents nothing and costs nothing.
   */
  let reported = 0;
  const announce = (): void => {
    if (run.onProgress === undefined) {
      return;
    }
    const metrics = session.metrics();
    for (const metric of metrics.slice(reported)) {
      const seconds = (metric.durationMs / 1000).toFixed(1);
      run.onProgress(
        `  ${metric.stage.padEnd(14)} ${seconds.padStart(7)}s  ${
          metric.recovered === true
            ? "RECOVERED"
            : metric.trusted
              ? "ok       "
              : "UNTRUSTED"
        }  steps ${metric.stepsUsed ?? 0}${
          (metric.toolsUsed ?? []).length > 0
            ? `  ${(metric.toolsUsed ?? []).join(", ")}`
            : ""
        }`,
      );
    }
    reported = metrics.length;
  };
  const step = async (): Promise<void> => {
    await persist();
    announce();
  };

  try {
    run.onProgress?.("stages");
    const brief = await runWarmUp({ session, config, extraTools: reviewTools });
    await step();

    const insertion = await runTaskInsertion({
      session,
      engine: active,
      run,
      brief: brief.data,
      recurrence,
      extraTools: reviewTools,
      exclude: config.yama.review.exclude,
    });
    announce();
    if (insertion.excluded !== undefined && insertion.excluded.length > 0) {
      // Visible, not silent: what a review did not look at belongs in its own report.
      report.excludedFiles = insertion.excluded;
    }
    if (insertion.uncovered !== undefined && insertion.uncovered.length > 0) {
      report.uncoveredFiles = insertion.uncovered;
    }
    report.recurrence = recurrenceStats({
      recurrence,
      prior: insertion.prior,
      ...(insertion.incremental !== undefined
        ? { incremental: insertion.incremental }
        : {}),
    });
    await persist();
    // Counted off the ENGINE and off the diff, never off the plan's prose: a plan always
    // claims at least one item (the schema pins it), and the run that printed
    // "4 checklist item(s)" one line before failing with "no checklist at all" was
    // reporting exactly that claim.
    const files = insertion.diff.files.map((file) => file.path);
    const prepared = distinctTasks((await active.tasksApi(run.runId)).tasks);
    const coverage = checkCoverage({ files, tasks: insertion.plan.data.tasks });
    run.onProgress?.(
      `  → ${files.length} file(s) to review, ${prepared.length} checklist item(s), ${coverage.covered.length}/${files.length} covered`,
    );

    // The run's ground truth: built by Task Insertion from its own diff, and handed to
    // every stage after it. A stage is an independent call — what its prompt does not
    // carry, it does not have (TASKS:Y3.2).
    const facts = insertion.facts;

    const checks = registerChecks({
      engine: active,
      config,
      checks: base.checks,
      diff: insertion.diff,
    });
    const work = await runWork({
      session,
      engine: active,
      paths,
      brief: brief.data,
      plan: insertion.plan.data,
      extraTools: [...reviewTools, ...checks.tools],
      checks: checks.ids,
      facts,
    });
    await step();

    const collate = await runCollate({
      session,
      paths,
      config,
      brief: brief.data,
      plan: insertion.plan.data,
      findings: work.findings,
      workers: work.workers,
      checklist: work.checklist,
      // The verdict is decided over the FULL open set (TASKS:Y7.1): what this run found,
      // plus everything the last review left open that this one did not settle.
      carriedOver: insertion.prior.open,
      extraTools: reviewTools,
      facts,
    });

    // The groundedness gate (see groundRanked): fabrication dies here, named.
    const { ranked, verdict } = groundRanked({
      ranked: collate.ranked,
      verdict: collate.verdict,
      diff: insertion.diff,
      carriedOver: insertion.prior.open,
      policy: config.yama.verdict,
    });
    // The ledger records what SURVIVED the gate (TASKS:Y7.1). Written any earlier, a
    // dropped finding came back as a prior-open carry-over and blessed its own
    // resurrection past grounding on the next run.
    await writeLedger(paths, {
      updatedAt: new Date().toISOString(),
      findings: ranked.findings,
    });

    // What the run said it could not establish. Collected by the stages, reported here
    // instead of dying in an artifact nobody opens.
    const unknowns = [
      ...brief.data.gaps.map((gap) => `warmup: ${gap}`),
      ...work.output.data.openQuestions.map(
        (question: string) => `work: ${question}`,
      ),
    ];
    if (unknowns.length > 0) {
      report.unknowns = unknowns;
    }
    report.gates = gateStats({
      metrics: session.metrics(),
      work,
      findingsAfterDedupe: ranked.findings.length,
    });
    // A run the gate had to rescue does not get to say a change is fine (TASKS:Y4.1).
    // `recovered` was recorded and printed and consulted by nothing until now.
    const decided = withRecoveryCaveat(verdict, session.metrics());
    report.verdict = decided;
    await step();
    run.onProgress?.(
      `  → verdict ${decided.decision.toUpperCase()} over ${ranked.findings.length} finding(s)`,
    );

    // Last checkpoint before anything reaches the pull request (TASKS:Y4.7). A run that
    // worked no item and found nothing over a real change has not reviewed it, and the
    // one thing it must never do is say so out loud as an approval. It fails HERE,
    // before delivery: an approval nobody earned is worse on a pull request than a red
    // check, and the run store keeps everything a human needs to see why.
    const nothing = reviewEstablishedNothing({
      changedFiles: insertion.diff.files.length,
      checklist: work.checklist.tasks,
      findings: ranked.findings.length,
    });
    if (nothing !== undefined) {
      throw new StageError("work", nothing, work.output.path ?? paths.dir);
    }

    report.delivery = deliveryStats(
      await runDelivery({
        session,
        engine: active,
        config,
        registry: platform.registry,
        actions: platform.deliveryActions,
        runId: run.runId,
        ranked,
        verdict: decided,
        summary: collate.output.data.summary,
        changeSummary: insertion.plan.data.changeSummary,
        riskAreas: insertion.plan.data.riskAreas,
        checklistComplete: work.checklist.complete,
        facts,
        dryRun: run.dryRun,
      }),
      // Intent from CONFIG, not from the probe: a repo that turned verdict delivery on
      // is owed proof even on the runs where every capability degraded away.
      { verdictProofRequired: config.yama.delivery.verdict },
    );
    await step();

    return {
      ranked,
      verdict: decided,
      tasks: report.tasks,
      report,
    };
  } catch (error) {
    await persist(error);
    throw error;
  }
};

export { SYSTEM_INSTRUCTION } from "./instruction.js";
export { StageError } from "./errors.js";
export {
  buildEngineConfig,
  toCommandPolicy,
  toEngineModel,
} from "./engineConfig.js";
export {
  deliveryStats,
  gateStats,
  recurrenceStats,
  renderRunSummary,
  startRunReport,
} from "./report.js";
export { createSessionRunner } from "./session.js";
export { renderDoctorReport, runDoctor } from "./doctor.js";
export {
  buildLearnPrompt,
  renderLearnResult,
  renderThread,
  runLearn,
} from "./learn.js";
export { ensureGitignore, renderInitResult, scaffold } from "./init.js";
export { CI_DIR, templateManifest, templatesDir } from "./templates.js";
