/**
 * The shell: one main session driven through the stages, with deterministic gates between
 * them (PLAN.md section 1). Stages are agentic; everything that bounds them is plain code.
 *
 * The run report is written before the first stage and rewritten after every one, so a run
 * that dies in the middle still leaves a store a human can read.
 */
import { loadConfig } from "../config/index.js";
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
import { decideVerdict, groundFindings } from "../gates/index.js";
import type {
  ChecksConfig,
  ChecksGuard,
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
    report.tasks = tasks.tasks.map((task): TaskItem => ({
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

  try {
    const brief = await runWarmUp({ session, config, extraTools: reviewTools });
    await persist();

    const insertion = await runTaskInsertion({
      session,
      engine: active,
      run,
      brief: brief.data,
      recurrence,
      extraTools: reviewTools,
    });
    report.recurrence = recurrenceStats({
      recurrence,
      prior: insertion.prior,
      ...(insertion.incremental !== undefined
        ? { incremental: insertion.incremental }
        : {}),
    });
    await persist();

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
    });
    await persist();

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

    report.gates = gateStats({
      metrics: session.metrics(),
      work,
      findingsAfterDedupe: ranked.findings.length,
    });
    report.verdict = verdict;
    await persist();

    report.delivery = deliveryStats(
      await runDelivery({
        session,
        engine: active,
        config,
        registry: platform.registry,
        actions: platform.deliveryActions,
        runId: run.runId,
        ranked,
        verdict,
        summary: collate.output.data.summary,
        changeSummary: insertion.plan.data.changeSummary,
        riskAreas: insertion.plan.data.riskAreas,
        checklistComplete: work.checklist.complete,
        dryRun: run.dryRun,
      }),
      // Intent from CONFIG, not from the probe: a repo that turned verdict delivery on
      // is owed proof even on the runs where every capability degraded away.
      { verdictProofRequired: config.yama.delivery.verdict },
    );
    await persist();

    return {
      ranked,
      verdict,
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
