/**
 * The review pipeline — S0 to S6, exactly as the architecture specifies.
 *
 * Every stage has an exit predicate. Failing it re-prompts the agent IN THE SAME
 * SESSION, naming exactly what is missing, bounded by
 * `remediation.maxAttemptsPerStage`. After that the stage is recorded degraded
 * and the summary says so.
 *
 * The stages are a completion contract, not a script. Inside S2 the agent works
 * its own plan: which group, in what order, whether to delegate, when to gate,
 * when to post. A supervisor observes between turns and steers on drift, waste
 * or compaction — it never dictates the next move.
 *
 * There is NO turn count and NO step budget. The review-stage loop ends when the
 * agent says it is finished, when its exit predicate is met, or when waste
 * signals show it has stopped working. Hang protection lives where the runtime
 * already provides it: stall and tool timeouts, and the caller's abort signal.
 */

import type {
  ChangeSet,
  CheckRunResult,
  PipelineDependencies,
  PipelineResult,
  PostingContext,
  ReviewRunOutcome,
  ReviewState,
  StageCheck,
  StageDefinition,
  StageName,
  StageOutcome,
  TurnLoopEnd,
  TurnReport,
  Verdict,
} from "../types/index.js";
import {
  missing,
  passed,
  renderRemediation,
  runStages,
} from "./StageMachine.js";
import { supervise } from "./Supervisor.js";
import { deriveVerdict } from "./verdict.js";
import { evaluateGuards } from "../policy/guards.js";
import { evaluateOwnership } from "../checks/builtin/owners.js";
import { checkOutcomes, failedBlockingChecks } from "../checks/Runner.js";
import { renderSummaryComment } from "../tools/commentFormat.js";
import { deriveImpactReport } from "../product/Capabilities.js";
import {
  beginReview,
  postMissingFindings,
  postOwnersComment,
  postSummary,
  setReviewStatus,
  submitReview,
} from "../tools/posting.js";

const forStage = (
  context: PostingContext,
  stage: StageName,
): PostingContext => ({ ...context, stage });

export async function runReviewPipeline(
  dependencies: PipelineDependencies,
): Promise<PipelineResult> {
  const { config, context, ledger } = dependencies;

  let changeSet: ChangeSet | undefined;
  let checksPromise: Promise<CheckRunResult[]> = Promise.resolve([]);
  let checks: CheckRunResult[] = [];
  let checksError: string | undefined;
  const postingNotes: string[] = [];
  let comments = dependencies.comments;
  let verdict: Verdict | undefined;
  let description: string | undefined;
  let checkFindingsPosted = 0;
  let summaryPosted = false;
  let statusRecorded = false;
  let partialSoFar = false;
  let degradedSoFar: StageName[] = [];

  const state: ReviewState = {
    plan: { groups: [], declined: [] },
    claimedFindings: 0,
    gateSubmissions: 0,
    descriptionUpdated: false,
    descriptionSections: [],
    unposted: [],
  };

  const review: ReviewRunOutcome = {
    turnLoopEnd: "agent-finished",
    turns: 0,
    interventions: [],
  };

  const absorb = (report: TurnReport): void => {
    if (report.plan) {
      state.plan = mergePlan(state.plan, report.plan);
    }
    for (const id of report.completedGroups ?? []) {
      const group = state.plan.groups.find((entry) => entry.id === id);
      if (group) {
        group.reviewed = true;
      }
    }
    for (const id of report.gatedGroups ?? []) {
      const group = state.plan.groups.find((entry) => entry.id === id);
      if (group) {
        group.gated = true;
      }
    }
    state.claimedFindings += report.claimedFindings ?? 0;
    state.gateSubmissions += (report.gatedGroups ?? []).length;
    if (report.descriptionUpdated) {
      state.descriptionUpdated = true;
      state.descriptionSections = [
        ...new Set([
          ...state.descriptionSections,
          ...(report.descriptionSections ?? []),
        ]),
      ];
    }
    if (report.resolved) {
      Object.assign(context.identity, report.resolved);
    }
    state.unposted = ledger.unposted;
  };

  const stages: StageDefinition[] = [
    // ── S0 RESOLVE ─────────────────────────────────────────────────────────
    {
      name: "resolve",
      run: async () => {
        absorb(
          await dependencies.turn(openingMessage(dependencies), "resolve"),
        );
        comments = await dependencies.readComments();
        changeSet = await dependencies.buildChangeSet();
      },
      check: (): StageCheck => {
        const gaps: string[] = [];
        if (context.identity.pullRequestId === undefined) {
          gaps.push("pull request number");
        }
        if (!context.identity.headSha) {
          gaps.push("head commit");
        }
        if (!changeSet) {
          gaps.push("changed files");
        }
        return gaps.length === 0
          ? passed
          : missing(
              gaps,
              "The pull request could not be identified. If several match the branch, " +
                "name the candidates rather than choosing one.",
            );
      },
      remediate: async (check) => {
        absorb(
          await dependencies.turn(
            renderRemediation("resolve", check),
            "resolve",
          ),
        );
      },
    },

    // ── S1 ORIENT ──────────────────────────────────────────────────────────
    {
      name: "orient",
      run: async () => {
        // Checks start here, in parallel, so their output is available to the
        // agent as evidence rather than as something it must go and fetch.
        checksPromise =
          config.checks.enabled && changeSet
            ? dependencies.runChecks(changeSet).catch((error: Error) => {
                // Never a bare swallow. A check runner that refused — a tampered
                // config, a fork, a missing binary — must say so: reporting it
                // as "no checks ran" is indistinguishable from a clean run, and
                // that is precisely the silence v4 exists to remove.
                checksError = error.message;
                return [] as CheckRunResult[];
              })
            : Promise.resolve([]);

        absorb(
          await dependencies.turn(
            "Plan your review. Group the changed files however makes sense to you, " +
              "and say which files need no review and why. Send the plan with " +
              "report_progress — nothing downstream can see it otherwise.",
            "orient",
          ),
        );
      },
      check: (): StageCheck => {
        if (!changeSet) {
          return missing(["change set"], "The change could not be read.");
        }
        const grouped = new Set(
          state.plan.groups.flatMap((group) => group.paths),
        );
        const declined = new Set(
          state.plan.declined.map((entry) => entry.path),
        );
        const ungrouped = changeSet.files
          .map((file) => file.path)
          .filter((path) => !grouped.has(path) && !declined.has(path));

        return ungrouped.length === 0
          ? passed
          : missing(
              ungrouped,
              "These changed files are in no group of your plan. Add them, or say " +
                "explicitly why each one needs no review.",
            );
      },
      remediate: async (check) => {
        absorb(
          await dependencies.turn(renderRemediation("orient", check), "orient"),
        );
      },
    },

    // ── S2 REVIEW ──────────────────────────────────────────────────────────
    {
      name: "review",
      run: async () => {
        const outcome = await runReviewTurns(dependencies, state, absorb);
        review.turnLoopEnd = outcome.turnLoopEnd;
        review.turns += outcome.turns;
        review.interventions.push(...outcome.interventions);
      },
      check: (): StageCheck => reviewPredicate(state),
      remediate: async (check) => {
        absorb(
          await dependencies.turn(renderRemediation("review", check), "review"),
        );
      },
    },

    // ── S3 POST ────────────────────────────────────────────────────────────
    {
      name: "post",
      run: async () => {
        const postContext = forStage(dependencies.posting, "post");

        // Some providers only accept an inline comment attached to an open
        // review. Where that is so, the config maps beginReview/submitReview and
        // they bracket the posting; where it is not, both are no-ops.
        const opened = await beginReview(postContext);
        if (opened.status === "failed") {
          postingNotes.push(
            `Could not open a review to attach inline comments to: ${opened.error}`,
          );
        }

        // The agent posts as it works; this closes whatever it missed. Running
        // unconditionally means a clean run costs one no-op and a broken one is
        // repaired without waiting for a retry.
        try {
          await postMissingFindings(postContext, ledger);
        } finally {
          // Always submit. Inline comments on a review that was opened and never
          // submitted are invisible to the whole team, which reads exactly like
          // a review that found nothing.
          const submitted = await submitReview(postContext);
          if (submitted.status === "failed") {
            postingNotes.push(
              `Inline comments were written but the review could not be submitted, ` +
                `so they are not visible: ${submitted.error}`,
            );
          }
        }
        state.unposted = ledger.unposted;
      },
      check: (): StageCheck => {
        if (context.mode === "dry-run") {
          return passed;
        }
        if (postingNotes.length > 0) {
          return missing(
            postingNotes,
            "Posting reported a problem. Comments that were written may not be " +
              "visible on the pull request.",
          );
        }
        return ledger.unposted.length === 0
          ? passed
          : missing(
              ledger.unposted.map(
                (finding) =>
                  `${finding.id} — ${finding.severity}: ${finding.title}` +
                  (finding.filePath
                    ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ""})`
                    : ""),
              ),
              "These findings were accepted by the gate but have no comment on the " +
                "pull request.",
            );
      },
      remediate: async (check) => {
        // A fresh attempt starts with a clean slate: stale notes from the
        // failed try would keep the check failing forever even after every
        // comment actually landed.
        postingNotes.length = 0;

        absorb(
          await dependencies.turn(renderRemediation("post", check), "post"),
        );

        // The full posting bracket again, not just the missing comments. The
        // original failure may have been beginReview or submitReview itself —
        // and inline comments on a review that was never submitted are
        // invisible to everyone, which no amount of re-posting fixes.
        const postContext = forStage(dependencies.posting, "post");
        const reopened = await beginReview(postContext);
        if (reopened.status === "failed") {
          postingNotes.push(
            `Could not open a review to attach inline comments to: ${reopened.error}`,
          );
        }
        try {
          await postMissingFindings(postContext, ledger);
        } finally {
          const resubmitted = await submitReview(postContext);
          if (resubmitted.status === "failed") {
            postingNotes.push(
              `Inline comments were written but the review could not be submitted, ` +
                `so they are not visible: ${resubmitted.error}`,
            );
          }
        }
        state.unposted = ledger.unposted;
      },
    },

    // ── S4 CHECKS ──────────────────────────────────────────────────────────
    {
      name: "checks",
      enabled: config.checks.enabled && config.checks.checks.length > 0,
      run: async () => {
        checks = await checksPromise;

        // A check finding is a finding. It skips the judge — a compiler error
        // is not a probabilistic claim — but it goes through the same gate as
        // everything else, so it is deduped against earlier runs and capped by
        // the same rules, and it lands on the pull request where the author
        // will see it.
        if (checks.length > 0 && dependencies.publishCheckFindings) {
          const published = await dependencies.publishCheckFindings(checks);
          checkFindingsPosted = published.posted;
        }

        if (changeSet) {
          const ownership = evaluateOwnership({
            rules: config.ownership,
            changeSet,
            approvals: dependencies.approvals,
            author: context.identity.author,
          });
          if (ownership.comment) {
            await postOwnersComment(
              forStage(dependencies.posting, "checks"),
              ownership.comment,
              comments,
            );
          }
        }
      },
      check: (): StageCheck => {
        if (checksError) {
          return missing(
            [checksError],
            "The check runner refused to run. This is reported rather than treated as " +
              "a clean result, because a check that did not run proves nothing.",
          );
        }

        const enabled = config.checks.checks.filter(
          (check) => check.enabled !== false,
        );
        const accounted = new Set(checks.map((result) => result.checkId));
        const unaccounted = enabled
          .map((check) => check.id)
          .filter((id) => !accounted.has(id));

        if (unaccounted.length > 0) {
          return missing(
            unaccounted,
            "These configured checks neither ran nor recorded a reason for skipping.",
          );
        }

        // Same rule as S3: a finding counts as reported only when a comment
        // exists for it. A check that found something nobody can see has not
        // done its job.
        if (context.mode === "dry-run") {
          return passed;
        }
        const unposted = ledger.unposted;
        return unposted.length === 0
          ? passed
          : missing(
              unposted.map(
                (finding) =>
                  `${finding.id} — ${finding.severity}: ${finding.title}`,
              ),
              "These check findings were accepted by the gate but have no comment on " +
                "the pull request.",
            );
      },
    },

    // ── S5 ENHANCE ─────────────────────────────────────────────────────────
    {
      name: "enhance",
      enabled: config.review.stages.enhance,
      run: async () => {
        absorb(
          await dependencies.turn(
            `${dependencies.descriptionInstruction ?? ""}\n\n`.trimStart() +
              "Update the pull request description now, then report the sections " +
              "you wrote with report_progress.",
            "enhance",
          ),
        );
        // Read back what is actually on the pull request. The agent's claim
        // that it wrote a description is exactly the kind of self-report the
        // ledger exists to replace for comments; the description deserves the
        // same treatment.
        description = await dependencies.readDescription?.();
      },
      check: (): StageCheck => {
        if (context.mode === "dry-run") {
          return passed;
        }
        if (!dependencies.readDescription) {
          // No capability to read it back. Fall back to the agent's claim,
          // rather than failing a stage that cannot be verified either way —
          // but the summary records the stage as unverifiable, not as proven.
          return state.descriptionUpdated
            ? passed
            : missing(
                ["pull request description"],
                "The description was not updated. Yama also has no updateDescription " +
                  "capability mapped, so this stage cannot be verified against the " +
                  "pull request — map it in .yama/mcp.yaml.",
              );
        }

        const current = (description ?? "").trim();
        if (current.length === 0) {
          return missing(
            ["pull request description"],
            "The pull request still has an empty description.",
          );
        }
        if (
          dependencies.baselineDescription !== undefined &&
          current === dependencies.baselineDescription.trim()
        ) {
          return missing(
            ["pull request description"],
            "The description on the pull request is unchanged from before this run.",
          );
        }

        const absent = (config.review.description.sections ?? [])
          .filter((section) => section.required)
          .map((section) => section.title)
          .filter(
            (title) => !current.toLowerCase().includes(title.toLowerCase()),
          );

        return absent.length === 0
          ? passed
          : missing(
              absent.map((title) => `missing section: ${title}`),
              "The description is missing sections this project requires.",
            );
      },
      remediate: async (check) => {
        absorb(
          await dependencies.turn(
            renderRemediation("enhance", check),
            "enhance",
          ),
        );
      },
    },

    // ── S6 VERDICT ─────────────────────────────────────────────────────────
    {
      name: "verdict",
      run: async () => {
        checks = await checksPromise;

        const guards = changeSet
          ? evaluateGuards(config.guards, changeSet, checkOutcomes(checks))
          : { findings: [], violatedRuleIds: [], requiredCheckIds: [] };

        const ownership = changeSet
          ? evaluateOwnership({
              rules: config.ownership,
              changeSet,
              approvals: dependencies.approvals,
              author: context.identity.author,
            })
          : { unsatisfiedBlockingRuleIds: [] as string[] };

        verdict = deriveVerdict(
          {
            posted: ledger.posted,
            accepted: ledger.accepted,
            blockingRuleIds: guards.violatedRuleIds,
            failedBlockingCheckIds: failedBlockingChecks(
              checks,
              config.checks.checks,
            ),
            unapprovedOwnershipRuleIds: ownership.unsatisfiedBlockingRuleIds,
            partial: partialSoFar,
          },
          { config: config.review.verdict },
        );

        const fresh = await dependencies.readComments();
        const summary = await postSummary(
          forStage(dependencies.posting, "verdict"),
          renderSummaryComment({
            verdict,
            posted: ledger.posted,
            unposted: ledger.unposted,
            checks: checks.map((result) => ({
              checkId: result.checkId,
              status: result.status,
              findings: result.findings.length,
              dropped: result.droppedFindings,
            })),
            checkFindingsPosted,
            filesReviewed: state.plan.groups.flatMap((group) => group.paths)
              .length,
            filesExcluded: changeSet?.excluded.length ?? 0,
            truncated: changeSet?.truncated ?? false,
            degradedStages: degradedSoFar,
            ...(changeSet
              ? (() => {
                  const impact = deriveImpactReport(
                    config.product,
                    config.impactLog,
                    changeSet,
                  );
                  return impact ? { impactReport: impact } : {};
                })()
              : {}),
          }),
          fresh,
        );
        summaryPosted =
          summary.status === "created" || summary.status === "updated";

        if (config.review.verdict.enabled) {
          const status = await setReviewStatus(
            forStage(dependencies.posting, "verdict"),
            verdict.decision,
          );
          statusRecorded = status.status === "set";
        }
      },
      check: (): StageCheck => {
        if (context.mode === "dry-run") {
          return passed;
        }
        return summaryPosted
          ? passed
          : missing(
              ["summary comment"],
              "The summary comment did not post. Without it the pull request shows " +
                "individual comments with no verdict.",
            );
      },
    },
  ];

  const result = await runStages(stages, {
    maxAttemptsPerStage: config.review.remediation.maxAttemptsPerStage,
    signal: context.signal,
    onStage: (outcome: StageOutcome) => {
      if (outcome.status === "degraded" || outcome.status === "failed") {
        partialSoFar = true;
        degradedSoFar = [...degradedSoFar, outcome.stage];
      }
    },
  });

  // The plan as it finally stood — what the run report and the scorecard
  // measure coverage against.
  review.plan = state.plan;

  return {
    stages: result,
    // A run whose verdict stage failed still needs one: a computed verdict is
    // more honest than none.
    verdict:
      verdict ??
      deriveVerdict(
        {
          posted: ledger.posted,
          accepted: ledger.accepted,
          blockingRuleIds: [],
          failedBlockingCheckIds: [],
          unapprovedOwnershipRuleIds: [],
          partial: true,
        },
        { config: config.review.verdict },
      ),
    changeSet,
    checks,
    review,
    summaryPosted,
    statusRecorded,
  };
}

/**
 * S2's exit predicate.
 *
 * Straight from the architecture: every planned group has a turn ending in
 * findings-or-explicit-clean, AND the gate was called at least once per group.
 */
export function reviewPredicate(state: ReviewState): StageCheck {
  // No plan at all is NOT a satisfied predicate. Every filter below is vacuously
  // true over an empty group list, so without this a review that never produced
  // a plan would pass S2 having reviewed nothing — the exact silence the stage
  // machine exists to make impossible.
  if (state.plan.groups.length === 0 && state.plan.declined.length === 0) {
    return missing(
      ["a review plan"],
      "You have not sent a plan. Call report_progress with your groups — every " +
        "changed file in exactly one group, or declined with a reason — then " +
        "review them.",
    );
  }

  const unreviewed = state.plan.groups
    .filter((group) => !group.reviewed)
    .map((group) => `${group.id} (${group.paths.join(", ")}) — not reviewed`);

  const ungated = state.plan.groups
    .filter((group) => group.reviewed && !group.gated && !group.declaredClean)
    .map((group) => `${group.id} — reviewed but produced no gate submission`);

  const gaps = [...unreviewed, ...ungated];
  if (gaps.length === 0) {
    return passed;
  }

  return missing(
    gaps,
    "Each group needs a turn that ends in findings or an explicit all-clear, and " +
      "any group with findings must go through submit_finding.",
  );
}

/**
 * The supervised turn loop inside S2.
 *
 * The agent works its plan. Between turns the supervisor checks coverage, gate
 * hygiene, waste and drift, and either emits one guidance turn in-session or
 * lets the agent continue.
 *
 * It ends when the agent says it is done, when the exit predicate is already
 * satisfied, or when waste signals show it has stopped working — never on a
 * turn count.
 */
export async function runReviewTurns(
  dependencies: PipelineDependencies,
  state: ReviewState,
  absorb: (report: TurnReport) => void,
): Promise<ReviewRunOutcome> {
  const interventions: string[] = [];
  let turns = 0;
  let turnLoopEnd: TurnLoopEnd = "agent-finished";
  let message =
    "Review your plan. Work the groups in whatever order you judge best, " +
    "delegate where it helps, gate every finding, and post what the gate accepts.";
  let stage: StageName = "review";

  for (;;) {
    if (dependencies.context.signal.aborted) {
      turnLoopEnd = "cancelled";
      break;
    }

    const report = await dependencies.turn(message, stage);
    turns += 1;
    absorb(report);

    if (reviewPredicate(state).ok) {
      turnLoopEnd = "predicate-satisfied";
      break;
    }

    // The agent declaring itself finished is the primary end condition. The
    // stage's exit predicate then decides whether it actually was, and
    // remediation handles the gap — bounded by maxAttemptsPerStage, not here.
    if (report.done === true) {
      turnLoopEnd = "agent-finished";
      break;
    }

    // A turn the runtime cut short — a stall, a wedged tool, an abort — is
    // checked BEFORE the supervisor. Steering a turn that never got to run
    // produces another cut-short turn, and the supervisor's `continue` would
    // skip this check forever.
    if (report.partial) {
      turnLoopEnd = "stalled";
      break;
    }

    const verdict = supervise({
      observation: {
        turn: turns,
        plannedPaths: state.plan.groups.flatMap((group) => group.paths),
        examinedPaths: state.plan.groups
          .filter((group) => group.reviewed)
          .flatMap((group) => group.paths),
        gateSubmissions: state.gateSubmissions,
        unpostedFindingIds: state.unposted.map((finding) => finding.id),
        toolCalls: report.toolCalls,
        compacted: report.compacted === true,
        claimedFindings: state.claimedFindings,
      },
      entries: dependencies.entries,
      moreTurnsExpected: true,
    });

    if (verdict.intervene) {
      interventions.push(verdict.signals.join(","));

      // Waste means the agent has stopped working: repeating a call, or a run
      // of empty or failing results. One nudge is worth sending; a second turn
      // that trips the same signal is a loop, and the stage's remediation is
      // the right place to break it.
      const wasteful = verdict.signals.some(
        (signal) =>
          signal === "duplicate-calls" ||
          signal === "empty-streak" ||
          signal === "error-streak",
      );
      if (
        wasteful &&
        interventions.filter((entry) => entry === verdict.signals.join(","))
          .length > 1
      ) {
        turnLoopEnd = "waste";
        break;
      }

      message = verdict.guidance;
      continue;
    }

    message =
      "Continue with the groups you have not finished. " +
      "Say when you are done.";
    stage = "review";
  }

  return { turnLoopEnd, turns, interventions };
}

/** The opening message: identity only, never assembled context. */
function openingMessage(dependencies: PipelineDependencies): string {
  const { identity } = dependencies.context;
  const lines = [`Repository: ${identity.owner}/${identity.repo}`];
  if (identity.pullRequestId !== undefined) {
    lines.push(`Pull request: #${identity.pullRequestId}`);
  } else if (identity.branch) {
    lines.push(`Branch: ${identity.branch} — find its pull request.`);
  }
  lines.push("", "Read it and confirm what you are reviewing.");
  return lines.join("\n");
}

/** Merge a newly-reported plan into the accumulated one, preserving progress. */
function mergePlan(
  current: ReviewState["plan"],
  incoming: ReviewState["plan"],
): ReviewState["plan"] {
  const groups = [...current.groups];
  for (const group of incoming.groups) {
    const existing = groups.find((entry) => entry.id === group.id);
    if (existing) {
      existing.paths = [...new Set([...existing.paths, ...group.paths])];
      // Never un-review a group a later plan restates.
      existing.reviewed = existing.reviewed || group.reviewed;
      existing.gated = existing.gated || group.gated;
    } else {
      groups.push({ ...group });
    }
  }

  const declined = [...current.declined];
  for (const entry of incoming.declined) {
    if (!declined.some((existing) => existing.path === entry.path)) {
      declined.push(entry);
    }
  }

  return { groups, declined };
}
