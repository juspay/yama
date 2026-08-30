/**
 * `yama learn` (TASKS:Y7.2) — the post-merge knowledge update.
 *
 * The review path never pays for this (PLAN.md section 1): learning happens once, after a
 * pull request merges, when there is finally evidence of what humans made of the review.
 * That evidence is the discussion — a finding a reviewer acted on was right, a finding a
 * reviewer argued down is a suppression waiting to be written, and both are worth more
 * than any amount of re-reading the diff.
 *
 * The shape is deliberately narrow:
 *
 *   read the comments (deterministic, through the capability)
 *     → bank them whole
 *     → ONE structured triage pass
 *     → render memory files (deterministic)
 *     → one commit, under the strictest write rules Yama has (`src/tools/gitWriter.ts`)
 *
 * One model call, because triage is one judgement: what did this discussion settle. Two
 * calls would mean two answers about the same thread.
 */
import { ConfigError, loadConfig } from "../config/index.js";
import { connectPlatform, readTargetComments } from "../platform/index.js";
import { LearnTriageSchema } from "../stages/index.js";
import {
  ensureStore,
  readLedger,
  resolveStorePaths,
  writePayload,
} from "../store/index.js";
import {
  READ_ONLY_TOOLS,
  commitMemory,
  isGitRepo,
  planMemoryCommit,
  readFactFiles,
  renderMemoryFiles,
  scanMarkers,
} from "../tools/index.js";
import type {
  Engine,
  EngineBankedRef,
  ExistingComment,
  Finding,
  LearnResult,
  LearnTriage,
  MemoryFact,
  ResolvedConfig,
  RunStorePaths,
  RunTarget,
} from "../types/index.js";
import { buildEngineConfig } from "./engineConfig.js";

/** Triage is a reading task, not an investigation. */
const LEARN_MAX_STEPS = 24;

/** How much of the banked thread travels inline. The rest is one read-back away. */
const THREAD_PREVIEW_CHARS = 4_000;

/** One comment as the prompt shows it: id, the findings it names, and its text. */
const renderComment = (comment: ExistingComment): string => {
  const markers = scanMarkers(comment.body);
  return [
    `--- comment ${comment.id}${markers.length > 0 ? ` (about finding ${markers.join(", ")})` : ""}`,
    comment.body,
  ].join("\n");
};

/** The whole thread, verbatim, as it is banked. Nothing is elided on the way to disk. */
export const renderThread = (
  pr: number,
  comments: readonly ExistingComment[],
): string =>
  [
    `# Comments on merged pull request #${pr}`,
    `# ${comments.length} comment(s), read ${new Date().toISOString()}`,
    "",
    ...comments.map(renderComment),
  ].join("\n\n");

/**
 * The triage prompt (TASKS:Y7.2).
 *
 * Two things it is strict about, because both are ways to poison a memory: a fact must be
 * something a human DECIDED (not something the model inferred from the code), and a
 * suppression must quote the person who asked for it. A memory of the reviewer's own
 * opinions would make every later review more confident and no more correct.
 */
export const buildLearnPrompt = (input: {
  pr: number;
  comments: readonly ExistingComment[];
  findings: readonly Finding[];
  banked: {
    id: string;
    sizeBytes: number;
    preview: string;
    readBackHint: string;
  };
  existingFacts: readonly string[];
}): string => {
  const lines: string[] = [
    `LEARN. Pull request #${input.pr} has merged. Work out what its review taught this repository.`,
    "",
    input.findings.length > 0
      ? `The review of this pull request reported ${input.findings.length} finding(s):`
      : "The review of this pull request reported no findings, so there is nothing to resolve — look only for what the discussion itself teaches.",
    ...input.findings.map(
      (finding) =>
        `  ${finding.id}  ${finding.severity}  ${finding.file}:${finding.line}  ${finding.summary}`,
    ),
    "",
    `The whole discussion — ${input.comments.length} comment(s) — is banked as artifactId "${input.banked.id}" (${input.banked.sizeBytes} bytes).`,
    `Read all of it with: ${input.banked.readBackHint}`,
    "First page:",
    "```",
    input.banked.preview,
    "```",
    "",
  ];

  if (input.existingFacts.length > 0) {
    lines.push(
      `Already in this repository's memory — do NOT write these again, and reuse an id only when you are correcting that exact fact: ${input.existingFacts.join(", ")}.`,
      "",
    );
  }

  lines.push(
    "How to do it:",
    "  1. Page through the whole thread. A judgement made on the first page is usually reversed by the last.",
    "  2. For every finding above, say what the discussion settled: `accepted` (someone agreed and it was changed), `dismissed` (someone said no — quote them), or `unanswered` (nobody engaged). Cite the comment ids you read it from.",
    "  3. Write down only what a HUMAN decided. A fact is a decision this repository made, not something you worked out from the code. If nobody said it, it is not a fact.",
    "  4. A dismissal that would repeat is a `suppression`: say what class of finding not to raise, and quote the reason the reviewer gave. A dismissal that was specific to this one change teaches nothing — leave it out.",
    "  5. A `convention` is a rule the reviewers applied that the rulebook does not state. A `knowledge` fact is something true about this codebase a reviewer had to explain.",
    "  6. Give each fact a stable kebab-case id that describes it, and a scope: the paths it applies to, or none for the whole repository.",
    "",
    "Be sparing. Three facts a repository will still agree with in a year are worth more than twenty that restate the diff. Finish with one paragraph for the commit message: what this pull request taught.",
  );
  return lines.join("\n");
};

/** Facts the triage produced, deduped by id — the same id twice is one fact. */
const uniqueFacts = (facts: readonly MemoryFact[]): MemoryFact[] => {
  const byId = new Map<string, MemoryFact>();
  for (const fact of facts) {
    byId.set(fact.id, fact);
  }
  return [...byId.values()];
};

/** Loads config for a learn run, and refuses the run unless the repository opted in. */
const bootLearn = async (
  root: string,
  target: RunTarget,
): Promise<ResolvedConfig> => {
  const config = await loadConfig(root, target);
  if (!config.yama.learn.enabled) {
    throw new ConfigError(
      "learn is not enabled for this repository, so nothing was read and nothing was written",
      {
        file: config.paths.yamaFile,
        hint: "set learn.enabled: true in .yama/yama.yaml — it is off by default because learn is the only command that ever writes to your repository",
      },
    );
  }
  if (!(await isGitRepo(root))) {
    throw new Error(
      `${root} is not a git work tree — learn writes its knowledge as a commit, and there is nowhere to put one here`,
    );
  }
  return config;
};

/**
 * The one structured pass (TASKS:Y7.2). Its verbatim answer is banked whatever became of
 * it — a triage that failed its schema is exactly the one somebody needs to read.
 */
const triagePullRequest = async (input: {
  engine: Engine;
  paths: RunStorePaths;
  pr: number;
  comments: readonly ExistingComment[];
  findings: readonly Finding[];
  banked: EngineBankedRef;
  existingFacts: readonly string[];
  tools: readonly string[];
}): Promise<LearnTriage> => {
  const result = await input.engine.generateStructured({
    sessionId: `learn-pr-${input.pr}`,
    prompt: buildLearnPrompt({
      pr: input.pr,
      comments: input.comments,
      findings: input.findings,
      banked: input.banked,
      existingFacts: input.existingFacts,
    }),
    schema: LearnTriageSchema,
    tools: [...input.tools],
    maxSteps: LEARN_MAX_STEPS,
  });
  const banked = await writePayload(
    input.paths,
    `learn-pr-${input.pr}`,
    JSON.stringify(result.raw, null, 2),
    "json",
  );
  if (result.data === undefined) {
    throw new Error(
      `learn could not triage pull request #${input.pr}: nothing schema-valid came back. The engine's answer is banked in ${banked.file}`,
    );
  }
  return result.data;
};

/**
 * Runs one post-merge knowledge update.
 *
 * The engine is injectable, exactly as `runReview`'s is, so the whole flow is testable
 * without a provider; without one the seam is imported lazily and `dist/index.js` stays
 * free of the provider stack.
 */
export const runLearn = async (
  options: {
    root: string;
    pr: number;
    /** Compute everything, write nothing: no files, no staging, no commit, no push. */
    dryRun: boolean;
  },
  engine?: Engine,
): Promise<LearnResult> => {
  const target: RunTarget = { mode: "pr", pr: options.pr };
  const config = await bootLearn(options.root, target);
  const paths = resolveStorePaths(options.root, target);
  await ensureStore(paths);
  const notes: string[] = config.degradations.map(
    (degradation) => `${degradation.what} — ${degradation.reason}`,
  );

  const active =
    engine ??
    (await import("../engine/index.js")).createEngine(
      buildEngineConfig(config, {
        runId: `learn-pr-${options.pr}`,
        target,
        root: options.root,
        storeDir: paths.dir,
        dryRun: options.dryRun,
      }),
    );
  const platform = await connectPlatform({
    engine: active,
    config,
    target,
    degradations: config.degradations,
  });

  const thread = await readTargetComments({
    engine: active,
    registry: platform.registry,
  });
  if (thread.problem !== undefined) {
    throw new Error(
      `learn cannot read pull request #${options.pr}: ${thread.problem}`,
    );
  }
  const ledger = await readLedger(paths);

  // Banked BEFORE a model sees a word of it, and never truncated: the thread is the whole
  // evidence for every fact this run writes.
  const banked = await active.bankReport({
    kind: "stage-output",
    label: `learn-pr-${options.pr}-comments`,
    payload: renderThread(options.pr, thread.comments),
    previewChars: THREAD_PREVIEW_CHARS,
  });

  const memoryDir = config.memoryDir ?? config.paths.memoryDir;
  const triage = await triagePullRequest({
    engine: active,
    paths,
    pr: options.pr,
    comments: thread.comments,
    findings: ledger.findings,
    banked,
    existingFacts: (await readFactFiles(memoryDir)).map((fact) => fact.id),
    tools: [...READ_ONLY_TOOLS, ...platform.registry.reviewTools()],
  });

  const facts = uniqueFacts(triage.facts);
  const files = await renderMemoryFiles({
    memoryDir,
    facts,
    pr: options.pr,
  });
  const plan = await planMemoryCommit({
    root: options.root,
    files,
    pr: options.pr,
    summary: triage.summary,
    ...(config.yama.learn.branch !== undefined
      ? { branch: config.yama.learn.branch }
      : {}),
    remote: config.yama.learn.remote,
    commitPrefix: config.yama.learn.commitPrefix,
    skipCiToken: config.yama.learn.skipCiToken,
    push: config.yama.learn.push,
  });
  const write = await commitMemory({ plan, files, dryRun: options.dryRun });

  return {
    root: options.root,
    pr: options.pr,
    commentsRead: thread.comments.length,
    findingsKnown: ledger.findings.length,
    triage,
    banked,
    facts,
    files,
    write,
    notes,
  };
};

/** What `yama learn` prints: what it read, what it learned, and what it did about it. */
export const renderLearnResult = (result: LearnResult): string => {
  const counts = (kind: string): number =>
    result.facts.filter((fact) => fact.kind === kind).length;
  const resolutions = result.triage?.resolutions ?? [];
  const tally = (name: string): number =>
    resolutions.filter((entry) => entry.resolution === name).length;

  return [
    `yama learn — pull request #${result.pr}`,
    "",
    `  read       ${result.commentsRead} comment(s), against ${result.findingsKnown} finding(s) this repository's review recorded`,
    `  resolved   ${tally("accepted")} accepted, ${tally("dismissed")} dismissed, ${tally("unanswered")} unanswered`,
    `  learned    ${result.facts.length} fact(s): ${counts("knowledge")} knowledge, ${counts("convention")} convention, ${counts("suppression")} suppression`,
    "",
    result.facts.length > 0
      ? "facts"
      : "no facts — nothing in the discussion was worth keeping",
    ...result.facts.map(
      (fact) => `  ${fact.id} · ${fact.kind} — ${fact.statement}`,
    ),
    "",
    "commit",
    `  branch     ${result.write.plan.branch}${result.write.plan.push ? ` → ${result.write.plan.remote}` : " (not pushed: learn.push is off)"}`,
    `  subject    ${result.write.plan.subject}`,
    ...result.write.plan.paths.map((path) => `  file       ${path}`),
    ...(result.write.commit !== undefined
      ? [
          `  committed  ${result.write.commit}${result.write.pushed ? " and pushed" : ""}`,
        ]
      : []),
    ...(result.write.skipped !== undefined
      ? result.write.skipped
          .split("\n")
          .map(
            (line) =>
              `  ${result.write.nothingToCommit === true ? "NOTHING NEW" : "NOT DONE  "} ${line}`,
          )
      : []),
    ...(result.notes.length > 0
      ? [
          "",
          "switched off for this run",
          ...result.notes.map((note) => `  ${note}`),
        ]
      : []),
  ].join("\n");
};
