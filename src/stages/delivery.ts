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
  confirmAcceptedWrites,
  confirmCreated,
  confirmFromComments,
  confirmPosted,
  confirmToolRan,
  dedupePostedFindings,
  mergeConfirmations,
  postingFailure,
} from "../gates/index.js";
import { readDescription, readTargetComments } from "../platform/index.js";
import {
  READ_ONLY_TOOLS,
  withFindingMarker,
  scanMarkers,
  withMarker,
  yamaMarker,
} from "../tools/index.js";
import type {
  TargetFacts,
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
import { renderTargetFacts } from "./target.js";

/**
 * Marker kind for a reply this reviewer wrote (TASKS:Y7.4).
 *
 * Deliberately NOT the finding kind: a reply is not a second posting of the finding, and
 * marking it as one would make the dedup gate read the reply as the comment that carries
 * the finding. Its own kind answers a different question — has this reviewer already told
 * this thread the finding is still open?
 */
const REPLY_MARKER_KIND = "reply";

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
  /** The change under review — delivery reads files to build suggestions. */
  facts?: TargetFacts;
}): string => {
  const { plan, registry } = input;
  const replyTool = registry.toolFor("comment.reply");
  // Threads this reviewer has NOT already answered. A reply carries its own marker, so a
  // recurring run can tell "still open and nobody has been told" from "still open and I
  // said so last time" — without it, every re-run answers the same thread again, which is
  // the duplicate-posting failure marker dedup exists to prevent, on the one write surface
  // that sits outside the posted-confirmed contract.
  const unanswered = plan.alreadyPosted.filter(
    (entry) =>
      !(entry.replies ?? []).some((reply) =>
        scanMarkers(reply.body, REPLY_MARKER_KIND).includes(entry.findingId),
      ),
  );
  const lines: string[] = [
    "DELIVERY. The review is finished and decided. Put it on the pull request exactly as written below.",
    ...(input.facts !== undefined ? ["", renderTargetFacts(input.facts)] : []),
    "",
    "Every finding below must land, exactly as written: do not edit one, do not add one, do not leave one out. That list is the floor, and the shell confirms it against what the platform accepted.",
    "",
    "It is not a ceiling. You are the reviewer here, and a reviewer reads the thread it is posting into: if someone has answered an earlier finding, replying to them, resolving a thread your findings have settled, or following up where it genuinely helps the review is yours to judge. Nothing extra is counted as delivery — the findings above are what this run is held to — so post it because it serves the review, or not at all.",
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
        "Post each comment exactly ONCE. A success result means the comment is in the review even when the result carries no id — never post it again, never open a second review to try again, and never re-read the pull request to check: the shell confirms delivery from the platform after you finish. If a call fails because the line is not in this pull request's diff, retry that ONE comment ONCE at file level, using whatever form that tool offers for a comment on a file rather than a line; if that also fails, report it as not posted.",
        "",
      );
    }
    lines.push(
      plan.comments.length > 0
        ? `Post ${plan.comments.length} inline comment(s) with \`${tool}\`.${renderArgs(registry, "comment.inline.create")} One call per comment, anchored to the file and line given.

READ THAT TOOL'S OWN PARAMETERS BEFORE THE FIRST CALL, and call it the way IT is documented. Which argument carries the comment text, what anchors it to a line, what is required and what is optional — that is the tool's business and its schema says so. Never assume a field name or an anchoring style from some other platform; a call shaped for the wrong platform is rejected, and the finding goes undelivered.

Where the platform offers RICHER forms than plain prose, use them when they fit the finding: a suggested replacement the reader can apply in one click, an anchor by surrounding code rather than a line number, a severity that opens a task. Some platforms take these as tool ARGUMENTS, which the schema will name; others take them as MARKDOWN inside the comment text, where a fenced code block tagged "suggestion" is the common spelling of an applicable fix. Use whichever of the two that platform actually supports, and plain markdown — fenced code, tables, links — wherever it makes the finding easier to read. A finding with a concrete fix is worth far more as an applicable suggestion than as a sentence describing it. All of this is optional: use a form only when that platform really has it — the schema for an argument, the platform's own markdown for the rest — and only when the finding really has that shape. A suggestion needs the EXACT replacement text — read the file first and match its indentation, because a suggestion that does not apply cleanly is worse than the prose it replaced. When you cannot get it exact, post the prose.

Two things are yours to carry unchanged: the finding's text as given, and the marker lines at the end of it. The markers are what stop the finding being posted twice on the next run, so whatever argument carries the comment text must end with them, exactly as written.`
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
      `Post this summary as ONE comment on the pull request with \`${registry.toolFor("comment.summary.create")}\`.${renderArgs(registry, "comment.summary.create")} Read that tool's parameters for which argument carries the text, and send the text below VERBATIM — including its marker line, which is what stops the summary being posted again next run:`,
      "",
      "--- summary comment",
      plan.summary,
      "",
    );
  }

  if (plan.actions.includes("verdict")) {
    lines.push(
      `Set the review state to ${plan.verdict.decision.toUpperCase()} with \`${registry.toolFor("verdict.set")}\`.${renderArgs(registry, "verdict.set")}

Read that tool's schema for the values it actually accepts and pass the one that MEANS ${plan.verdict.decision.toUpperCase()} on this platform — the vocabularies differ between platforms and only the tool knows its own. Never pass a value it does not list.

If this platform has NO state that means ${plan.verdict.decision.toUpperCase()} (several offer approve and needs-work but nothing for a plain comment), do not force the nearest approximation onto the pull request — that would say something this review did not decide. Leave the state alone and report \`verdictStateless: true\`. Only do that when the schema genuinely offers nothing: not knowing which value to pick is not the same as there being none. It is accepted only if the summary comment lands, because that is then the only place the decision appears.

The reasons for the decision are: ${plan.verdict.reasons.join("; ") || "no findings the policy acts on"}.`,
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
      `${plan.alreadyPosted.length} finding(s) are already on this pull request from an earlier run, and this review found them STILL OPEN. Do not post any of them again — the comment that carries each one is already there:`,
      ...unanswered.map((entry) => {
        const answered = entry.replies ?? [];
        return `  ${entry.findingId} — comment ${entry.commentId}${
          answered.length === 0
            ? " — nobody has replied to it"
            : `\n${answered
                .map(
                  (reply) =>
                    `      ${reply.author ?? "someone"} replied: ${reply.body.slice(0, 300)}`,
                )
                .join("\n")}`
        }\n      marker for your reply: ${yamaMarker(REPLY_MARKER_KIND, entry.findingId)}`;
      }),
      "",
      ...(unanswered.length === 0
        ? [
            "Every one of them already carries this reviewer's answer from an earlier run, so there is nothing to add. Do not answer any of them again.",
          ]
        : [
            "These are the threads where this review has something to say and has not said it. A finding that survived a second look is worth a line saying so on its own comment — and one whose reply claimed a fix that this review did not find is worth answering, because the next reader will otherwise take the reply as settled.",
            `END ANY REPLY YOU WRITE WITH ITS MARKER, exactly as given above for that finding. The marker is what stops the next run answering the same thread a second time; a reply without one will be repeated on every future review of this pull request.`,
          ]),
      ...(replyTool !== undefined
        ? [
            `You can answer one with \`${replyTool}\`.${renderArgs(registry, "comment.reply")} It needs the id of the comment you are answering and the text; READ ITS OWN PARAMETERS and call it the way IT is documented, because how a forge spells "this answers that comment" is the tool's business, not something to assume from another platform.`,
          ]
        : [
            "Nothing you hold can answer an existing comment on this forge, so say that in your report rather than opening a new comment to stand in for a reply.",
          ]),
      "Whether any of this is worth saying is your judgement. None of it is counted as delivery — the findings listed above are what this run is held to — so reply where it serves the review and stay quiet where it does not.",
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
  /**
   * The agent's report that this platform has NO review state meaning the decision.
   * Bitbucket, for one, has approve and needs-work but nothing that means "commented",
   * and forcing one of the two onto a pull request would say something the review did
   * not decide. Leaving the state alone is then correct, so it is not a failure.
   */
  verdictStateless?: boolean;
}): {
  confirmation: PostingConfirmation;
  /** Inline never anchored; the posted summary carries these findings instead. */
  summaryOnly: string[];
  summaryPosted: boolean;
  verdictSet: boolean;
  described: boolean;
  /**
   * Findings whose thread this run actually answered, proven the way every other write is
   * (TASKS:Y4.4): a clean result from the reply tool whose captured arguments carry the
   * reply marker. Before this, a reply was the one write surface outside the contract —
   * the marker sat in a body nobody checked was sent, so the agent's word was the only
   * evidence, and a reply it merely claimed would be re-sent on the next run for ever.
   */
  repliesConfirmed: string[];
  failures: (string | undefined)[];
} => {
  const { plan, registry, results } = input;
  const payloadsOf = (tool: string | undefined): unknown[] =>
    results
      .filter((result) => tool === undefined || result.name === tool)
      .map((result) => result.result);

  // Three evidence sources, strongest first. (1) ACCEPTED WRITES: the captured call's
  // params carry each body verbatim, marker included, and a clean result is the
  // platform accepting it — race-free, but only once the lifecycle submit (where one is
  // mapped) came back clean, because an accepted write into a review nobody submits is
  // invisible. (2) Result bodies, for forges that echo them. (3) The re-read of the
  // target — right when it answers, but served from an eventually-consistent view.
  const submitOk =
    registry.toolFor("review.begin") === undefined ||
    confirmToolRan(results, registry.toolFor("review.submit"));
  const intended = plan.comments.map((comment) => ({ id: comment.findingId }));
  const accepted = submitOk
    ? confirmAcceptedWrites({
        intended,
        results,
        tool: registry.toolFor("comment.inline.create"),
      })
    : confirmPosted({ intended, results: [] });
  const confirmation = mergeConfirmations(
    accepted,
    confirmFromComments({
      confirmation: confirmPosted({
        intended,
        results: payloadsOf(registry.toolFor("comment.inline.create")),
      }),
      comments: input.readBack ?? [],
    }),
  );
  // Replies, held to the same standard as everything else this stage writes. Nothing
  // REQUIRES a reply — the findings list is still the only contract — so this proves what
  // happened rather than gating on it.
  const repliesConfirmed = confirmAcceptedWrites({
    intended: plan.alreadyPosted.map((entry) => ({ id: entry.findingId })),
    results,
    tool: registry.toolFor("comment.reply"),
    kind: REPLY_MARKER_KIND,
  }).posted.map((entry) => entry.findingId);

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
      confirmCreated(summaryResults) ||
      confirmAcceptedWrites({
        intended: [{ id: input.runId }],
        results,
        tool: registry.toolFor("comment.summary.create"),
        kind: RUN_MARKER_KIND,
      }).ok);
  // The verdict state is proven by the mapped tool having run and come back clean.
  //
  // It deliberately does NOT check which value was sent. Every platform spells its
  // states differently — GitHub REQUEST_CHANGES / COMMENT / APPROVE, Bitbucket
  // APPROVED / NEEDS_WORK / UNAPPROVED — and a vocabulary hardcoded here called a
  // correct Bitbucket call wrong. The agent reads the tool's own schema and picks the
  // value; this reads whether the platform took it. Some platforms have no state at
  // all for some decisions, which is what `verdictStateless` reports — an outcome, not
  // a failure.
  const verdictSet =
    plan.actions.includes("verdict") &&
    confirmToolRan(results, registry.toolFor("verdict.set"));
  // A stateless claim is the ONE place delivery would take the agent's word for an
  // outcome, and this project does not do that. So it is accepted only against evidence
  // the agent cannot fake: the summary comment, confirmed on the pull request, carries
  // `Verdict: <decision>` in its text. With that posted, a platform having no review
  // state costs nothing — the decision is still there for a human to read. Without it,
  // the decision reached the pull request nowhere at all, and that is a failure whatever
  // the agent reported (raised in review: an agent claim was masking a missed verdict).
  const verdictDelivered =
    verdictSet || (input.verdictStateless === true && summaryPosted);
  const described =
    plan.description !== undefined &&
    confirmToolRan(results, registry.toolFor("pr.describe"));
  // Where the forge maps the pending-review lifecycle, inline comments are invisible
  // until the submit call returns — a written-but-unsubmitted review is not delivery.
  const reviewSubmitted =
    plan.comments.length === 0 ||
    registry.toolFor("review.begin") === undefined ||
    confirmToolRan(results, registry.toolFor("review.submit"));

  // A finding whose inline post never anchored is still DELIVERED when the summary
  // that lists every finding is provably on the target: nothing is lost, the location
  // is worse. Reported as summaryOnly, not as a failure — a model choosing a line
  // outside the diff must not turn a delivered review into a red run.
  const summaryOnly = summaryPosted ? confirmation.unposted : [];
  const effective = summaryPosted
    ? { ...confirmation, unposted: [], ok: confirmation.unmatched.length === 0 }
    : confirmation;

  return {
    confirmation: effective,
    summaryOnly,
    summaryPosted,
    verdictSet,
    described,
    repliesConfirmed,
    failures: [
      postingFailure(effective),
      plan.summary !== undefined && !summaryPosted
        ? "the summary comment was never confirmed as posted"
        : undefined,
      plan.actions.includes("verdict") && !verdictDelivered
        ? input.verdictStateless === true
          ? "this platform was reported to have no review state for the decision, and the summary that would have carried it did not land either — the decision is nowhere on the pull request"
          : "the review state was never confirmed as set"
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

/**
 * The confirm re-read ladder. GitHub answers the review-comment listing from an
 * eventually-consistent view, and a single 15-second retry was measured LOSING that
 * race live: a comment verifiably on the pull request was still unlisted at the second
 * read, and the run honestly exited 3 over a delivery that had in fact landed. Three
 * reads across a 45-second window outlast the observed lag; a ladder longer than the
 * suite's 60-second hang budget is itself a defect.
 */
const RECONFIRM_DELAYS_MS = [0, 15_000, 30_000] as const;

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
  /** The change under review, restated so delivery can read files for suggestions. */
  facts?: TargetFacts;
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
        ...(options.facts !== undefined ? { facts: options.facts } : {}),
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
    ...(output?.data.verdictStateless === true
      ? { verdictStateless: true }
      : {}),
  });
  // The write results could not prove the posts. Ask the platform what the pull request
  // now shows — the one source that is right whatever the results looked like. A review
  // submitted moments ago may not be listable yet (GitHub answers the re-read from an
  // eventually-consistent view), so the ladder re-reads across a window that outlasts
  // the lag. Only a MISSING capability ends it early: with no way to read comments,
  // waiting cannot help — but a read that merely ERRORED gets retried like an empty
  // one, because a transient failure at t=0 says nothing about t+30s (a break on it
  // ended the ladder immediately and reported a delivered review as unconfirmed, live).
  const canReRead = options.registry.toolFor("comment.list") !== undefined;
  for (const delay of RECONFIRM_DELAYS_MS) {
    if (!canReRead || confirmed.confirmation.ok || plan.comments.length === 0) {
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
      ...(output?.data.verdictStateless === true
        ? { verdictStateless: true }
        : {}),
    });
  }
  const { confirmation, summaryOnly, summaryPosted, verdictSet, described } =
    confirmed;

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
    ...(summaryOnly.length > 0 ? { summaryOnly } : {}),
    summaryPosted,
    verdictSet,
    described,
    ...(confirmed.repliesConfirmed.length > 0
      ? { repliesConfirmed: confirmed.repliesConfirmed }
      : {}),
    ...(failures.length > 0 ? { failure: failures.join("\n") } : {}),
  };
};
