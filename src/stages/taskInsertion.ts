/**
 * Task Insertion (TASKS:Y3.2) — understand the change, then write the checklist.
 *
 * The shell does the deterministic half: resolve the target, acquire the diff with argv
 * git, bank the WHOLE patch, and work out whether this target has been reviewed before.
 * The agent does the judgement half: read the change and commit to a concrete list of
 * review pointers, created through the checklist tools so the shell can hold it to them.
 *
 * The patch is never pasted into the prompt in full. The agent gets the per-file summary,
 * a bounded preview and the artifactId — and reads the rest back when it matters.
 */
import {
  checkpointWithSchemaGate,
  classifyPriorFindings,
} from "../gates/index.js";
import {
  CHECKLIST_TOOLS,
  READ_ONLY_TOOLS,
  acquireDiff,
  resolveDiffRange,
  summarizeDiff,
} from "../tools/index.js";
import type {
  Engine,
  EngineBankedRef,
  GitDiff,
  InsertionStageResult,
  OperatingBrief,
  RecurrenceState,
  RunContext,
  SessionRunner,
} from "../types/index.js";
import { acquireIncrementalDiff, describePriorFinding } from "./recurrence.js";
import { InsertionPlanSchema } from "./schema.js";

/** Room to read the changed files and think, before writing the checklist. */
const INSERTION_MAX_STEPS = 32;
/** How much of the patch travels inline. The rest is one retrieve_context call away. */
const DIFF_PREVIEW_CHARS = 4_000;

/**
 * Acquires the diff for one target, whole.
 *
 * Local mode is the working tree plus untracked files. Branch and pull-request modes come
 * from GIT, not from the platform (TASKS:Y5.4): `merge-base(base, head)..head` is exactly
 * "what this change adds", it costs no API call, and it reads the same on every forge. The
 * platform is asked for comments and the verdict, and for nothing else.
 *
 * A pull request is reviewed at whatever is checked out — CI checks the head out — so its
 * head ref is HEAD; a branch target names its own head and does not need checking out.
 */
export const acquireTargetDiff = async (
  run: RunContext,
  signal?: AbortSignal,
): Promise<GitDiff> => {
  if (run.target.mode === "local") {
    return acquireDiff({ root: run.root }, signal);
  }
  const range = await resolveDiffRange({
    root: run.root,
    head: run.target.mode === "branch" ? run.target.branch : "HEAD",
    ...(run.target.base !== undefined ? { base: run.target.base } : {}),
    ...(signal ? { signal } : {}),
  });
  return acquireDiff({ root: run.root, ...range }, signal);
};

/** The prompt: what changed, what has already been reviewed, and what to produce. */
export const buildTaskInsertionPrompt = (input: {
  brief: OperatingBrief;
  diff: GitDiff;
  banked: EngineBankedRef;
  recurrence: RecurrenceState;
  /** `lastReviewedSha..head`, when a previous run left a sha to measure from. */
  incremental?: GitDiff;
  incrementalBanked?: EngineBankedRef;
}): string => {
  const { brief, diff, banked, recurrence } = input;
  const lines: string[] = [
    "TASK INSERTION. Read this change, then write the checklist this review has to finish.",
    "",
    `Review posture you distilled: ${brief.persona}`,
    brief.focusAreas.length > 0
      ? `This repository cares most about: ${brief.focusAreas.join(", ")}.`
      : "This repository named no particular focus areas.",
    "",
    `The change: ${diff.files.length} file(s), +${diff.additions} -${diff.deletions}.`,
    diff.files.length > 0 ? summarizeDiff(diff) : "  (no files changed)",
    "",
    `The full patch is banked as artifactId "${banked.id}" (${banked.sizeBytes} bytes).`,
    `Read it with: ${banked.readBackHint}`,
    "First page of it:",
    "```diff",
    banked.preview,
    "```",
    "",
  ];

  if (recurrence.kind === "recurring") {
    lines.push(
      `This target has been reviewed before${recurrence.lastReviewedAt ? ` (last run ${recurrence.lastReviewedAt})` : ""}${recurrence.lastReviewedSha ? ` at ${recurrence.lastReviewedSha}` : ""}.`,
    );

    if (
      input.incremental !== undefined &&
      input.incrementalBanked !== undefined
    ) {
      lines.push(
        "",
        `Since that review, ${input.incremental.files.length} file(s) moved (+${input.incremental.additions} -${input.incremental.deletions}). This is where your attention is worth most — but the checklist covers the WHOLE change above, because the whole change is what gets merged.`,
        summarizeDiff(input.incremental),
        `That incremental patch is banked as artifactId "${input.incrementalBanked.id}" — read it with: ${input.incrementalBanked.readBackHint}`,
      );
    } else if (recurrence.lastReviewedSha !== undefined) {
      lines.push(
        `  (the commit that review looked at is not in this checkout, so there is no incremental patch — treat the whole change as new)`,
      );
    }

    if (recurrence.priorFindings.length > 0) {
      lines.push(
        "",
        `The previous review left ${recurrence.priorFindings.length} finding(s) open. You must account for EVERY one of them in \`priorFindings\`:`,
        ...recurrence.priorFindings.map(describePriorFinding),
        "",
        "  fixed  — you read the current code and the problem is gone. Say which line settles it.",
        "  moot   — this change no longer touches what the finding was about.",
        "  open   — anything else. A finding you did not check is open, not fixed.",
        "",
        "Anything you leave out is carried as STILL OPEN and counted against this change, so leaving one out only costs you the chance to explain it.",
      );
    } else {
      lines.push("The previous review left no open findings.");
    }

    if (recurrence.previouslyReported.length > 0) {
      lines.push(
        "",
        `Already commented on this target by an earlier review: ${recurrence.previouslyReported.map((entry) => entry.findingId).join(", ")}. Do not plan to say any of them again — re-posting is handled for you.`,
      );
    }
    lines.push("");
  } else {
    lines.push("This is the first review of this target.", "");
  }

  lines.push(
    "How to do it:",
    "  1. Read the changed files with read_file, and page through the banked patch where the summary is not enough. Do not review from the preview alone.",
    "  2. Turn what you find into concrete, checkable pointers. 'Check the new token endpoint against the auth rules' is a task; 'review the code' is not.",
    "  3. Cover what the change touches AND what it should have touched: tests for new behaviour, migrations, config, callers of a changed signature.",
    "  4. Create the checklist with tasks_create, one title per pointer, and put the ids it returns in `checklistIds`.",
    "  5. Mark each task `delegate: true` when it is big or self-contained enough to hand to a worker.",
    ...(recurrence.priorFindings.length > 0
      ? [
          "  6. Read the current code for each prior finding above and report what became of it in `priorFindings`. A prior finding that is still open needs no new checklist item — it is already counted.",
        ]
      : []),
    "",
    "Then report the plan: what this change does (from the diff, not from a title), where the risk is, and the tasks you created.",
  );
  return lines.join("\n");
};

/** Runs Task Insertion as a checkpoint on the main session and banks the plan. */
export const runTaskInsertion = async (options: {
  session: SessionRunner;
  engine: Engine;
  run: RunContext;
  brief: OperatingBrief;
  /** Read before this run overwrites the store's run report — see `detectRecurrence`. */
  recurrence: RecurrenceState;
  /** Live review-phase capability tools (TASKS:Y5.1); never a posting tool. */
  extraTools?: readonly string[];
}): Promise<InsertionStageResult> => {
  const diff = await acquireTargetDiff(options.run, options.run.signal);
  const banked = await options.engine.bankReport({
    kind: "stage-output",
    label: `diff-${options.run.target.mode}`,
    payload: diff.patch,
    previewChars: DIFF_PREVIEW_CHARS,
  });

  // What moved since the last review (TASKS:Y7.1). Banked in its own artifact so the
  // agent can page it; the whole-change patch above is still what the checklist covers.
  const incremental = await acquireIncrementalDiff(
    options.run,
    options.recurrence,
    options.run.signal,
  );
  const incrementalBanked =
    incremental === undefined
      ? undefined
      : await options.engine.bankReport({
          kind: "stage-output",
          label: `diff-since-${options.recurrence.lastReviewedSha ?? "last"}`,
          payload: incremental.patch,
          previewChars: DIFF_PREVIEW_CHARS,
        });

  const plan = await checkpointWithSchemaGate({
    session: options.session,
    request: {
      stage: "taskInsertion",
      prompt: buildTaskInsertionPrompt({
        brief: options.brief,
        diff,
        banked,
        recurrence: options.recurrence,
        ...(incremental !== undefined ? { incremental } : {}),
        ...(incrementalBanked !== undefined ? { incrementalBanked } : {}),
      }),
      schema: InsertionPlanSchema,
      tools: [
        ...READ_ONLY_TOOLS,
        ...CHECKLIST_TOOLS,
        ...(options.extraTools ?? []),
      ],
      maxSteps: INSERTION_MAX_STEPS,
    },
  });

  return {
    plan,
    diff,
    banked,
    ...(incremental !== undefined ? { incremental } : {}),
    ...(incrementalBanked !== undefined ? { incrementalBanked } : {}),
    prior: classifyPriorFindings({
      prior: options.recurrence.priorFindings,
      ...(plan.data.priorFindings !== undefined
        ? { reviewed: plan.data.priorFindings }
        : {}),
    }),
  };
};
