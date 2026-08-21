/**
 * One review, end to end.
 *
 * This is the assembly: it constructs the runtime, resolves the change, builds
 * the tool surface, opens the session, and hands a fully-bound
 * `PipelineDependencies` to the stage machine. The decisions all live elsewhere
 * — this file wires, it does not judge.
 *
 * The shape follows the architecture's S0–S6 contract exactly. The pipeline asks
 * for four things (take a turn, read the change, run the checks, re-read the
 * comments) and each is satisfied here by the real implementation the rest of
 * the codebase was written against.
 */

import type {
  ChangeSet,
  CheckRunResult,
  ExistingComment,
  PipelineDependencies,
  PipelineResult,
  PostedFinding,
  PostingContext,
  PrArtifact,
  PullRequestCandidate,
  ReviewRunOptions,
  RunContext,
  StageName,
  TurnReport,
  YamaRuntime,
  YamaTool,
} from "../types/index.js";
import {
  CapabilityResolver,
  assertLiveCapabilities,
} from "../connections/Capabilities.js";
import { createRuntime, registerDelegates } from "./Runtime.js";
import {
  applyStageTools,
  enabledSubAgents,
  excludedToolsForStage,
} from "./ToolExposure.js";
import { SessionRunner } from "./SessionRunner.js";
import { runReviewPipeline } from "./ReviewPipeline.js";
import { memberAt } from "../config/ModelChain.js";
import { normalizeComments } from "../connections/Comments.js";
import { capabilityParams, targetParams } from "../connections/invoke.js";
import { FindingLedger } from "../findings/Ledger.js";
import { gateFindings } from "../findings/Gate.js";
import { toFindings } from "../checks/Runner.js";
import { postMissingFindings } from "../tools/posting.js";
import { buildTaskMessage } from "../agents/systemInstruction.js";
import { DELEGATION_CAPS, SUB_AGENTS } from "../agents/subAgents.js";
import { buildYamaTools } from "../tools/registry.js";
import { buildWorkspaceTools } from "../tools/workspace.js";
import { createTurnBinding } from "../tools/progress.js";
import { mergeTurnOutcome, turnOutcomeSchema } from "../agents/turnContract.js";
import { createInlineJudge } from "../judge/inline.js";
import { computeRunMetrics } from "../judge/scorecard.js";
import { resolvePrompts } from "../prompts/PromptStore.js";
import { promptIdForSubAgent } from "../prompts/local.js";
import { subAgentReportSchema } from "../agents/subAgents.js";
import { buildFindingId } from "../findings/Markers.js";
import { readLocalChangeSet } from "./LocalDiff.js";
import { needsExtraction, runConfiguredChecks } from "../checks/execute.js";
import { extractFindings } from "../checks/extract.js";
import { flaggedLocations } from "../checks/Runner.js";
import { assembleRun, buildRunMessage, resolveBranch } from "./RunAssembly.js";
import {
  loadArtifact,
  recordRun,
  saveArtifact,
} from "../artifacts/PrArtifact.js";
import { artifactDir } from "../artifacts/PrArtifact.js";

/** Run tasks through the run's concurrency pool. */
function pooled(context: RunContext) {
  return async <T>(tasks: Array<() => Promise<T>>): Promise<T[]> =>
    Promise.all(
      tasks.map(async (task) => {
        const release = await context.pool.acquire(context.signal);
        try {
          return await task();
        } finally {
          release();
        }
      }),
    );
}

/**
 * Resolve `--branch` to a pull request number before the agent starts.
 *
 * Deterministic on purpose. S0 can still resolve a branch agentically, and it
 * remains the fallback, but the ambiguous case is exactly where a model should
 * not be improvising: picking one of two open pull requests and reviewing the
 * wrong one is worse than stopping and naming both. Where the provider can list
 * pull requests, code decides — and it refuses to guess.
 */
async function resolveBranchToPullRequest(
  runtime: YamaRuntime,
  resolver: CapabilityResolver,
  identity: { owner: string; repo: string; branch: string },
): Promise<{ pullRequestId?: number; warning?: string }> {
  const capability = resolver.find("findPullRequest", "resolve");
  if (!capability) {
    // No listing capability: S0 asks the agent to find it instead.
    return {};
  }

  let result: unknown;
  try {
    result = await runtime.invoke(
      capability.toolName,
      capabilityParams(capability, {
        ...targetParams({ owner: identity.owner, repo: identity.repo }),
        state: "open",
      }),
    );
  } catch (error) {
    return {
      warning:
        `Pull requests could not be listed to resolve branch "${identity.branch}" ` +
        `(${(error as Error).message}). The agent will try to find it instead.`,
    };
  }

  const resolution = resolveBranch(
    identity.branch,
    normalizeCandidates(result),
  );
  return resolution.resolved
    ? { pullRequestId: resolution.pullRequestId }
    : { warning: resolution.reason };
}

/** Shape-driven, because the field names differ per provider and code may not care. */
function normalizeCandidates(result: unknown): PullRequestCandidate[] {
  const list = Array.isArray(result)
    ? result
    : ((result as Record<string, unknown>)?.values ??
      (result as Record<string, unknown>)?.items ??
      (result as Record<string, unknown>)?.pull_requests ??
      (result as Record<string, unknown>)?.pullRequests ??
      []);

  return (Array.isArray(list) ? list : [])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const head = (record.head ?? record.source ?? {}) as Record<
        string,
        unknown
      >;
      const branch =
        record.sourceBranch ??
        head.ref ??
        (head.branch as Record<string, unknown> | undefined)?.name ??
        record.branch;
      return {
        id: Number(record.number ?? record.id ?? Number.NaN),
        ...(typeof branch === "string" ? { sourceBranch: branch } : {}),
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.state === "string" ? { state: record.state } : {}),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.id));
}

/**
 * Read the pull request's existing comments.
 *
 * Markers in these comments are the authority on what previous runs already
 * said, so a failure here must not read as "nothing was said" — that would
 * duplicate every finding on every re-run. It returns undefined on failure and
 * the caller reports it.
 */
async function readComments(
  runtime: YamaRuntime,
  resolver: CapabilityResolver,
  target: Record<string, unknown>,
  stage: StageName,
  onError?: (message: string) => void,
): Promise<ExistingComment[] | undefined> {
  const capability = resolver.find("listComments", stage);
  if (!capability) {
    return [];
  }
  try {
    return normalizeComments(
      await runtime.invoke(
        capability.toolName,
        capabilityParams(capability, target),
      ),
    );
  } catch (error) {
    // Never swallowed. An unreadable comment list means an empty marker scan,
    // which means every finding from every earlier run looks unreported — the
    // run would then post all of them again. The caller turns this into a
    // warning; returning an empty list here would make it invisible.
    onError?.((error as Error).message);
    return undefined;
  }
}

/**
 * The pull request's description, as the provider currently holds it.
 *
 * S5 verifies against this rather than against the agent's claim to have
 * written one. Undefined means unreadable, which is reported — an unreadable
 * description must not read as an empty one, or the stage would fail a run that
 * did the work.
 */
async function readDescription(
  runtime: YamaRuntime,
  resolver: CapabilityResolver,
  target: Record<string, unknown>,
  onError?: (message: string) => void,
): Promise<string | undefined> {
  const capability = resolver.find("readPullRequest", "enhance");
  if (!capability) {
    return undefined;
  }
  try {
    const result = await runtime.invoke(
      capability.toolName,
      capabilityParams(capability, target),
    );
    const record = (result ?? {}) as Record<string, unknown>;
    const body =
      record.body ??
      record.description ??
      (record.pull_request as Record<string, unknown> | undefined)?.body ??
      (record.pullRequest as Record<string, unknown> | undefined)?.description;
    return typeof body === "string" ? body : "";
  } catch (error) {
    onError?.((error as Error).message);
    return undefined;
  }
}

/** Approvals, for the ownership check. Absent is reported, never assumed empty. */
async function readApprovals(
  runtime: YamaRuntime,
  resolver: CapabilityResolver,
  target: Record<string, unknown>,
  onError?: (message: string) => void,
): Promise<string[] | undefined> {
  const capability = resolver.find("listApprovals", "checks");
  if (!capability) {
    return undefined;
  }
  try {
    const result = await runtime.invoke(
      capability.toolName,
      capabilityParams(capability, target),
    );
    const list = Array.isArray(result)
      ? result
      : (((result as Record<string, unknown>)?.reviews as unknown[]) ?? []);
    return (Array.isArray(list) ? list : [])
      .filter((entry) => {
        const state = String(
          (entry as Record<string, unknown>)?.state ??
            (entry as Record<string, unknown>)?.status ??
            "",
        );
        return /approved/i.test(state);
      })
      .map((entry) => {
        const user = (entry as Record<string, unknown>)?.user as
          | Record<string, unknown>
          | undefined;
        return String(user?.login ?? user?.username ?? "");
      })
      .filter(Boolean);
  } catch (error) {
    // Reported, never assumed empty. Unknown approvals must read as unknown:
    // treating them as "nobody approved" would let the ownership check block a
    // pull request that owners had in fact already signed off.
    onError?.((error as Error).message);
    return undefined;
  }
}

/**
 * Run a review.
 *
 * Everything that can fail without a model call is done before the first one:
 * connections, capabilities, the diff, the artifact. A misconfiguration surfaces
 * in seconds rather than after twenty minutes of review that cannot be posted.
 */
export async function runReview(options: ReviewRunOptions): Promise<{
  result: PipelineResult;
  runtime: YamaRuntime;
  warnings: string[];
  posted: PostedFinding[];
}> {
  const { config, context, chains, git } = options;
  const warnings: string[] = [];

  // Prompts first: resolved once, then fixed for the run, so every turn sends
  // byte-identical instructions and the provider's prompt cache still applies.
  // Every failure path here lands on the text Yama ships — a prompt platform is
  // never allowed to be the reason a review cannot run.
  const prompts = await resolvePrompts({
    config: config.prompts,
    env: options.env ?? process.env,
  });
  warnings.push(...prompts.warnings);

  const runtime = await createRuntime({
    config,
    chains,
    context,
    role: "main",
    ...(options.logger ? { logger: options.logger } : {}),
  });

  // A live run that cannot post would review the pull request and throw the
  // findings away, which reads to the team as "Yama found nothing".
  assertLiveCapabilities(runtime.capabilities, context.mode, config);
  const resolver = new CapabilityResolver(runtime.capabilities);

  for (const gap of runtime.capabilities.missing) {
    warnings.push(
      `Capability "${gap.capability}" declared on "${gap.serverId}" as "${gap.declared}" ` +
        `is not advertised by that server.` +
        (gap.available.length > 0
          ? ` It offers: ${gap.available.slice(0, 12).join(", ")}${gap.available.length > 12 ? ", …" : ""}.`
          : ""),
    );
  }

  // ── which pull request ────────────────────────────────────────────────────
  //
  // Before anything expensive. A branch that resolves to two open pull requests
  // is reported here rather than discovered twenty minutes in.
  if (context.identity.pullRequestId === undefined && context.identity.branch) {
    const resolution = await resolveBranchToPullRequest(runtime, resolver, {
      owner: context.identity.owner,
      repo: context.identity.repo,
      branch: context.identity.branch,
    });
    if (resolution.pullRequestId !== undefined) {
      context.identity.pullRequestId = resolution.pullRequestId;
    }
    if (resolution.warning) {
      warnings.push(resolution.warning);
    }
  }

  // ── the change ────────────────────────────────────────────────────────────
  const changeSet = await readLocalChangeSet({
    git,
    cwd: config.projectRoot,
    base: options.base,
    head: options.head,
    excludePatterns: config.review.excludePatterns,
    maxFiles: config.review.maxFiles,
    deletions: config.review.deletions,
  });

  // ── what earlier runs already said ────────────────────────────────────────
  const target = targetParams({
    owner: context.identity.owner,
    repo: context.identity.repo,
    ...(context.identity.pullRequestId !== undefined
      ? { pullRequestId: context.identity.pullRequestId }
      : {}),
  });

  let commentReadError: string | undefined;
  const comments = await readComments(
    runtime,
    resolver,
    target,
    "resolve",
    (message) => {
      commentReadError = message;
    },
  );
  if (comments === undefined) {
    warnings.push(
      `Existing comments could not be read (${commentReadError ?? "unknown error"}). ` +
        "Deduplication against earlier runs is degraded for this run — findings may repeat.",
    );
  }

  const stateRoot = config.state.path;
  const loaded = await loadArtifact(
    stateRoot,
    context.identity.pullRequestId ?? 0,
  );
  const artifact: PrArtifact = loaded.artifact;
  if (loaded.warning) {
    warnings.push(loaded.warning);
  }

  const assembly = assembleRun({
    comments: comments ?? [],
    artifact,
    rules: config.rules,
    product: config.product,
    impactLog: config.impactLog,
    identity: context.identity,
    ...(config.learn.botIdentity
      ? { botIdentity: config.learn.botIdentity }
      : {}),
  });
  warnings.push(...assembly.warnings);

  let approvalReadError: string | undefined;
  const approvals = await readApprovals(
    runtime,
    resolver,
    target,
    (message) => {
      approvalReadError = message;
    },
  );
  if (approvals === undefined && resolver.find("listApprovals", "checks")) {
    warnings.push(
      `Approvals could not be read (${approvalReadError ?? "unknown error"}). Ownership ` +
        "rules that require approval are reported as unknown rather than unsatisfied.",
    );
  }

  // ── the tool surface ──────────────────────────────────────────────────────
  const ledger = new FindingLedger();
  const binding = createTurnBinding();
  let checkResults: CheckRunResult[] = [];

  // How many independent specialists raised each finding. Accumulates across
  // turns and is read by the judge at call time, so a defect two specialists
  // found from different angles scores higher than one found once — which is
  // what makes fanning out worth its cost rather than just louder.
  const agreement = new Map<string, number>();

  const judge = createInlineJudge({
    host: runtime.host,
    chain: chains.judge,
    context,
    instruction: prompts.get("yama-judge"),
    threshold: config.review.confidenceThreshold,
    agreement,
  });

  const toolDependencies = {
    entries: assembly.entries,
    changeSet,
    ledger,
    guards: config.guards,
    ownership: config.ownership,
    get checkResults(): CheckRunResult[] {
      return checkResults;
    },
    ...(approvals ? { approvals } : {}),
    ...(context.identity.author ? { author: context.identity.author } : {}),
    alreadyReported: assembly.alreadyReported,
    suppressed: assembly.suppressed,
    get checkFlagged(): ReadonlySet<string> {
      return flaggedLocations(checkResults);
    },
    ...(judge ? { judge } : {}),
    onWarnings: (messages: string[]) => warnings.push(...messages),
    confidenceThreshold: config.review.confidenceThreshold,
    changedLinesOnly: config.review.changedLinesOnly,
    dryRun: context.mode === "dry-run",
  };

  const tools: YamaTool[] = [
    ...buildYamaTools(toolDependencies),
    ...buildWorkspaceTools({ projectRoot: config.projectRoot }),
    binding.tool,
  ];

  // ── delegation ────────────────────────────────────────────────────────────
  const specialists = enabledSubAgents(SUB_AGENTS, undefined).map(
    (definition) => {
      // A specialist's instruction is manageable on the prompt platform too:
      // the sub-agents are where wording is iterated most, and shipping a
      // release to retune the security specialist is the friction this removes.
      const promptId = promptIdForSubAgent(definition.id);
      return promptId
        ? { ...definition, instructions: prompts.get(promptId) }
        : definition;
    },
  );
  const delegation = await registerDelegates({
    host: runtime.host,
    definitions: specialists,
    tools,
    mcpTools: resolver.toolNames("review", "sub"),
    // Cheap specialists run the cheap chain; the impact specialist, which has to
    // reason about a running product, gets the strong one.
    member: (tier) =>
      memberAt(tier === "cheap" ? chains.subAgent : chains.review, 0),
    // Both caps come from the concurrency tier. `maxConcurrent` is the
    // process-wide ceiling; `delegationsPerTurn` bounds one turn's fan-out, so a
    // single turn cannot queue the whole pool behind itself.
    maxConcurrent: DELEGATION_CAPS[context.concurrency].maxConcurrent,
    delegationsPerTurn: DELEGATION_CAPS[context.concurrency].maxPerTurn,
  });
  runtime.delegates = delegation.registered;
  warnings.push(...delegation.warnings);

  // ── the session ───────────────────────────────────────────────────────────
  const session = new SessionRunner({
    host: runtime.host,
    context,
    chain: chains.review,
    systemInstruction: prompts.get("yama-review"),
    // A turn boundary every N steps, when the operator configured one. Not a
    // work budget: the next turn resumes in the same session where this one
    // stopped. It bounds how much history a single inner tool loop accumulates
    // before the supervisor gets to look — uncapped turns ran to 488K tokens in
    // production and left the supervisor two interventions in 45 minutes.
    ...(config.review.maxStepsPerTurn !== undefined
      ? { maxStepsPerTurn: config.review.maxStepsPerTurn }
      : {}),
    onChainExhausted: (error) => {
      warnings.push(
        `No model in the chain could serve this run: ${error.message} Every remaining ` +
          `stage is recorded as failed without calling a model again.`,
      );
    },
    onFailover: ({ from, to, reason }) => {
      warnings.push(
        `Model fell back from ${[from.provider, from.model].filter(Boolean).join("/")}` +
          (to
            ? ` to ${[to.provider, to.model].filter(Boolean).join("/")}`
            : " with nothing left to try") +
          `: ${reason}`,
      );
    },
  });

  // The description as it stood before this run, so S5 can prove it changed
  // rather than accept that it exists.
  const canReadDescription =
    resolver.find("readPullRequest", "enhance") !== undefined &&
    config.review.stages.enhance;
  const baselineDescription = canReadDescription
    ? await readDescription(runtime, resolver, target)
    : undefined;

  const posting: PostingContext = {
    resolver,
    invoke: runtime.invoke,
    mode: context.mode,
    stage: "post",
    ...(config.learn.botIdentity
      ? { botIdentity: config.learn.botIdentity }
      : {}),
    target,
  };

  // ── the turn, bound ───────────────────────────────────────────────────────
  //
  // Stage tools are re-applied every turn rather than once per stage. A stage
  // can take many turns, and the exposure rule is what stops a review turn
  // reading an attacker-controlled diff from reaching a posting tool.
  let firstTurn = true;
  let delegationCount = 0;
  let tokensUsed = 0;
  const startedAt = Date.now();
  const turn = async (
    message: string,
    stage: StageName,
  ): Promise<TurnReport> => {
    applyStageTools(runtime.host, tools, stage, "main");
    binding.begin(stage);
    // Gate activity is attributed per turn: groups completed in a turn count
    // as gated only when THIS turn actually submitted to the gate. The old
    // run-cumulative check (`acceptedIds.size > 0`) let one early acceptance
    // mark every later group gated — a group could pass S2's predicate
    // without ever being submitted at all.
    const submittedBefore = ledger.snapshot().submitted;

    const opening = firstTurn
      ? [
          buildTaskMessage({
            owner: context.identity.owner,
            repo: context.identity.repo,
            ...(context.identity.pullRequestId !== undefined
              ? { pullRequestId: context.identity.pullRequestId }
              : {}),
            ...(context.identity.branch
              ? { branch: context.identity.branch }
              : {}),
          }),
          buildRunMessage(assembly, changeSet),
          "",
        ].join("\n")
      : "";
    firstTurn = false;

    const result = await session.turn(`${opening}${message}`, {
      stage,
      operation: `review-${stage}`,
      // The turn answers against a schema as well as calling report_progress.
      // Where the provider supports tools and a schema together this is
      // enforced at the wire; where it does not, the runtime coerces the
      // turn's final text. Either way the turn ends in a result the harness can
      // read rather than in prose it has to guess at.
      schema: turnOutcomeSchema,
      // Stage scoping, enforced against the model and not only against Yama's
      // own call sites: during a review turn the posting tools do not exist.
      excludeTools: excludedToolsForStage(
        runtime.capabilities.resolved,
        stage,
        "main",
        runtime.capabilities.registrations.flatMap(
          (registration) => registration.tools,
        ),
      ),
    });

    if (result.jsonTruncated) {
      warnings.push(
        `Turn ${result.turn} (${stage}) hit the output token limit while writing its ` +
          `structured result, so part of what it reported may be missing. Raise ` +
          `ai.maxTokens.`,
      );
    }

    // Specialists report against a schema. Their findings are CANDIDATES — the
    // main agent still has to put each through the gate — but counting who
    // raised what is how agreement becomes evidence.
    delegationCount += result.delegateResults.length;
    tokensUsed += result.usage?.total ?? 0;

    for (const delegate of result.delegateResults) {
      const parsed = subAgentReportSchema.safeParse(delegate.result);
      if (!parsed.success) {
        continue;
      }
      const ids = new Set(
        parsed.data.findings.map((finding) =>
          buildFindingId({
            severity: finding.severity,
            title: finding.title,
            ...(finding.filePath ? { filePath: finding.filePath } : {}),
            ...(finding.line !== undefined && finding.line !== null
              ? { line: finding.line }
              : {}),
          }),
        ),
      );
      for (const id of ids) {
        agreement.set(id, (agreement.get(id) ?? 0) + 1);
      }
    }

    // The tool's record and the turn's structured answer, folded together. A
    // turn is legible when either channel worked.
    const progress = mergeTurnOutcome(binding.drain(), result.structuredData);

    return {
      ...(progress.plan
        ? {
            plan: {
              groups: progress.plan.groups.map((group) => ({
                ...group,
                reviewed: false,
                gated: false,
              })),
              declined: progress.plan.declined,
            },
          }
        : {}),
      completedGroups: [
        ...new Set([...progress.completedGroups, ...progress.cleanGroups]),
      ],
      // A group the agent declared clean was gated in the only sense that
      // matters: it reached a decision. Groups completed this turn count as
      // gated only when this turn actually put findings through the gate —
      // accepted OR rejected, because a group whose every submission was
      // legitimately refused (duplicates, below confidence) still did its duty
      // and must not loop the stage machine forever.
      gatedGroups: [
        ...new Set([
          ...progress.cleanGroups,
          ...(ledger.snapshot().submitted > submittedBefore
            ? progress.completedGroups
            : []),
        ]),
      ],
      claimedFindings: progress.claimedFindings,
      ...(progress.resolved ? { resolved: progress.resolved } : {}),
      ...(progress.descriptionUpdated ? { descriptionUpdated: true } : {}),
      descriptionSections: progress.descriptionSections,
      toolCalls: result.toolCalls,
      partial: result.partial,
      done: progress.done,
    };
  };

  // ── run it ────────────────────────────────────────────────────────────────
  const dependencies: PipelineDependencies = {
    config,
    context,
    ledger,
    comments: comments ?? [],
    entries: assembly.entries,
    posting,
    ...(approvals ? { approvals } : {}),
    turn,
    buildChangeSet: async () => changeSet,
    runChecks: async (set: ChangeSet) => {
      const raw = await runConfiguredChecks({
        config,
        changeSet: set,
        projectRoot: config.projectRoot,
        pool: pooled(context),
        signal: context.signal,
        ...(options.isFork !== undefined ? { isFork: options.isFork } : {}),
      });

      // `parse: agent` checks ran but produced no findings a parser could read.
      // Their raw output goes through one schema-bound extraction pass each, on
      // the cheap chain, before the agent ever sees the results.
      const pending = needsExtraction(config, raw);
      if (pending.length === 0) {
        checkResults = raw;
        return checkResults;
      }

      const byId = new Map(
        config.checks.checks.map((check) => [check.id, check]),
      );
      const extracted = new Map<string, CheckRunResult>();
      await Promise.all(
        pending.map(async (result) => {
          const check = byId.get(result.checkId);
          if (!check) {
            return;
          }
          const outcome = await extractFindings(result, check, {
            host: runtime.host,
            chain: chains.extraction,
            context,
            instruction: prompts.get("yama-extraction"),
          });
          warnings.push(...outcome.warnings);
          extracted.set(result.checkId, outcome.result);
        }),
      );

      checkResults = raw.map(
        (result) => extracted.get(result.checkId) ?? result,
      );
      return checkResults;
    },
    readComments: async () =>
      (await readComments(runtime, resolver, target, "post")) ?? comments ?? [],
    // Check findings go through the same gate as everything else — deduped
    // against earlier runs, held to the same invariants — and then onto the
    // pull request. They skip the judge: `gateFindings` only scores findings
    // whose source is the agent, and a compiler error is not a claim to weigh.
    publishCheckFindings: async (results: CheckRunResult[]) => {
      const candidates = results.flatMap((result) => toFindings(result));
      if (candidates.length === 0) {
        return { posted: 0, rejected: 0 };
      }

      const gated = gateFindings({
        findings: candidates,
        changeSet,
        alreadyReported: assembly.alreadyReported,
        alreadyAccepted: ledger.acceptedIds,
        suppressed: assembly.suppressed,
        // Not passed: these findings ARE what flagged those locations, so
        // filtering them against it would reject every one of them.
        checkFlagged: new Set<string>(),
        confidenceThreshold: config.review.confidenceThreshold,
        changedLinesOnly: config.review.changedLinesOnly,
        guards: config.guards,
        dryRun: context.mode === "dry-run",
      });

      ledger.recordGate(gated);
      const before = ledger.posted.length;
      await postMissingFindings({ ...posting, stage: "checks" }, ledger);
      return {
        posted: ledger.posted.length - before,
        rejected: gated.rejected.length,
      };
    },
    ...(canReadDescription
      ? {
          readDescription: async () =>
            readDescription(runtime, resolver, target, (message) =>
              warnings.push(
                `The pull request description could not be read back (${message}), so the ` +
                  `enhancement stage could not be verified against the pull request.`,
              ),
            ),
        }
      : {}),
    ...(baselineDescription !== undefined ? { baselineDescription } : {}),
    descriptionInstruction: prompts.get("yama-description"),
  };

  const result = await runReviewPipeline(dependencies);

  // The run's own scorecard. Self-reported metrics only — coverage, noise,
  // gate behaviour — and labelled that way wherever they are shown. Precision
  // and recall need ground truth, which does not exist until a human has acted
  // on the comments, so `yama learn` computes those on merge.
  const planned = new Set(
    (result.review.plan?.groups ?? []).flatMap((group) => group.paths),
  );
  const examined = new Set(
    (result.review.plan?.groups ?? [])
      .filter((group) => group.reviewed)
      .flatMap((group) => group.paths),
  );
  result.metrics = computeRunMetrics({
    ledger: ledger.snapshot(),
    stages: result.stages.outcomes,
    filesPlanned: planned.size,
    filesExamined: examined.size,
    changedLines: changeSet.totalAdditions + changeSet.totalDeletions,
    durationMs: Date.now() - startedAt,
    turns: result.review.turns,
    delegations: delegationCount,
    ...(tokensUsed > 0 ? { tokensUsed } : {}),
  });
  result.posted = ledger.posted;

  // ── carry this run forward ────────────────────────────────────────────────
  if (
    context.identity.pullRequestId !== undefined &&
    context.mode !== "dry-run"
  ) {
    try {
      await saveArtifact(
        stateRoot,
        recordRun(artifact, {
          sha: changeSet.headSha ?? options.head,
          at: new Date().toISOString(),
          decision: result.verdict.decision,
          ledger: ledger.snapshot(),
          degradedStages: result.stages.degradedStages,
          ...(result.review.interventions.length > 0
            ? { contextAppend: result.review.interventions.join("\n") }
            : {}),
        }),
      );
    } catch (error) {
      warnings.push(
        `This run's artifact could not be written to ${artifactDir(stateRoot, context.identity.pullRequestId)}: ` +
          `${(error as Error).message}. The next run deduplicates from the pull ` +
          `request's comment markers instead.`,
      );
    }
  }

  return { result, runtime, warnings, posted: ledger.posted };
}
