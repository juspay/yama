/**
 * Suite: recurring runs, description enhancement, and the negative fixtures
 * (TASKS:Y7.1, Y7.3, Y8.1).
 *
 * What is under test here is a promise about a SECOND review: it must not say the same
 * thing twice, must not quietly forget what it said the first time, and must decide over
 * everything that is still open rather than only over what it happened to look at today.
 * Every one of those is deterministic code either side of the model, so all of it runs
 * without a provider — the synthetic pull request in `fixtures/synthetic-pr/` stands in for
 * the forge, and the negative config fixtures stand in for the three ways `.yama/` breaks.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  FIXTURES,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  gitWorkspace,
  isBuilt,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("recurrence-describe-fixtures");

const SYNTHETIC = path.join(FIXTURES, "synthetic-pr");
const BAD_CONFIG = path.join(FIXTURES, "bad-config");

const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(SYNTHETIC, name), "utf8"));

type Finding = {
  id: string;
  file: string;
  line: number;
  severity: string;
  category: string;
  summary: string;
  impact: string;
  evidence: { kind: string; ref: string }[];
  confidence?: number;
};

const priorFindings = async (): Promise<Finding[]> =>
  ((await readFixture("prior-findings.json")) as { findings: Finding[] })
    .findings;

/** A registry over one capability, as `createCapabilityRegistry` produces one. */
const registryFor = async (
  tools: Record<string, string>,
  args: Record<string, Record<string, string>> = {},
): Promise<{
  has: (id: string) => boolean;
  toolFor: (id: string) => string | undefined;
  argsFor: (id: string) => Record<string, string>;
  reviewTools: () => string[];
  deliveryTools: (actions: readonly string[]) => string[];
}> => {
  const mod = await import(DIST_ENTRY);
  return mod.createCapabilityRegistry(
    Object.fromEntries(
      Object.entries(tools).map(([capability, tool]) => [
        capability,
        {
          capability,
          server: "forge",
          tool,
          args: args[capability] ?? {},
        },
      ]),
    ),
  );
};

const VERDICT = { decision: "block", reasons: ["1 CRITICAL"] };

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("the preflight marker scan: what this review has already said");

  await test("it reads the markers off the real comments, both forge shapes", async () => {
    const mod = await import(DIST_ENTRY);
    const comments = await readFixture("comments.json");
    const reg = await registryFor(
      { "comment.list": "list_comments" },
      { "comment.list": { pull: "7" } },
    );
    const calls: { name: string; params: unknown }[] = [];
    const scan = await mod.scanReportedFindings({
      engine: {
        callTool: async (name: string, params: unknown) => {
          calls.push({ name, params });
          return comments;
        },
      },
      registry: reg,
    });
    assertEqual(calls.length, 1, "the shell reads the target itself, once");
    assertEqual(
      JSON.stringify(calls[0]?.params),
      JSON.stringify({ pull: "7" }),
      "with the coordinates config gave it",
    );
    assertEqual(
      scan.reported
        .map((entry: { findingId: string }) => entry.findingId)
        .join(","),
      "auth-token-logged,weak-hash,duplicate-helper",
      "every marker on the target, whichever shape carried it",
    );
    assertEqual(
      scan.reported[0].commentId,
      "8801",
      "each finding is bound to the comment that holds it",
    );
    assertEqual(
      scan.reported.length,
      3,
      "a human reply carrying no marker is not a reported finding",
    );

    // The fixture is only worth this test if it really carries both shapes: a
    // GitHub-style comment puts its text in `body`, a Bitbucket-style one nests it
    // under `content.raw`. The ids above come back either way, so the fixture's own
    // property has to be asserted, or a reader that only understands one forge passes.
    const values = (comments as { values: Record<string, unknown>[] }).values;
    assert(
      values.some((entry) => typeof entry.body === "string"),
      "the fixture carries a comment whose text is in body",
    );
    assert(
      values.some(
        (entry) =>
          typeof (entry.content as { raw?: unknown } | undefined)?.raw ===
          "string",
      ),
      "and one whose text is nested under content.raw",
    );
  });

  await test("markers alone make a run recurring when CI lost the store", async () => {
    const mod = await import(DIST_ENTRY);
    const fresh = {
      kind: "fresh",
      source: "none",
      priorFindings: [],
      priorFindingIds: [],
      previouslyReported: [],
    };
    const seen = mod.withReportedMarkers(fresh, {
      reported: [{ findingId: "auth-token-logged", commentId: "8801" }],
    });
    assertEqual(seen.kind, "recurring", "something has reviewed this before");
    assertEqual(seen.source, "markers", "and the comments are how we know");
    assertEqual(seen.previouslyReported.length, 1, "bound to its comment");
  });

  await test("an unreadable comment list is carried as a problem, not a crash", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = await registryFor({});
    const scan = await mod.scanReportedFindings({
      engine: { callTool: async () => [] },
      registry: reg,
    });
    assertEqual(scan.reported.length, 0, "nothing was read");
    assertIncludes(String(scan.problem), "comment.list", "and it says why");

    const state = mod.withReportedMarkers(
      {
        kind: "recurring",
        source: "run-report",
        priorFindings: [],
        priorFindingIds: [],
        previouslyReported: [],
      },
      scan,
    );
    assertEqual(
      state.kind,
      "recurring",
      "a store that says recurring is not overruled by a failed scan",
    );
    assertIncludes(
      String(state.markerProblem),
      "comment.list",
      "the problem reaches the run report",
    );
  });

  section(
    "classification: every prior finding is accounted for, or it is open",
  );

  await test("fixed, moot and still-open are split by what the agent showed", async () => {
    const mod = await import(DIST_ENTRY);
    const prior = await priorFindings();
    const result = mod.classifyPriorFindings({
      prior,
      reviewed: [
        {
          id: "auth-token-logged",
          state: "fixed",
          reason: "src/auth.ts:42 now redacts the token before logging",
        },
        {
          id: "weak-hash",
          state: "open",
          reason: "src/tokens.ts:17 is unchanged",
        },
        {
          id: "duplicate-helper",
          state: "moot",
          reason: "src/legacy/format.ts is not in this change any more",
        },
      ],
    });
    assertEqual(result.fixed.join(","), "auth-token-logged", "shown fixed");
    assertEqual(result.moot.join(","), "duplicate-helper", "no longer touched");
    assertEqual(
      result.open.map((finding: Finding) => finding.id).join(","),
      "weak-hash",
      "still open",
    );
    assertEqual(result.unresolved.length, 0, "nothing was left unaccounted");
  });

  await test("a prior finding the agent said nothing about stays open, and is named", async () => {
    const mod = await import(DIST_ENTRY);
    const prior = await priorFindings();
    const result = mod.classifyPriorFindings({
      prior,
      reviewed: [
        { id: "auth-token-logged", state: "fixed", reason: "redacted now" },
      ],
    });
    assertEqual(
      result.open.map((finding: Finding) => finding.id).join(","),
      "weak-hash,duplicate-helper",
      "silence is not evidence of a fix",
    );
    assertEqual(
      result.unresolved.join(","),
      "weak-hash,duplicate-helper",
      "and the run says which ones were never looked at",
    );
    assertIncludes(
      String(mod.unresolvedPriorFindings(result)),
      "weak-hash",
      "the message names them",
    );
  });

  await test("a finding this run found again is open whatever the agent claimed", async () => {
    const mod = await import(DIST_ENTRY);
    const prior = await priorFindings();
    const result = mod.classifyPriorFindings({
      prior,
      reviewed: [
        { id: "auth-token-logged", state: "fixed", reason: "it looked fine" },
      ],
      current: ["auth-token-logged"],
    });
    assert(
      result.open.some(
        (finding: Finding) => finding.id === "auth-token-logged",
      ),
      "the evidence in front of us beats the claim about it",
    );
    assertEqual(result.fixed.length, 0, "and it is not reported as fixed");
  });

  await test("a classification of an id that was never open is ignored", async () => {
    const mod = await import(DIST_ENTRY);
    const result = mod.classifyPriorFindings({
      prior: (await priorFindings()).slice(0, 1),
      reviewed: [
        { id: "auth-token-logged", state: "fixed", reason: "redacted" },
        { id: "never-existed", state: "fixed", reason: "invented" },
      ],
    });
    assertEqual(result.fixed.join(","), "auth-token-logged", "only real ids");
    assertEqual(
      result.reviewed.length,
      1,
      "the ledger decides what was open, not the model",
    );
  });

  section(
    "the recurring prompt carries the whole history, not a summary of it",
  );

  await test("prior findings, what moved since, and what was already said", async () => {
    const mod = await import(DIST_ENTRY);
    const prior = await priorFindings();
    const diff = {
      files: [
        { path: "src/auth.ts", status: "modified", additions: 4, deletions: 2 },
      ],
      additions: 4,
      deletions: 2,
      patch: "",
      empty: false,
    };
    const banked = {
      id: "stage-output-diff-pr",
      label: "diff-pr",
      sizeBytes: 900,
      preview: "diff --git a/src/auth.ts",
      readBackHint: 'retrieve_context({ artifactId: "stage-output-diff-pr" })',
    };
    const prompt = mod.buildTaskInsertionPrompt({
      brief: {
        persona: "sceptical about auth",
        rules: [],
        focusAreas: [],
        sources: [],
        gaps: [],
      },
      diff,
      banked,
      recurrence: {
        kind: "recurring",
        source: "run-report",
        lastReviewedSha: "0000000000000000000000000000000000000000",
        lastReviewedAt: "2026-08-01T09:04:11.000Z",
        priorFindings: prior,
        priorFindingIds: prior.map((finding) => finding.id),
        previouslyReported: [
          { findingId: "auth-token-logged", commentId: "8801" },
        ],
      },
      incremental: {
        files: [
          {
            path: "src/tokens.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        additions: 1,
        deletions: 1,
        patch: "",
        empty: false,
      },
      incrementalBanked: {
        id: "stage-output-diff-since",
        label: "since",
        sizeBytes: 40,
        preview: "",
        readBackHint:
          'retrieve_context({ artifactId: "stage-output-diff-since" })',
      },
    });
    for (const finding of prior) {
      assertIncludes(prompt, finding.id, "every prior finding is named");
      assertIncludes(prompt, finding.summary, "with what it was about");
    }
    assertIncludes(prompt, "src/tokens.ts", "what moved since the last review");
    assertIncludes(
      prompt,
      "stage-output-diff-since",
      "the incremental patch is banked and referenced, never pasted",
    );
    assertIncludes(
      prompt,
      "WHOLE change",
      "and the checklist still covers everything being merged",
    );
    assertIncludes(
      prompt,
      "Already commented on this target",
      "what has already been said",
    );
  });

  await test("a sha this checkout does not have costs the incremental diff, not the run", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("recur-diff", async (dir) => {
      await gitWorkspace(dir);
      const absent = await mod.acquireIncrementalDiff(
        {
          runId: "r",
          target: { mode: "local" },
          root: dir,
          storeDir: dir,
          dryRun: true,
        },
        {
          kind: "recurring",
          source: "run-report",
          lastReviewedSha: "0".repeat(40),
          priorFindings: [],
          priorFindingIds: [],
          previouslyReported: [],
        },
      );
      assertEqual(
        absent,
        undefined,
        "a shallow clone loses the sha, not the review",
      );
    });
  });

  await test("the incremental diff is measured from the sha, untracked files included", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("recur-diff", async (dir) => {
      await gitWorkspace(dir);
      const git = (args: string[]) => runCommand("git", args, { cwd: dir });
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "reviewed here"]);
      const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await git(["commit", "-q", "--allow-empty", "-m", "later"]);
      await writeFile(
        path.join(dir, "brand-new.ts"),
        "export const x = 1;\n",
        "utf8",
      );

      const diff = await mod.acquireIncrementalDiff(
        {
          runId: "r",
          target: { mode: "local" },
          root: dir,
          storeDir: dir,
          dryRun: true,
        },
        {
          kind: "recurring",
          source: "run-report",
          lastReviewedSha: sha,
          priorFindings: [],
          priorFindingIds: [],
          previouslyReported: [],
        },
      );
      assert(diff !== undefined, "there is something to measure");
      assert(
        diff.files.some(
          (file: { path: string }) => file.path === "brand-new.ts",
        ),
        "a file created since the last review is exactly what it must not miss",
      );
    });
  });

  section("the verdict is taken over the FULL open set");

  await test("a blocking finding nobody fixed still blocks a re-review", async () => {
    const mod = await import(DIST_ENTRY);
    const prior = await priorFindings();
    // This run found only a MINOR of its own; the CRITICAL is inherited.
    const carried = prior.filter(
      (finding) => finding.id === "auth-token-logged",
    );
    const own = prior.filter((finding) => finding.id === "duplicate-helper");

    const alone = mod.decideVerdict(own, {
      blockOn: ["CRITICAL"],
      commentOn: ["MAJOR"],
      minConfidence: 0,
      blockAfter: 0,
    });
    assertEqual(
      alone.decision,
      "approve",
      "what this run found on its own is not blocking",
    );

    const full = mod.decideVerdict([...carried, ...own], {
      blockOn: ["CRITICAL"],
      commentOn: ["MAJOR"],
      minConfidence: 0,
      blockAfter: 0,
    });
    assertEqual(
      full.decision,
      "block",
      "the unfixed CRITICAL from last time still gates the merge",
    );
    assertIncludes(
      full.reasons.join(" "),
      "auth-token-logged",
      "and the reason names it",
    );
  });

  await test("the collate prompt says the carried findings are already counted", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildCollatePrompt({
      brief: {
        persona: "p",
        rules: [],
        focusAreas: [],
        sources: [],
        gaps: [],
      },
      plan: {
        changeSummary: "adds a token endpoint",
        riskAreas: [],
        tasks: [],
        checklistIds: [],
      },
      findings: [],
      workers: [],
      checklist: { complete: true, tasks: [], pending: [], unexplained: [] },
      carriedOver: await priorFindings(),
    });
    assertIncludes(
      prompt,
      "Still open from the previous review",
      "they are listed",
    );
    assertIncludes(prompt, "auth-token-logged", "by id");
    assertIncludes(
      prompt,
      "Do not repeat them",
      "so the run does not report them twice",
    );
  });

  await test("collate carries the open set into the ranked list and the ledger", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("carried", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const prior = await priorFindings();
      const carried = prior.filter(
        (finding) => finding.id === "auth-token-logged",
      );
      const own = prior.filter((finding) => finding.id === "duplicate-helper");

      // A session whose model reports only this run's own finding — the carried one has
      // to reach the verdict through the shell, or not at all.
      const seen: { prompt: string }[] = [];
      const session = {
        sessionId: "run-2",
        checkpoint: async (req: { prompt: string }) => {
          seen.push({ prompt: req.prompt });
          return {
            stage: "collate",
            data: { findings: own, merged: [], summary: "one small thing" },
            trusted: true,
            truncated: false,
            completedAt: new Date().toISOString(),
          };
        },
        metrics: () => [],
        toolResults: () => [],
      };

      const result = await mod.runCollate({
        session,
        paths,
        config: {
          yama: {
            verdict: {
              blockOn: ["CRITICAL"],
              commentOn: ["MAJOR"],
              minConfidence: 0,
              blockAfter: 0,
            },
          },
        },
        brief: {
          persona: "p",
          rules: [],
          focusAreas: [],
          sources: [],
          gaps: [],
        },
        plan: {
          changeSummary: "c",
          riskAreas: [],
          tasks: [],
          checklistIds: [],
        },
        findings: own,
        workers: [],
        checklist: { complete: true, tasks: [], pending: [], unexplained: [] },
        carriedOver: carried,
      });

      assertEqual(
        result.ranked.findings.map((finding: Finding) => finding.id).join(","),
        "auth-token-logged,duplicate-helper",
        "the carried finding is in the list, ranked with the rest",
      );
      assertEqual(
        result.verdict.decision,
        "block",
        "and it decides the verdict, which the model's own list would not have",
      );
      assertIncludes(
        seen[0].prompt,
        "Still open from the previous review",
        "the agent was told they are already counted",
      );

      const ledger = await mod.readLedger(paths);
      assertEqual(
        ledger.findings.map((finding: Finding) => finding.id).join(","),
        "auth-token-logged,duplicate-helper",
        "and the ledger is the full open set the next run inherits",
      );
    });
  });

  await test("a finding found again replaces the carried copy rather than doubling it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("carried", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const prior = await priorFindings();
      const carried = prior.filter(
        (finding) => finding.id === "auth-token-logged",
      );
      const refound = [
        {
          ...carried[0],
          summary: "still logging the refresh token, now at line 51",
        },
      ];

      const result = await mod.runCollate({
        session: {
          sessionId: "run-2",
          checkpoint: async () => ({
            stage: "collate",
            data: { findings: refound, merged: [], summary: "s" },
            trusted: true,
            truncated: false,
            completedAt: new Date().toISOString(),
          }),
          metrics: () => [],
          toolResults: () => [],
        },
        paths,
        config: {
          yama: {
            verdict: {
              blockOn: ["CRITICAL"],
              commentOn: ["MAJOR"],
              minConfidence: 0,
              blockAfter: 0,
            },
          },
        },
        brief: {
          persona: "p",
          rules: [],
          focusAreas: [],
          sources: [],
          gaps: [],
        },
        plan: {
          changeSummary: "c",
          riskAreas: [],
          tasks: [],
          checklistIds: [],
        },
        findings: refound,
        workers: [],
        checklist: { complete: true, tasks: [], pending: [], unexplained: [] },
        carriedOver: carried,
      });

      assertEqual(result.ranked.findings.length, 1, "one finding, not two");
      assertIncludes(
        result.ranked.findings[0].summary,
        "now at line 51",
        "and it is this run's version, which knows more",
      );
    });
  });

  section("description enhancement never rewrites the author (TASKS:Y7.3)");

  const block = async (sections: readonly string[]): Promise<string> => {
    const mod = await import(DIST_ENTRY);
    return mod.renderDescriptionBlock({
      sections,
      summary: "adds a token endpoint",
      riskAreas: ["auth"],
      findings: await priorFindings(),
      verdict: VERDICT,
      checklistComplete: false,
    });
  };

  await test("only the configured sections are rendered", async () => {
    const only = await block(["summary"]);
    assertIncludes(only, "What this change does", "the section asked for");
    assert(!only.includes("Where the risk is"), "and nothing else");

    const both = await block(["risk", "findings"]);
    assertIncludes(both, "Where the risk is", "risk");
    assertIncludes(both, "src/auth.ts:42", "findings, by where they are");
    assert(
      !both.includes("What this change does"),
      "a section not configured is not written",
    );
  });

  await test("an author's text is preserved to the byte, above and below", async () => {
    const mod = await import(DIST_ENTRY);
    const author = [
      "## Why",
      "",
      "We need a token endpoint for the mobile client.",
      "",
      "- [ ] deploy the migration first",
    ].join("\n");
    const first = mod.mergeDescription(author, await block(["summary"]));
    assertEqual(first.changed, true, "the block is added");
    assertIncludes(first.description, author, "the author's text is untouched");
    assert(
      mod.hasDescriptionBlock(first.description),
      "and the block is fenced",
    );

    // A second review, with the author having written more underneath.
    const edited = `${first.description}\n\n## Note from me\n\nStill draft.`;
    const second = mod.mergeDescription(
      edited,
      await block(["summary", "risk"]),
    );
    assertIncludes(second.description, author, "the text above survives");
    assertIncludes(
      second.description,
      "## Note from me",
      "and so does the text below",
    );
    assertIncludes(
      second.description,
      "Where the risk is",
      "the block updated",
    );
    assertEqual(
      second.description.split("yama:description:start").length - 1,
      1,
      "and there is still exactly one block",
    );
  });

  await test("an unchanged block is not offered for posting at all", async () => {
    const mod = await import(DIST_ENTRY);
    const rendered = await block(["summary"]);
    const once = mod.mergeDescription("Author text.", rendered);
    const twice = mod.mergeDescription(once.description, rendered);
    assertEqual(
      twice.changed,
      false,
      "running the review twice is not two edits to the description",
    );
  });

  await test("a description that could not be read is a description not set", async () => {
    const mod = await import(DIST_ENTRY);
    const unmapped = await mod.readTargetDescription({
      engine: { callTool: async () => ({}) },
      registry: await registryFor({ "pr.describe": "set_body" }),
    });
    assertEqual(unmapped.description, undefined, "nothing was read");
    assertIncludes(
      String(unmapped.problem),
      "pr.read",
      "and it names what is missing",
    );

    // The dangerous case: the capability IS there, and the tool answered with something
    // this reader does not recognise. An empty string would read as "no description" and
    // wipe the author out; it has to read as "not read".
    const read = await mod.readTargetDescription({
      engine: { callTool: async () => ({ unexpected: "shape" }) },
      registry: await registryFor({
        "pr.read": "read_pr",
        "pr.describe": "set_body",
      }),
    });
    assertEqual(
      read.description,
      undefined,
      "an unreadable answer is not an empty description",
    );
    assertIncludes(
      String(read.problem),
      "left alone",
      "and it says the author's text was not touched",
    );

    const failed = await mod.readTargetDescription({
      engine: {
        callTool: async () => {
          throw new Error("the forge is down");
        },
      },
      registry: await registryFor({
        "pr.read": "read_pr",
        "pr.describe": "set_body",
      }),
    });
    assertEqual(failed.description, undefined, "nor is a failed call");
    assertIncludes(String(failed.problem), "the forge is down", "verbatim");

    const plan = mod.buildDeliveryPlan({
      config: {
        yama: {
          delivery: {
            inlineComments: false,
            summaryComment: false,
            verdict: false,
            describe: true,
            maxInlineComments: 5,
            minSeverity: "MINOR",
            describeSections: ["summary"],
          },
        },
      },
      actions: ["describe"],
      runId: "run-1",
      ranked: { findings: [] },
      verdict: VERDICT,
      summary: "s",
      comments: [],
      checklistComplete: true,
    });
    assertEqual(
      plan.description,
      undefined,
      "so the author's description is left exactly as it is",
    );
  });

  await test("the delivery prompt hands over the whole body, verbatim", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = await registryFor(
      { "pr.read": "read_pr", "pr.describe": "set_body" },
      { "pr.describe": { pull: "7" } },
    );
    const plan = mod.buildDeliveryPlan({
      config: {
        yama: {
          delivery: {
            inlineComments: false,
            summaryComment: false,
            verdict: false,
            describe: true,
            maxInlineComments: 5,
            minSeverity: "MINOR",
            describeSections: ["summary", "risk"],
          },
        },
      },
      actions: ["describe"],
      runId: "run-1",
      ranked: { findings: await priorFindings() },
      verdict: VERDICT,
      summary: "collated summary",
      changeSummary: "adds a token endpoint",
      riskAreas: ["auth", "logging"],
      comments: [],
      checklistComplete: true,
      currentDescription: "## Why\n\nMobile needs it.",
    });
    assertIncludes(String(plan.description), "Mobile needs it.", "author kept");
    assertIncludes(
      String(plan.description),
      "adds a token endpoint",
      "the review's own reading of the change, not the collate summary",
    );

    const prompt = mod.buildDeliveryPrompt({ plan, registry: reg });
    assertIncludes(prompt, "set_body", "the resolved tool");
    assertIncludes(prompt, '{"pull":"7"}', "and its coordinates");
    assertIncludes(prompt, "VERBATIM", "the body is not the agent's to edit");
    assertIncludes(prompt, "Mobile needs it.", "the whole body is handed over");
    assert(
      !prompt.includes("github") && !prompt.includes("bitbucket"),
      "no forge is named anywhere in it",
    );
  });

  section("negative config fixtures (TASKS:Y8.1)");

  await test("an unequal-length model chain names both lengths", async () => {
    const mod = await import(DIST_ENTRY);
    let message = "";
    try {
      await mod.loadConfig(path.join(BAD_CONFIG, "unequal-chain"), {
        mode: "local",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(message, "main", "the role that is wrong");
    assertIncludes(message, "2", "the provider count");
    assertIncludes(message, "3", "the model count");
  });

  await test("an unknown capability lists the ones Yama knows", async () => {
    const mod = await import(DIST_ENTRY);
    let message = "";
    let hint = "";
    try {
      await mod.loadConfig(path.join(BAD_CONFIG, "unknown-capability"), {
        mode: "local",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      hint = String((error as { hint?: string }).hint ?? "");
    }
    assertIncludes(message, "comment.inline.post", "the id that is wrong");
    assertIncludes(hint, "comment.inline.create", "and the one that is right");
  });

  await test("broken YAML names the file it could not parse", async () => {
    const mod = await import(DIST_ENTRY);
    let message = "";
    try {
      await mod.loadConfig(path.join(BAD_CONFIG, "broken-yaml"), {
        mode: "local",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(message, "yama.yaml", "the file");
    assertIncludes(message, "not valid YAML", "and what is wrong with it");
  });

  section("the synthetic pull request drives a recurring run end to end");

  await test("a store from a previous run makes the next one recurring", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("synthetic", async (dir) => {
      const paths = mod.storePathsForDir(path.join(dir, "pr-7"));
      await mod.ensureStore(paths);
      await mod.writeRunReport(paths, await readFixture("prior-run.json"));
      await mod.writeLedger(paths, await readFixture("prior-findings.json"));

      const state = await mod.detectRecurrence(paths, "run-2");
      assertEqual(state.kind, "recurring", "the store says so");
      assertEqual(
        state.lastReviewedSha,
        "0".repeat(40),
        "and carries the sha to measure from",
      );
      assertEqual(
        state.priorFindings.length,
        3,
        "the findings themselves, not just their ids",
      );
      assertEqual(
        state.priorFindingIds.join(","),
        "auth-token-logged,weak-hash,duplicate-helper",
        "in ledger order",
      );

      const seen = mod.withReportedMarkers(state, {
        reported: [{ findingId: "auth-token-logged", commentId: "8801" }],
      });
      assertEqual(
        seen.source,
        "run-report",
        "the store's answer is not overwritten by the markers",
      );
      assertEqual(seen.previouslyReported.length, 1, "but both are carried");
    });
  });

  await test("the ledger becomes what is OPEN, so a fix does not haunt every later run", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("synthetic", async (dir) => {
      await mkdir(path.join(dir, "pr-7"), { recursive: true });
      const paths = mod.storePathsForDir(path.join(dir, "pr-7"));
      await mod.ensureStore(paths);
      await mod.writeLedger(paths, await readFixture("prior-findings.json"));

      const prior = await priorFindings();
      const classified = mod.classifyPriorFindings({
        prior,
        reviewed: [
          { id: "auth-token-logged", state: "fixed", reason: "redacted now" },
          { id: "weak-hash", state: "open", reason: "unchanged" },
          {
            id: "duplicate-helper",
            state: "moot",
            reason: "not in this change",
          },
        ],
      });
      // What collate writes back: the full open set, ranked.
      await mod.writeLedger(paths, {
        updatedAt: new Date().toISOString(),
        findings: mod.rankFindings(classified.open),
      });

      const ledger = await mod.readLedger(paths);
      assertEqual(
        ledger.findings.map((finding: Finding) => finding.id).join(","),
        "weak-hash",
        "a fixed finding leaves the ledger; the still-open one stays",
      );
    });
  });

  await test("a run report round-trips its recurrence block and its target base", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("synthetic", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const stats = mod.recurrenceStats({
        recurrence: {
          kind: "recurring",
          source: "run-report",
          lastReviewedSha: "0".repeat(40),
          priorFindings: await priorFindings(),
          priorFindingIds: [],
          previouslyReported: [
            { findingId: "auth-token-logged", commentId: "8801" },
          ],
        },
        prior: mod.classifyPriorFindings({
          prior: await priorFindings(),
          reviewed: [
            { id: "auth-token-logged", state: "fixed", reason: "redacted" },
          ],
        }),
        incremental: { files: [{ path: "src/tokens.ts" }] },
      });
      await mod.writeRunReport(paths, {
        runId: "run-2",
        mode: "pr",
        target: { mode: "pr", pr: 7, base: "main" },
        startedAt: new Date().toISOString(),
        stages: [],
        tasks: [],
        degradations: [],
        recurrence: stats,
      });

      const back = await mod.readRunReport(paths);
      assertEqual(
        back.target.base,
        "main",
        "the base ref survives the round trip",
      );
      assertEqual(
        back.recurrence.fixed.join(","),
        "auth-token-logged",
        "and so does what the recurrence gate decided",
      );
      assertEqual(
        back.recurrence.unresolved.join(","),
        "weak-hash,duplicate-helper",
        "including what was never accounted for",
      );
      assertEqual(
        back.recurrence.incrementalFiles,
        1,
        "and the incremental size",
      );

      const summary = mod.renderRunSummary(back, dir);
      assertIncludes(
        summary,
        "recurrence",
        "the summary has a recurrence block",
      );
      assertIncludes(summary, "UNRESOLVED", "and is loud about the gap");
    });
  });

  section(
    "the wiring: runReview actually drives a re-review as one (TASKS:Y7.1)",
  );

  /**
   * Everything above proves the recurrence PARTS. What is proved here is that `runReview`
   * calls them, in the order that makes them true: the store is read before this run's
   * report overwrites it, the markers are folded in, the incremental diff is measured
   * from the sha the last run banked, and the open set reaches the verdict.
   *
   * None of that is visible from a fresh run, and until now every end-to-end run was one.
   */
  const RECURRING_YAMA = [
    "models:",
    "  main:",
    "    provider: google-ai",
    "    model: gemini-2.5-flash",
    "",
  ].join("\n");

  const RECURRING_MCP = [
    "servers:",
    "  forge:",
    "    transport: stdio",
    "    command: node",
    '    args: ["-e", "0"]',
    "capabilities:",
    "  comment.list:",
    "    tool: forge.list_comments",
    "    args:",
    '      pull: "${pr}"',
    "",
  ].join("\n");

  /**
   * A repository whose pull request has been reviewed once already: `main` is the base,
   * `feature` carries two commits, and the FIRST of them is the commit the previous review
   * looked at — so `lastReviewedSha..HEAD` is a real one-file range, not a fixture string.
   */
  const reviewedOnceWorkspace = async (dir: string): Promise<string> => {
    await gitWorkspace(dir, { yamaYaml: RECURRING_YAMA });
    const git = (args: string[]): Promise<{ stdout: string }> =>
      runCommand("git", args, { cwd: dir });
    await git(["checkout", "-q", "--", "."]);
    await writeFile(path.join(dir, ".yama", "mcp.yaml"), RECURRING_MCP, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "the state being reviewed against"]);
    await git(["checkout", "-q", "-b", "feature"]);
    await writeFile(
      path.join(dir, "token.ts"),
      "export const t = 1;\n",
      "utf8",
    );
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "what the previous review saw"]);
    const sha = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await writeFile(
      path.join(dir, "later.ts"),
      "export const l = 1;\n",
      "utf8",
    );
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "what has landed since"]);
    return sha;
  };

  /** Seeds the run store with what the previous review of this target left behind. */
  const seedPreviousRun = async (
    storeDir: string,
    headSha: string,
  ): Promise<void> => {
    const mod = await import(DIST_ENTRY);
    const paths = mod.storePathsForDir(storeDir);
    await mod.ensureStore(paths);
    const prior = (await readFixture("prior-run.json")) as Record<
      string,
      unknown
    >;
    await mod.writeRunReport(paths, { ...prior, headSha });
    await mod.writeLedger(paths, await readFixture("prior-findings.json"));
  };

  /**
   * A scripted model for a whole `runReview`, recording the first prompt each stage got.
   * The agent deliberately reports NOTHING of its own and accounts for only one of the
   * three prior findings: everything the run then decides has to have come from the shell.
   */
  const recurringEngine = async (
    options: { comments?: unknown; accounted?: boolean } = {},
  ): Promise<{
    prompts: Map<string, string>;
    engine: Record<string, unknown>;
  }> => {
    const comments = options.comments ?? (await readFixture("comments.json"));
    const prompts = new Map<string, string>();
    const stageOf = (prompt: string): string =>
      prompt.includes("WARM UP.")
        ? "warmup"
        : prompt.includes("TASK INSERTION.")
          ? "taskInsertion"
          : prompt.includes("COLLATE AND DECIDE")
            ? "collate"
            : prompt.includes("DELIVERY.")
              ? "delivery"
              : "work";
    const answers: Record<string, unknown> = {
      warmup: {
        persona: "sceptical about auth",
        rules: [],
        focusAreas: ["security"],
        sources: [".yama/rulebook/index.md"],
        gaps: [],
      },
      taskInsertion: {
        changeSummary: "adds a token helper",
        riskAreas: ["auth"],
        tasks: [
          {
            title: "check the token helper",
            rationale: "the diff adds one",
            scope: ["token.ts"],
            delegate: false,
          },
        ],
        checklistIds: ["t1"],
        ...(options.accounted === false
          ? {}
          : {
              priorFindings: [
                {
                  id: "weak-hash",
                  state: "open",
                  reason: "src/tokens.ts:17 is unchanged",
                },
              ],
            }),
      },
      work: { findings: [], worked: [], openQuestions: [] },
      collate: { findings: [], merged: [], summary: "nothing new this time" },
    };

    return {
      prompts,
      engine: {
        generateStructured: async (req: {
          prompt: string;
          schema: {
            safeParse: (value: unknown) => { success: boolean; data?: unknown };
          };
        }) => {
          const stage = stageOf(req.prompt);
          if (!prompts.has(stage)) {
            prompts.set(stage, req.prompt);
          }
          const answer = answers[stage];
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
              stepsUsed: 1,
              toolsUsed: [],
            },
          };
        },
        registerTool: () => undefined,
        connectMcp: async () => ["list_comments"],
        callTool: async () => comments,
        tasksApi: async (sessionId: string) => ({
          sessionId,
          tasks: [
            { id: "t1", title: "check the token helper", status: "done" },
          ],
        }),
        delegate: async () => ({ workerId: "none" }),
        collect: async () => [],
        bankReport: async (req: { label: string; payload: string }) => ({
          id: `banked-${req.label}`,
          label: req.label,
          sizeBytes: req.payload.length,
          preview: req.payload.slice(0, 200),
          readBackHint: `retrieve_context({ artifactId: "banked-${req.label}" })`,
        }),
        backgroundRun: async () => {
          throw new Error("this case runs no commands");
        },
      },
    };
  };

  await test("the previous run's findings, sha and comments all reach the stages", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("recurring-run", async (dir) => {
      const lastReviewedSha = await reviewedOnceWorkspace(dir);
      const storeDir = path.join(dir, ".yama", "artifacts", "pr-7");
      await seedPreviousRun(storeDir, lastReviewedSha);
      const scripted = await recurringEngine();

      const result = await mod.runReview(
        {
          runId: "run-2",
          target: { mode: "pr", pr: 7, base: "main" },
          root: dir,
          storeDir,
          dryRun: false,
        },
        scripted.engine,
      );

      const insertion = scripted.prompts.get("taskInsertion") ?? "";
      assertIncludes(
        insertion,
        "has been reviewed before",
        "the store is read BEFORE this run's report overwrites it",
      );
      assertIncludes(
        insertion,
        lastReviewedSha,
        "and it carries the sha that review looked at",
      );
      for (const id of ["auth-token-logged", "weak-hash", "duplicate-helper"]) {
        assertIncludes(
          insertion,
          id,
          "every finding the last review left open has to be accounted for",
        );
      }
      assertIncludes(
        insertion,
        "later.ts",
        "the incremental patch is measured from that sha, not from the base",
      );
      assertIncludes(
        insertion,
        "Already commented on this target",
        "and the preflight marker scan reached the stage that needs it",
      );

      assertIncludes(
        scripted.prompts.get("collate") ?? "",
        "Still open from the previous review",
        "collate is told what is already counted",
      );
      assertEqual(
        result.ranked.findings
          .map((f: { id: string }) => f.id)
          .sort()
          .join(","),
        "auth-token-logged,duplicate-helper,weak-hash",
        "this run reported nothing, so the whole list is inherited",
      );
      assertEqual(
        result.verdict.decision,
        "block",
        "and the CRITICAL nobody fixed still gates the merge",
      );

      const report = await mod.readRunReport(mod.storePathsForDir(storeDir));
      assertEqual(
        report.recurrence.kind,
        "recurring",
        "the run report says which kind of run this was",
      );
      assertEqual(
        report.recurrence.unresolved.sort().join(","),
        "auth-token-logged,duplicate-helper",
        "and names what the agent never accounted for",
      );
      assertEqual(
        report.recurrence.incrementalFiles,
        1,
        "one file has moved since the last review",
      );
    });
  });

  await test("markers alone make it a re-review when CI lost the store", async () => {
    const mod = await import(DIST_ENTRY);
    const runWith = async (comments: unknown): Promise<string> => {
      let insertion = "";
      await withTempDir("recurring-markers", async (dir) => {
        await reviewedOnceWorkspace(dir);
        const scripted = await recurringEngine({ comments });
        await mod.runReview(
          {
            runId: "run-2",
            target: { mode: "pr", pr: 7, base: "main" },
            root: dir,
            // Nothing seeded: the artifact CI should have carried is gone.
            storeDir: path.join(dir, ".yama", "artifacts", "pr-7"),
            dryRun: false,
          },
          scripted.engine,
        );
        insertion = scripted.prompts.get("taskInsertion") ?? "";
      });
      return insertion;
    };

    const seen = await runWith(await readFixture("comments.json"));
    assertIncludes(
      seen,
      "has been reviewed before",
      "the comments on the target say so even with no store at all",
    );
    assertIncludes(
      seen,
      "auth-token-logged",
      "and name what has already been said",
    );

    // The mirror, so the assertion above cannot pass by every run being recurring.
    const unseen = await runWith({
      values: [{ id: 1, body: "looks good to me" }],
    });
    assertIncludes(
      unseen,
      "first review of this target",
      "a target carrying no marker of ours is a fresh review",
    );
  });

  await test("Delivery reads the description itself and enhances it in place", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = await registryFor(
      {
        "comment.list": "list_comments",
        "pr.read": "read_pr",
        "pr.describe": "set_body",
      },
      { "pr.read": { pull: "7" }, "pr.describe": { pull: "7" } },
    );
    const config = {
      yama: {
        delivery: {
          inlineComments: false,
          summaryComment: false,
          verdict: false,
          describe: true,
          maxInlineComments: 5,
          minSeverity: "MINOR",
          describeSections: ["summary", "risk"],
        },
      },
    };
    const AUTHOR = "## Why\n\nMobile needs a token endpoint.";

    const deliver = async (prRead: unknown) => {
      const seen: { prompt: string }[] = [];
      const calls: string[] = [];
      const result = await mod.runDelivery({
        session: {
          sessionId: "run-1",
          checkpoint: async (req: { prompt: string }) => {
            seen.push({ prompt: req.prompt });
            return {
              stage: "delivery",
              data: {
                posted: [],
                failed: [],
                summaryPosted: false,
                verdictSet: false,
                described: true,
                notes: "set the body",
              },
              trusted: true,
              completedAt: new Date().toISOString(),
            };
          },
          metrics: () => [],
          toolResults: () => [],
        },
        engine: {
          callTool: async (name: string) => {
            calls.push(name);
            return name === "read_pr" ? prRead : [];
          },
        },
        config,
        registry: reg,
        actions: ["describe"],
        runId: "run-1",
        ranked: { findings: await priorFindings() },
        verdict: VERDICT,
        summary: "collated summary",
        changeSummary: "adds a token endpoint",
        riskAreas: ["auth"],
        checklistComplete: true,
        dryRun: false,
      });
      return { result, seen, calls };
    };

    const ok = await deliver({ body: AUTHOR });
    assert(
      ok.calls.includes("read_pr"),
      "the shell reads the description itself before anything is written",
    );
    assertIncludes(
      String(ok.result.plan.description),
      AUTHOR,
      "the author's own text is carried through untouched",
    );
    assertIncludes(
      String(ok.result.plan.description),
      "adds a token endpoint",
      "with this review's sections inside Yama's block",
    );
    assertIncludes(
      ok.seen[0].prompt,
      "set_body",
      "and the agent is asked to set it with the tool config named",
    );

    // The mirror: a description that could not be read must not become an empty one.
    const blind = await deliver({ nothing: "recognisable" });
    assertEqual(
      blind.result.plan.description,
      undefined,
      "an unreadable description is never set",
    );
    assertIncludes(
      String(blind.result.failure),
      "left alone",
      "and the run says out loud that the author was not touched",
    );
  });
}
