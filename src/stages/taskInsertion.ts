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
  buildPreparationNudge,
  checkCoverage,
  checkpointWithSchemaGate,
  checklistProblems,
  classifyPriorFindings,
  distinctTasks,
  preparationFatal,
} from "../gates/index.js";
import { StageError } from "../core/errors.js";
import {
  CHECKLIST_TOOLS,
  READ_ONLY_TOOLS,
  acquireDiff,
  resolveDiffRange,
  summarizeDiff,
} from "../tools/index.js";
import { matchesAnyGlob } from "../util/glob.js";
import type {
  Engine,
  EngineBankedRef,
  GitChangedFile,
  GitDiff,
  InsertionPlan,
  InsertionStageResult,
  InsertionTask,
  OperatingBrief,
  RecurrenceState,
  RunContext,
  SessionRunner,
  Stage,
  StageOutput,
  TargetFacts,
} from "../types/index.js";
import { acquireIncrementalDiff, describePriorFinding } from "./recurrence.js";
import { InsertionPlanSchema } from "./schema.js";
import { renderTargetFacts } from "./target.js";

/**
 * Room to read the changed files and think, before writing the checklist.
 *
 * Sized so that READING is never the thing that runs out. At 32 this stage was the
 * starved outlier — the work stage has 160 — and a change of any size spent most of it
 * just opening files. Reading the change is the work here, not a cost to be managed, so
 * the ceiling is a hang detector rather than a budget the agent has to ration.
 */
const INSERTION_MAX_STEPS = 96;
/**
 * Rounds the shell will spend getting a workable checklist out of the stage.
 *
 * The checklist is the spine of the run — Work takes its work from it, delegates from it
 * and reports against it — so "no usable checklist" is not a degraded review, it is an
 * absent one, and the shell converges on one rather than either dying at the first miss or
 * shrugging and carrying on. The last round asks for the smallest thing that can still
 * work; only after it does the run fail.
 */
const PREPARE_MAX_ROUNDS = 2;
/** A nudge round is not an investigation: create what is missing and answer. */
const PREPARE_MAX_STEPS = 16;
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

/** What every section of a unified diff opens with. */
const DIFF_HEADER = "diff --git ";

/** The single-character escapes git writes inside a quoted path. */
const GIT_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  t: "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

const isOctalTriple = (text: string): boolean =>
  text.length === 3 && [...text].every((digit) => digit >= "0" && digit <= "7");

/**
 * Git's C-style quoting, undone.
 *
 * A quoted header escapes every byte it had to: `\t`, `\"`, `\\`, and — under the default
 * `core.quotePath` — each non-ASCII BYTE as an octal triple, so `café.svg` travels as
 * `caf\303\251.svg`. The file list does not: `git diff --name-status -z` emits paths raw.
 * Leaving the escapes in place therefore gave the two exclusion predicates different
 * strings for the same file, and `review.exclude: ["café.svg"]` dropped it from the file
 * list while keeping its hunks in the banked patch (caught in review, reproduced against a
 * real repository). Octal escapes are collected as bytes and decoded as UTF-8 together,
 * because one character is several of them.
 */
const unquoteGitPath = (quoted: string): string => {
  if (!quoted.includes("\\")) {
    return quoted;
  }
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let index = 0;
  while (index < quoted.length) {
    const char = quoted[index] ?? "";
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      index += 1;
      continue;
    }
    const octal = quoted.slice(index + 1, index + 4);
    if (isOctalTriple(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const next = quoted[index + 1];
    if (next === undefined) {
      bytes.push(...encoder.encode("\\"));
      break;
    }
    bytes.push(...encoder.encode(GIT_ESCAPES[next] ?? next));
    index += 2;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

/**
 * The path a `diff --git` section is about, read off its own header.
 *
 * Git writes `diff --git a/x b/x`, and QUOTES both sides when the path needs it
 * (`diff --git "a/weird name.svg" "b/weird name.svg"`). Matching the header by substring
 * missed the quoted form, so an excluded file kept its hunks in the banked patch while
 * being absent from the file list — the two disagreeing about what was excluded.
 *
 * Parsed by scanning, never by an anchored `(.+)$` pattern: a diff is library input, and
 * such a pattern backtracks polynomially on a header built of many ` b/` repeats (CodeQL
 * js/polynomial-redos, raised on exactly this function). Every step below is linear.
 */
const sectionPath = (section: string): string | undefined => {
  const end = section.indexOf("\n");
  const header = end === -1 ? section : section.slice(0, end);
  if (!header.startsWith(DIFF_HEADER)) {
    return undefined;
  }
  const paths = header.slice(DIFF_HEADER.length);
  if (paths.endsWith('"')) {
    // `"a/<path>" "b/<path>"`: identical halves again, so the same arithmetic split
    // settles a name that itself contains a quote — which no scan for the b-side can.
    const quotedHalf = (paths.length - 9) / 2;
    if (
      Number.isInteger(quotedHalf) &&
      quotedHalf > 0 &&
      paths.startsWith('"a/') &&
      paths.slice(3, 3 + quotedHalf) ===
        paths.slice(paths.length - 1 - quotedHalf, -1)
    ) {
      return unquoteGitPath(paths.slice(paths.length - 1 - quotedHalf, -1));
    }
    const open = paths.lastIndexOf('"b/');
    return open === -1 ? undefined : unquoteGitPath(paths.slice(open + 3, -1));
  }
  // `a/<path> b/<path>`. The halves are IDENTICAL for anything but a rename, so the
  // split point is arithmetic — which also settles the one case no scan can, a path
  // that itself contains " b/".
  const half = (paths.length - 5) / 2;
  if (
    Number.isInteger(half) &&
    half > 0 &&
    paths.startsWith("a/") &&
    paths.slice(2, 2 + half) === paths.slice(paths.length - half)
  ) {
    return paths.slice(paths.length - half);
  }
  // A rename: the two sides differ, and the b-side is the file this diff produces.
  const b = paths.lastIndexOf(" b/");
  return b === -1 ? undefined : paths.slice(b + 3);
};

/**
 * Drops the sections of a unified diff whose file the caller excluded.
 *
 * Takes the PATTERNS, not the resolved paths, and runs the same `matchesAnyGlob` the file
 * list was filtered with — one predicate, so the patch and `diff.files` cannot disagree
 * about what was excluded. A section whose header cannot be parsed is KEPT: showing a hunk
 * that should have been dropped is a smaller failure than silently discarding a real one.
 */
const stripPatchOf = (patch: string, patterns: readonly string[]): string => {
  if (patch.length === 0) {
    return patch;
  }
  return patch
    .split(/^(?=diff --git )/m)
    .filter((section) => {
      const path = sectionPath(section);
      return path === undefined || !matchesAnyGlob(path, patterns);
    })
    .join("");
};

/**
 * Drops the paths a repository excluded, and says which (TASKS:Y5.6).
 *
 * Applied to the diff the whole run works from, so the checklist, the workers, the
 * groundedness gate and delivery all see the same change set: an excluded file cannot be
 * reviewed, cited, or commented on. Generated files are the reviewer's worst input — a
 * lockfile's hundreds of changed lines carry no judgement to make and crowd out the change
 * that does (measured: 940 of 953 changed lines on a real pull request).
 *
 * What was dropped is RETURNED, never merely discarded: a review that quietly narrows what
 * it looked at is the failure this project exists to prevent, so the caller puts it in the
 * run report.
 */
export const excludeFromDiff = (
  diff: GitDiff,
  patterns: readonly string[],
): { diff: GitDiff; excluded: string[] } => {
  if (patterns.length === 0 || diff.files.length === 0) {
    return { diff, excluded: [] };
  }
  const kept: GitChangedFile[] = [];
  const excluded: string[] = [];
  for (const file of diff.files) {
    if (matchesAnyGlob(file.path, patterns)) {
      excluded.push(file.path);
    } else {
      kept.push(file);
    }
  }
  if (excluded.length === 0) {
    return { diff, excluded };
  }
  return {
    diff: {
      ...diff,
      files: kept,
      additions: kept.reduce((sum, file) => sum + file.additions, 0),
      deletions: kept.reduce((sum, file) => sum + file.deletions, 0),
      // The patch is banked and read back on demand; leaving the excluded hunks in it
      // would hand back exactly what the exclusion removed.
      patch: stripPatchOf(diff.patch, patterns),
      empty: kept.length === 0,
    },
    excluded,
  };
};

/** The prompt: what changed, what has already been reviewed, and what to produce. */
export const buildTaskInsertionPrompt = (input: {
  brief: OperatingBrief;
  diff: GitDiff;
  banked: EngineBankedRef;
  /** Paths `review.exclude` kept out, so an all-excluded change is not read as empty. */
  excluded?: readonly string[];
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
    diff.files.length > 0
      ? summarizeDiff(diff)
      : input.excluded !== undefined && input.excluded.length > 0
        ? `  (every changed file is excluded from review: ${input.excluded.join(", ")})`
        : "  (no files changed)",
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
        "Already commented on this target by an earlier review — re-posting is handled for you, so do not plan to say any of them again:",
        ...recurrence.previouslyReported.map((entry) => {
          const answered = entry.replies ?? [];
          return `  ${entry.findingId} (comment ${entry.commentId})${
            answered.length === 0
              ? " — nobody has replied"
              : `\n${answered
                  .map(
                    (reply) =>
                      `      ${reply.author ?? "someone"} replied: ${reply.body.slice(0, 400)}`,
                  )
                  .join("\n")}`
          }`;
        }),
        "",
        "A reply is a CLAIM, not evidence. Somebody saying a finding is fixed, wrong, or intended does not settle it — the current code does. Read what the code says now and classify on that; where a reply explains WHY something is intended, that is a reason to weigh, and where the code still does what the finding described, the finding is still open however confidently it was answered.",
      );
    }
    lines.push("");
  } else {
    lines.push("This is the first review of this target.", "");
  }

  lines.push(
    "Read as much of the change as you need to — read_file takes a whole file in one call, and its offset and limit are LINES if you ever want part of one.",
    "THIS STAGE DOES NOT REVIEW. Do not verify a claim, chase a caller, or decide whether something is a defect: that is the next stage, which has workers to delegate to. Read enough to know what must be checked, then write the checklist. A stage that stops to review produces no checklist, and a review with no checklist does not happen at all.",
    "",
    "How to do it:",
    "  1. Read the changed files with read_file, and page through the banked patch where the summary is not enough. Do not plan from the preview alone.",
    "  2. Turn what you find into concrete, checkable pointers. 'Check the new token endpoint against the auth rules' is a task; 'review the code' is not.",
    "  3. Cover what the change touches AND what it should have touched: tests for new behaviour, migrations, config, callers of a changed signature.",
    "  4. EVERY changed file above must be named in the `scope` of at least one task. A file you judge to need no review is still one an item accounts for, saying so — what you may not do is leave it out, because it is being merged either way.",
    "  5. Create the checklist with tasks_create, one title per pointer, and put the ids it returns in `checklistIds`. Until you call it, nothing you planned exists.",
    "  6. Mark each task `delegate: true` when it is big or self-contained enough to hand to a worker.",
    ...(recurrence.priorFindings.length > 0
      ? [
          "  7. Read the current code for each prior finding above and report what became of it in `priorFindings`. A prior finding that is still open needs no new checklist item — it is already counted.",
        ]
      : []),
    "",
    "Then report the plan: what this change does (from the diff, not from a title), where the risk is, and the tasks you created.",
  );
  return lines.join("\n");
};

/**
 * The plan's items across every preparation round, deduped.
 *
 * A nudge round answers with a fresh plan, and there is no rule that says it repeats the
 * items it already created — so coverage has to be measured against everything the run has
 * planned, not against the last answer alone. The engine's checklist is cumulative for the
 * same reason: `tasks_create` adds.
 */
const mergeTasks = (
  seen: readonly InsertionTask[],
  added: readonly InsertionTask[],
): InsertionTask[] => {
  const byKey = new Map(
    [...seen, ...added].map((task) => [
      `${task.title}::${task.scope.join(",")}`,
      task,
    ]),
  );
  return [...byKey.values()];
};

/**
 * Gets a workable checklist out of the stage, or fails the run saying so (TASKS:Y4.6).
 *
 * The question the shell asks first is not "did the agent comply" but "is a checklist
 * OWED": a change with no reviewable file owes none, and this returns the plan untouched.
 * Where one is owed, the gate names what is missing — no items at all, or changed files no
 * item answers for — and hands that back with the change itself attached, narrowing the ask
 * each round. What it never does is decide the content: which files need what, and whether
 * a file needs nothing, stays the reviewer's call.
 *
 * Failure is the last resort and it is loud, because the alternative is the failure this
 * project exists to prevent — a run that reviewed nothing and approved it.
 */
const prepareChecklist = async (input: {
  session: SessionRunner;
  engine: Engine;
  files: readonly string[];
  request: { prompt: string; tools: string[] };
  facts: string;
}): Promise<StageOutput<Stage, InsertionPlan>> => {
  const { session, engine, files } = input;
  let plan = await checkpointWithSchemaGate({
    session,
    request: {
      stage: "taskInsertion",
      prompt: input.request.prompt,
      schema: InsertionPlanSchema,
      tools: input.request.tools,
      maxSteps: INSERTION_MAX_STEPS,
    },
    // A stage cut off mid-work closes holding the checklist tools: its answer is a claim
    // about items that have to exist, and a closing ask that cannot create them can only
    // produce a plan nobody can work.
    recovery: {
      tools: CHECKLIST_TOOLS,
      context: input.facts,
      maxSteps: PREPARE_MAX_STEPS,
    },
  });

  let tasks = mergeTasks([], plan.data.tasks);
  for (let round = 0; round < PREPARE_MAX_ROUNDS; round += 1) {
    const checklist = distinctTasks(
      (await engine.tasksApi(session.sessionId)).tasks,
    );
    const problems = checklistProblems({ files, tasks, checklist });
    if (problems.length === 0) {
      return { ...plan, data: { ...plan.data, tasks } };
    }
    const final = round === PREPARE_MAX_ROUNDS - 1;
    plan = await checkpointWithSchemaGate({
      session,
      request: {
        stage: "taskInsertion",
        prompt: buildPreparationNudge({
          problems,
          files,
          coverage: checkCoverage({ files, tasks }),
          checklist,
          facts: input.facts,
          ...(final ? { final } : {}),
        }),
        schema: InsertionPlanSchema,
        // The last round holds only the tools that RECORD the checklist. Reading more is
        // not what has been missing, and the budget is what ran out the first time.
        tools: final ? [...CHECKLIST_TOOLS] : input.request.tools,
        maxSteps: PREPARE_MAX_STEPS,
      },
      retries: 0,
      recovery: {
        tools: CHECKLIST_TOOLS,
        context: input.facts,
        maxSteps: PREPARE_MAX_STEPS,
      },
    });
    tasks = mergeTasks(tasks, plan.data.tasks);
  }

  const checklist = distinctTasks(
    (await engine.tasksApi(session.sessionId)).tasks,
  );
  const problems = checklistProblems({ files, tasks, checklist });
  if (preparationFatal({ files, tasks, checklist })) {
    throw new StageError(
      "taskInsertion",
      `${problems.join("; ")} — after ${PREPARE_MAX_ROUNDS + 1} attempt(s) at preparing one. Nothing downstream can run: the work stage takes its work from the checklist, so a review without one would report on nothing and call it clean`,
      plan.path ?? "",
    );
  }
  // Not fatal, not finished: the review goes ahead over what IS covered, and the shell
  // carries the rest by name into the run report. Silence about what a review skipped is
  // the failure; saying it out loud is not.
  return { ...plan, data: { ...plan.data, tasks } };
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
  /** Paths this repository excludes from review — generated files, mostly. */
  exclude?: readonly string[];
}): Promise<InsertionStageResult> => {
  const whole = await acquireTargetDiff(options.run, options.run.signal);
  // Before anything reads it: an excluded path is not part of the change under review.
  const { diff, excluded } = excludeFromDiff(whole, options.exclude ?? []);
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

  // The run's ground truth, built once here and handed to every stage after this one —
  // including this stage's own recovery asks, which is what lets a cut-off attempt be
  // closed out rather than restarted from nothing (TASKS:Y3.2).
  const facts: TargetFacts = {
    target: options.run.target,
    diff,
    banked,
    ...(excluded.length > 0 ? { excluded } : {}),
  };

  const plan = await prepareChecklist({
    session: options.session,
    engine: options.engine,
    files: diff.files.map((file) => file.path),
    facts: renderTargetFacts(facts),
    request: {
      prompt: buildTaskInsertionPrompt({
        brief: options.brief,
        diff,
        banked,
        ...(excluded.length > 0 ? { excluded } : {}),
        recurrence: options.recurrence,
        ...(incremental !== undefined ? { incremental } : {}),
        ...(incrementalBanked !== undefined ? { incrementalBanked } : {}),
      }),
      tools: [
        ...READ_ONLY_TOOLS,
        ...CHECKLIST_TOOLS,
        ...(options.extraTools ?? []),
      ],
    },
  });

  const uncovered = checkCoverage({
    files: diff.files.map((file) => file.path),
    tasks: plan.data.tasks,
  }).uncovered;

  return {
    plan,
    diff,
    facts,
    ...(uncovered.length > 0 ? { uncovered } : {}),
    ...(excluded.length > 0 ? { excluded } : {}),
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
