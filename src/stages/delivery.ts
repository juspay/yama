/**
 * Delivery (TASKS:Y3.5) — the stage that is NOT the agent's to plan.
 *
 * Everything about what reaches the pull request is decided in code before the agent is
 * asked to do any of it (PLAN.md section 1): which actions may run comes from config and
 * the capability probe, which findings get a comment comes from the severity floor and the
 * per-run cap, which of those are new comes from the markers already on the target, and
 * every comment body — marker included — is rendered here.
 *
 * The agent's job is to make the calls: it knows how to drive a tool, and the tool name
 * and its platform coordinates come from the capability registry, so no forge is named
 * anywhere in this file. What it says it did is a claim; the shell confirms every part of
 * it against the platform's own tool results (TASKS:Y4.4) and says so out loud when they
 * disagree.
 */
import {
  confirmCreated,
  confirmFromComments,
  confirmPosted,
  confirmToolRan,
  dedupePostedFindings,
  postingFailure,
} from "../gates/index.js";
import { readDescription, readTargetComments } from "../platform/index.js";
import {
  READ_ONLY_TOOLS,
  withFindingMarker,
  withMarker,
} from "../tools/index.js";
import type {
  CapabilityId,
  CapabilityRegistry,
  DeliveryAction,
  DeliveryComment,
  DeliveryPlan,
  DeliveryStageResult,
  Engine,
  EngineToolResult,
  ExistingComment,
  Finding,
  PostingConfirmation,
  RankedFindings,
  ResolvedConfig,
  SessionRunner,
  Verdict,
} from "../types/index.js";
import { severityAtLeast } from "../util/severity.js";
import { mergeDescription, renderDescriptionBlock } from "./describe.js";
import { DeliveryReportSchema } from "./schema.js";

/** Posting is a handful of tool calls, not an investigation. */
const DELIVERY_MAX_STEPS = 48;

/** Marker kind carried by the one summary comment a run posts. */
const RUN_MARKER_KIND = "run";

/** One finding as a comment body, marker appended (TASKS:Y5.3). */
export const renderFindingComment = (finding: Finding): string =>
  withFindingMarker(
    finding.id,
    [
      `**${finding.severity} · ${finding.category}** — ${finding.summary}`,
      "",
      finding.impact,
      ...(finding.fix !== undefined && finding.fix.length > 0
        ? ["", `**Fix:** ${finding.fix}`]
        : []),
      ...(finding.evidence.length > 0
        ? [
            "",
            `Evidence: ${finding.evidence.map((item) => item.ref).join(", ")}`,
          ]
        : []),
    ].join("\n"),
  );

/** The one summary comment, marked with the run id so the shell can confirm it landed. */
export const renderSummaryComment = (input: {
  runId: string;
  summary: string;
  verdict: Verdict;
  findings: readonly Finding[];
  withheld: readonly string[];
  alreadyPosted: number;
  checklistComplete: boolean;
}): string =>
  withMarker(
    RUN_MARKER_KIND,
    input.runId,
    [
      "## Yama review",
      "",
      input.summary,
      "",
      `**Verdict: ${input.verdict.decision.toUpperCase()}**`,
      ...input.verdict.reasons.map((reason) => `- ${reason}`),
      "",
      input.findings.length > 0
        ? `Findings (${input.findings.length}), most serious first:`
        : "No findings.",
      ...input.findings.map(
        (finding) =>
          `- **${finding.severity}** \`${finding.file}:${finding.line}\` — ${finding.summary}`,
      ),
      ...(input.withheld.length > 0
        ? [
            "",
            `${input.withheld.length} further finding(s) were not commented on inline: ${input.withheld.join(", ")}.`,
          ]
        : []),
      ...(input.alreadyPosted > 0
        ? [
            "",
            `${input.alreadyPosted} finding(s) were already commented on by an earlier run and were not posted again.`,
          ]
        : []),
      ...(input.checklistComplete
        ? []
        : [
            "",
            "**This review is incomplete** — some checklist items were not finished. See the run report.",
          ]),
    ].join("\n"),
  );

/**
 * The pull request's description as it stands (TASKS:Y7.3).
 *
 * Read by the shell, because the enhancement has to PRESERVE it: a description the shell
 * did not read is a description Yama must not set, and `undefined` says exactly that. It
 * is distinct from an empty description, which is a real answer.
 */
export const readTargetDescription = async (options: {
  engine: Engine;
  registry: CapabilityRegistry;
}): Promise<{ description?: string; problem?: string }> => {
  const tool = options.registry.toolFor("pr.read");
  if (tool === undefined) {
    return {
      problem:
        'capability "pr.read" is not available, so the description could not be read — and a description that was not read is not one to overwrite',
    };
  }
  try {
    const description = readDescription(
      await options.engine.callTool(tool, options.registry.argsFor("pr.read")),
    );
    return description === undefined
      ? {
          problem: `"${tool}" returned nothing that reads as a description, so the author's text was left alone`,
        }
      : { description };
  } catch (error) {
    return {
      problem: `reading the description with "${tool}" failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * What Delivery will do, decided before the agent sees any of it. The severity floor and
 * the inline cap come from the `delivery:` block; the dedup comes from the markers.
 */
export const buildDeliveryPlan = (input: {
  config: ResolvedConfig;
  actions: readonly DeliveryAction[];
  runId: string;
  ranked: RankedFindings;
  verdict: Verdict;
  summary: string;
  comments: readonly ExistingComment[];
  checklistComplete: boolean;
  /** What this change does and where its risk is, from Task Insertion (TASKS:Y7.3). */
  changeSummary?: string;
  riskAreas?: readonly string[];
  /** The description as it stands. Absent means it could not be read — so it is not set. */
  currentDescription?: string;
}): DeliveryPlan => {
  const { delivery } = input.config.yama;
  const eligible = input.ranked.findings.filter((finding) =>
    severityAtLeast(finding.severity, delivery.minSeverity),
  );
  const dedupe = dedupePostedFindings({
    findings: eligible,
    comments: input.comments,
  });
  const inline = input.actions.includes("inlineComments");
  const capped = inline ? dedupe.post.slice(0, delivery.maxInlineComments) : [];
  const withheld = [
    ...input.ranked.findings
      .filter((finding) => !eligible.includes(finding))
      .map((finding) => finding.id),
    ...dedupe.post.slice(capped.length).map((finding) => finding.id),
  ];

  const comments: DeliveryComment[] = capped.map((finding) => ({
    findingId: finding.id,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    body: renderFindingComment(finding),
  }));

  // The description is built in code and the author's own text is carried through it
  // untouched (TASKS:Y7.3). An unchanged block is not offered for posting at all.
  const described =
    input.actions.includes("describe") && input.currentDescription !== undefined
      ? mergeDescription(
          input.currentDescription,
          renderDescriptionBlock({
            sections: delivery.describeSections,
            summary: input.changeSummary ?? input.summary,
            riskAreas: input.riskAreas ?? [],
            findings: input.ranked.findings,
            verdict: input.verdict,
            checklistComplete: input.checklistComplete,
          }),
        )
      : undefined;

  return {
    actions: [...input.actions],
    comments,
    alreadyPosted: dedupe.alreadyPosted,
    stale: dedupe.stale,
    ...(described?.changed === true
      ? { description: described.description }
      : {}),
    ...(input.actions.includes("summaryComment")
      ? {
          summary: renderSummaryComment({
            runId: input.runId,
            summary: input.summary,
            verdict: input.verdict,
            findings: input.ranked.findings,
            withheld,
            alreadyPosted: dedupe.alreadyPosted.length,
            checklistComplete: input.checklistComplete,
          }),
        }
      : {}),
    verdict: input.verdict,
    withheld,
  };
};

/** `key: value` lines for the arguments every call of one capability's tool must carry. */
const renderArgs = (
  registry: CapabilityRegistry,
  capability: CapabilityId,
): string => {
  const args = registry.argsFor(capability);
  return Object.keys(args).length > 0
    ? ` Always pass these arguments as well: ${JSON.stringify(args)}.`
    : "";
};

/** The instruction: the exact tools, the exact bodies, and nothing else to decide. */
export const buildDeliveryPrompt = (input: {
  plan: DeliveryPlan;
  registry: CapabilityRegistry;
  dedupeProblem?: string;
}): string => {
  const { plan, registry } = input;
  const lines: string[] = [
    "DELIVERY. The review is finished and decided. Put it on the pull request exactly as written below.",
    "",
    "This is not a task you plan. Post what is here, do not edit it, do not add findings, do not leave any out, and do not post anything that is not on this list.",
    "",
  ];

  if (plan.actions.includes("inlineComments")) {
    const tool = registry.toolFor("comment.inline.create");
    const begin = registry.toolFor("review.begin");
    const submit = registry.toolFor("review.submit");
    if (plan.comments.length > 0 && begin !== undefined) {
      lines.push(
        `This forge writes inline comments into a PENDING review. FIRST call \`${begin}\` once to open it.${renderArgs(registry, "review.begin")}`,
        `AFTER the last inline comment, call \`${submit}\` once to submit the review.${renderArgs(registry, "review.submit")} Comments on a review that is never submitted are invisible to everyone — the run is not delivered until the submit call has returned.`,
        "",
      );
    }
    if (plan.comments.length > 0) {
      lines.push(
        "Post each comment exactly ONCE. A success result means the comment is in the review even when the result carries no id — never post it again, never open a second review to try again, and never re-read the pull request to check: the shell confirms delivery from the platform after you finish. If a call fails because the line is not in this pull request's diff, retry that ONE comment ONCE at file level (a FILE subjectType, where the tool has one) on the same file; if that also fails, report it as not posted.",
        "",
      );
    }
    lines.push(
      plan.comments.length > 0
        ? `Post ${plan.comments.length} inline comment(s) with \`${tool}\`.${renderArgs(registry, "comment.inline.create")} One call per comment, on the file and line given, with the body VERBATIM — the marker lines at the end of each body are what stop it being posted twice on the next run, so they must survive exactly as written.`
        : "There are no new inline comments to post.",
      "",
      ...plan.comments.flatMap((comment) => [
        `--- comment for ${comment.findingId} · ${comment.file}:${comment.line} · ${comment.severity}`,
        comment.body,
        "",
      ]),
    );
  }

  if (plan.summary !== undefined) {
    lines.push(
      `Post this summary as one comment on the pull request with \`${registry.toolFor("comment.summary.create")}\`.${renderArgs(registry, "comment.summary.create")} Body VERBATIM:`,
      "",
      "--- summary comment",
      plan.summary,
      "",
    );
  }

  if (plan.actions.includes("verdict")) {
    lines.push(
      `Set the review state to ${plan.verdict.decision.toUpperCase()} with \`${registry.toolFor("verdict.set")}\`.${renderArgs(registry, "verdict.set")} The reasons are: ${plan.verdict.reasons.join("; ") || "no findings the policy acts on"}.`,
      "",
    );
  }

  if (plan.actions.includes("describe")) {
    lines.push(
      plan.description !== undefined
        ? `Set the pull request description with \`${registry.toolFor("pr.describe")}\`.${renderArgs(registry, "pr.describe")} The body below is the WHOLE description: the author's own text is already in it, unchanged, with this review's sections inside the yama block. Send it VERBATIM — do not re-word the author, do not drop the HTML markers, and do not add anything of your own.`
        : "The description is not being changed by this run.",
      "",
      ...(plan.description !== undefined
        ? ["--- description", plan.description, ""]
        : []),
    );
  }

  if (plan.alreadyPosted.length > 0) {
    lines.push(
      `${plan.alreadyPosted.length} finding(s) are already on this pull request from an earlier run and must NOT be posted again: ${plan.alreadyPosted.map((entry) => `${entry.findingId} (comment ${entry.commentId})`).join(", ")}.`,
      "",
    );
  }
  if (input.dedupeProblem !== undefined) {
    lines.push(
      `Note: ${input.dedupeProblem}. Post what is listed above and nothing more.`,
      "",
    );
  }

  lines.push(
    "Then report what you did: the finding ids you posted, anything you could not post and why, and whether the summary, the verdict and the description each went through. If a call fails, say so — do not report it as done.",
  );
  return lines.join("\n");
};

/**
 * What the platform's own tool results prove happened (TASKS:Y4.4).
 *
 * Confirmation is per TOOL: the summary comment carries a RUN marker, not a finding
 * marker, and reading it with the inline confirmation would report it as an
 * unattributable comment. Each gate reads only the results of the tool it asked for.
 */
export const confirmDelivery = (input: {
  plan: DeliveryPlan;
  registry: CapabilityRegistry;
  runId: string;
  results: readonly EngineToolResult[];
  /** Comments re-read from the platform AFTER the stage — the fallback evidence. */
  readBack?: readonly ExistingComment[];
}): {
  confirmation: PostingConfirmation;
  summaryPosted: boolean;
  verdictSet: boolean;
  described: boolean;
  failures: (string | undefined)[];
} => {
  const { plan, registry, results } = input;
  const payloadsOf = (tool: string | undefined): unknown[] =>
    results
      .filter((result) => tool === undefined || result.name === tool)
      .map((result) => result.result);

  // GitHub's hosted MCP answers a review-comment write with a bare success string, so
  // the write results alone cannot confirm inline posts there — the re-read of the
  // target (`readBack`) is the evidence that can.
  const confirmation = confirmFromComments({
    confirmation: confirmPosted({
      intended: plan.comments.map((comment) => ({ id: comment.findingId })),
      results: payloadsOf(registry.toolFor("comment.inline.create")),
    }),
    comments: input.readBack ?? [],
  });
  // The summary is an issue comment: its write result carries an id (no body), and the
  // review-comment re-read never lists it — an id from a clean result is the fallback.
  const summaryResults = payloadsOf(registry.toolFor("comment.summary.create"));
  const summaryPosted =
    plan.summary !== undefined &&
    (confirmPosted({
      intended: [{ id: input.runId }],
      results: summaryResults,
      kind: RUN_MARKER_KIND,
    }).unposted.length === 0 ||
      confirmCreated(summaryResults));
  const verdictSet =
    plan.actions.includes("verdict") &&
    confirmToolRan(results, registry.toolFor("verdict.set"));
  const described =
    plan.description !== undefined &&
    confirmToolRan(results, registry.toolFor("pr.describe"));
  // Where the forge maps the pending-review lifecycle, inline comments are invisible
  // until the submit call returns — a written-but-unsubmitted review is not delivery.
  const reviewSubmitted =
    plan.comments.length === 0 ||
    registry.toolFor("review.begin") === undefined ||
    confirmToolRan(results, registry.toolFor("review.submit"));

  return {
    confirmation,
    summaryPosted,
    verdictSet,
    described,
    failures: [
      postingFailure(confirmation),
      plan.summary !== undefined && !summaryPosted
        ? "the summary comment was never confirmed as posted"
        : undefined,
      plan.actions.includes("verdict") && !verdictSet
        ? "the review state was never confirmed as set"
        : undefined,
      plan.description !== undefined && !described
        ? "the description was never confirmed as updated"
        : undefined,
      !reviewSubmitted
        ? "inline comments were written into a pending review that was never submitted — nobody can see them"
        : undefined,
    ],
  };
};

/** How long the confirm re-read waits before its one retry (read-after-write lag). */
const RECONFIRM_DELAY_MS = 15_000;

/** Nothing was delivered, and this is why. Used for dry runs and for no-action runs. */
const skippedResult = (
  plan: DeliveryPlan,
  reason: string,
): DeliveryStageResult => ({
  plan,
  confirmation: { posted: [], unposted: [], unmatched: [], ok: true },
  summaryPosted: false,
  verdictSet: false,
  described: false,
  skipped: reason,
});

/** The empty plan a skipped delivery still reports, so the shape never varies. */
const emptyPlan = (verdict: Verdict): DeliveryPlan => ({
  actions: [],
  comments: [],
  alreadyPosted: [],
  stale: [],
  verdict,
  withheld: [],
});

/**
 * Runs Delivery: read the target, decide the plan, hand it to the agent, then confirm
 * from the tool results what actually landed.
 */
export const runDelivery = async (options: {
  session: SessionRunner;
  engine: Engine;
  config: ResolvedConfig;
  registry: CapabilityRegistry;
  actions: readonly DeliveryAction[];
  runId: string;
  ranked: RankedFindings;
  verdict: Verdict;
  summary: string;
  /** What this change does and where its risk is, from Task Insertion (TASKS:Y7.3). */
  changeSummary?: string;
  riskAreas?: readonly string[];
  checklistComplete: boolean;
  dryRun: boolean;
}): Promise<DeliveryStageResult> => {
  if (options.dryRun) {
    return skippedResult(
      emptyPlan(options.verdict),
      "--dry-run: the run analysed only and delivered nothing",
    );
  }
  if (options.actions.length === 0) {
    return skippedResult(
      emptyPlan(options.verdict),
      "no delivery action is available for this run — see the degradations",
    );
  }

  const target = await readTargetComments({
    engine: options.engine,
    registry: options.registry,
  });
  const current = options.actions.includes("describe")
    ? await readTargetDescription({
        engine: options.engine,
        registry: options.registry,
      })
    : {};
  const plan = buildDeliveryPlan({
    config: options.config,
    actions: options.actions,
    runId: options.runId,
    ranked: options.ranked,
    verdict: options.verdict,
    summary: options.summary,
    ...(options.changeSummary !== undefined
      ? { changeSummary: options.changeSummary }
      : {}),
    ...(options.riskAreas !== undefined
      ? { riskAreas: options.riskAreas }
      : {}),
    comments: target.comments,
    checklistComplete: options.checklistComplete,
    ...(current.description !== undefined
      ? { currentDescription: current.description }
      : {}),
  });

  // Deliberately NOT behind the schema gate (TASKS:Y4.1): its retry re-runs the prompt,
  // and re-running a delivery prompt posts everything a second time. A malformed final
  // report is survivable — the tool results say what landed, and they are read either way.
  let output;
  let stageError: string | undefined;
  try {
    output = await options.session.checkpoint({
      stage: "delivery",
      prompt: buildDeliveryPrompt({
        plan,
        registry: options.registry,
        ...(target.problem !== undefined
          ? { dedupeProblem: target.problem }
          : {}),
      }),
      schema: DeliveryReportSchema,
      tools: [
        ...READ_ONLY_TOOLS,
        ...options.registry.deliveryTools(options.actions),
      ],
      maxSteps: DELIVERY_MAX_STEPS,
    });
  } catch (error) {
    stageError = error instanceof Error ? error.message : String(error);
  }

  let confirmed = confirmDelivery({
    plan,
    registry: options.registry,
    runId: options.runId,
    results: options.session.toolResults(),
  });
  // The write results could not prove the posts. Ask the platform what the pull request
  // now shows — the one source that is right whatever the results looked like. A review
  // submitted moments ago may not be listable yet (GitHub answers the re-read from an
  // eventually-consistent view), so an empty first answer earns ONE delayed retry.
  for (const delay of [0, RECONFIRM_DELAY_MS]) {
    if (confirmed.confirmation.ok || plan.comments.length === 0) {
      break;
    }
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const after = await readTargetComments({
      engine: options.engine,
      registry: options.registry,
    });
    confirmed = confirmDelivery({
      plan,
      registry: options.registry,
      runId: options.runId,
      results: options.session.toolResults(),
      readBack: after.comments,
    });
  }
  const { confirmation, summaryPosted, verdictSet, described } = confirmed;

  const failures = [
    ...confirmed.failures,
    target.problem,
    current.problem,
    stageError,
  ].filter((line): line is string => line !== undefined && line.length > 0);

  return {
    ...(output !== undefined ? { output } : {}),
    plan,
    confirmation,
    summaryPosted,
    verdictSet,
    described,
    ...(failures.length > 0 ? { failure: failures.join("\n") } : {}),
  };
};
