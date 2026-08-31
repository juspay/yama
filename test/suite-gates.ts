/**
 * Suite: the gates, the markers module, the verdict policy and the config blocks that
 * drive them (TASKS:Y4.1-Y4.5, Y5.3, Y5.5, Y1.1).
 *
 * All of this is deterministic — that is the point of a gate — so nothing here skips and
 * nothing here needs a provider. The one agentic surface, a stage checkpoint, is driven
 * through the REAL session runner with a scripted engine, so the retry path exercises the
 * same banking and validation code a live run would.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  DIST_ENTRY,
  FIXTURES,
  REPO_ROOT,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  isBuilt,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("gates");

type RawShape = {
  content: string;
  structured: unknown;
  repaired: boolean;
  truncated: boolean;
  provider?: string;
  model?: string;
  /** What the attempt spent. The gate reads this to tell "ran out" from "answered badly". */
  stepsUsed?: number;
  toolsUsed?: string[];
  toolResults?: {
    name: string;
    params?: unknown;
    result?: unknown;
    isError?: boolean;
    truncated?: boolean;
  }[];
};

type Reply = { data: unknown; trusted: boolean; raw: RawShape };

const reply = (data: unknown, overrides: Partial<RawShape> = {}): Reply => ({
  data,
  trusted: overrides.truncated !== true && overrides.repaired !== true,
  raw: {
    content: JSON.stringify(data ?? null),
    structured: data ?? null,
    repaired: false,
    truncated: false,
    provider: "test-provider",
    model: "test-model",
    ...overrides,
  },
});

/** An engine that answers with a scripted list, recording what it was asked. */
const scriptedEngine = (replies: Reply[]) => {
  const prompts: string[] = [];
  /** Every call as the gate made it — the toolset and the budget, not just the words. */
  const calls: { prompt: string; tools?: string[]; maxSteps?: number }[] = [];
  let index = 0;
  return {
    prompts,
    calls,
    engine: {
      generateStructured: async (req: {
        prompt: string;
        tools?: string[];
        maxSteps?: number;
      }) => {
        prompts.push(req.prompt);
        calls.push({
          prompt: req.prompt,
          ...(req.tools !== undefined ? { tools: req.tools } : {}),
          ...(req.maxSteps !== undefined ? { maxSteps: req.maxSteps } : {}),
        });
        const next = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return next;
      },
      registerTool: () => undefined,
    },
  };
};

/** A finding, with only the fields a gate or the policy actually reads spelled out. */
const finding = (
  id: string,
  severity: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  file: "src/auth.ts",
  line: 42,
  severity,
  category: "security",
  summary: `${id} summary`,
  impact: "something breaks",
  evidence: [],
  ...extra,
});

/** A `.yama/` that a PR-mode load accepts, with whatever capability map the case needs. */
const configWorkspace = async (
  dir: string,
  options: { capabilities: string; delivery?: string },
): Promise<void> => {
  await mkdir(path.join(dir, ".yama"), { recursive: true });
  await writeFile(
    path.join(dir, ".yama", "yama.yaml"),
    [
      "models:",
      "  main:",
      "    provider: google-ai",
      "    model: gemini-2.5-flash",
      options.delivery ?? "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(dir, ".yama", "mcp.yaml"),
    [
      "servers:",
      "  gh:",
      "    transport: stdio",
      "    command: gh-mcp",
      options.capabilities,
    ].join("\n"),
    "utf8",
  );
};

const PR_CAPABILITIES = [
  "capabilities:",
  "  pr.read: gh.get_pr",
  "  pr.diff: gh.get_diff",
  "  comment.list: gh.list_comments",
  "  comment.inline.create: gh.create_review_comment",
].join("\n");

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  const mod = await import(DIST_ENTRY);
  const Payload = z.object({ ok: z.boolean() });

  const sessionOver = async (dir: string, replies: Reply[]) => {
    const paths = mod.storePathsForDir(dir);
    await mod.ensureStore(paths);
    const scripted = scriptedEngine(replies);
    return {
      ...scripted,
      session: mod.createSessionRunner({
        engine: scripted.engine,
        paths,
        sessionId: "run-gate",
      }),
    };
  };

  section("Y4.1 — the schema gate retries once, and never accepts a partial");

  await test("a first attempt that came back complete is not retried", async () => {
    await withTempDir("gate-schema", async (dir) => {
      const { session, prompts } = await sessionOver(dir, [
        reply({ ok: true }),
      ]);
      const out = await mod.checkpointWithSchemaGate({
        session,
        request: { stage: "warmup", prompt: "the task", schema: Payload },
      });
      assertEqual(out.data.ok, true, "the payload comes back");
      assertEqual(prompts.length, 1, "one attempt for a clean answer");
    });
  });

  await test("salvaged-but-cut-short JSON is refused and retried, and the retry says why", async () => {
    await withTempDir("gate-schema", async (dir) => {
      const { session, prompts } = await sessionOver(dir, [
        reply({ ok: true }, { truncated: true }),
        reply({ ok: true }),
      ]);
      const out = await mod.checkpointWithSchemaGate({
        session,
        request: { stage: "warmup", prompt: "the task", schema: Payload },
      });
      assertEqual(out.truncated, false, "the accepted envelope is complete");
      assertEqual(prompts.length, 2, "exactly one retry");
      assertIncludes(prompts[1], "cut short", "the retry names the failure");
      assertIncludes(
        prompts[1],
        "the task",
        "the retry repeats the task verbatim",
      );
    });
  });

  await test("repaired but complete JSON is accepted — nothing was lost", async () => {
    await withTempDir("gate-schema", async (dir) => {
      const { session, prompts } = await sessionOver(dir, [
        reply({ ok: true }, { repaired: true }),
      ]);
      const out = await mod.checkpointWithSchemaGate({
        session,
        request: { stage: "warmup", prompt: "the task", schema: Payload },
      });
      assertEqual(out.trusted, false, "the envelope is recorded as untrusted");
      assertEqual(prompts.length, 1, "a repair alone is not a retry");
    });
  });

  await test("a stage that fails twice throws, naming the banked evidence", async () => {
    await withTempDir("gate-schema", async (dir) => {
      const { session, prompts } = await sessionOver(dir, [
        reply(undefined, { truncated: true }),
      ]);
      let message = "";
      try {
        await mod.checkpointWithSchemaGate({
          session,
          request: { stage: "warmup", prompt: "the task", schema: Payload },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertEqual(
        prompts.length,
        3,
        "the retry AND the closing ask were spent before giving up",
      );
      assertIncludes(
        prompts[2] ?? "",
        "STOP INVESTIGATING NOW",
        "the last ask is the closing one — finish, do not keep looking",
      );
      assertIncludes(
        message,
        "closing ask",
        "the failure says the closing ask ran",
      );
      assertIncludes(message, "banked output", "the failure names the file");
      const banked = session.metrics().at(-1)?.rawPath ?? "";
      assertIncludes(
        await readFile(banked, "utf8"),
        "## structured",
        "both attempts are on disk",
      );
    });
  });

  await test("a stage that ran out of steps is closed out, not asked the same thing again", async () => {
    // Measured on yama PR #101: Task Insertion spent all 32 of its steps reading, produced
    // no JSON, and the gate re-ran the WHOLE original prompt — which spent 32 more steps
    // reading the same files. A budget that ran out means the stage was working, so the
    // only useful next question is "finish", not "start again".
    await withTempDir("gate-exhausted", async (dir) => {
      const { session, calls } = await sessionOver(dir, [
        reply(undefined, {
          stepsUsed: 32,
          toolResults: [
            { name: "read_file", params: { path: "src/core/index.ts" } },
            { name: "retrieve_context", params: { artifactId: "16e63c17" } },
          ],
        }),
        reply({ ok: true }),
      ]);
      const out = await mod.checkpointWithSchemaGate({
        session,
        request: {
          stage: "taskInsertion",
          prompt: "the task",
          schema: Payload,
          tools: ["read_file", "list_files", "tasks_create"],
          maxSteps: 32,
        },
        recovery: {
          tools: ["tasks_create"],
          context: "THE CHANGE UNDER REVIEW",
        },
      });

      assertEqual(calls.length, 2, "no second full attempt was spent");
      const closing = calls[1];
      assertIncludes(
        closing?.prompt ?? "",
        "used all 32 of its steps",
        "the closing ask names what actually went wrong",
      );
      assertIncludes(
        closing?.prompt ?? "",
        "read_file path=src/core/index.ts",
        "and carries what the cut-off attempt already did",
      );
      assertIncludes(
        closing?.prompt ?? "",
        "THE CHANGE UNDER REVIEW",
        "with the run's ground truth restated",
      );
      assertEqual(
        closing?.tools?.join(","),
        "tasks_create",
        "exploring tools are dropped and the EFFECTING one is kept — a closing ask that cannot create the checklist can only produce a lie",
      );
      assertEqual(out.recovered, true, "the envelope says it was rescued");
      assertEqual(
        out.trusted,
        false,
        "and a rescued answer is never trusted, however well-formed it is",
      );
      assertEqual(
        session.metrics().at(-1)?.recovered,
        true,
        "the run report carries the difference too",
      );
      // And so does the artifact a human opens after a failure. Printing the engine's
      // own verdict here said `trusted: true` over an answer the run had to rescue.
      const banked = await readFile(
        session.metrics().at(-1)?.rawPath ?? "",
        "utf8",
      );
      assertIncludes(banked, "RECOVERY ASK", "the evidence names what it is");
      assertIncludes(
        banked,
        "trusted: false",
        "and never calls a rescued answer trusted",
      );
    });
  });

  await test("a closing ask with nothing to record holds no tools at all", async () => {
    await withTempDir("gate-closing", async (dir) => {
      const { session, calls } = await sessionOver(dir, [
        reply(undefined, { stepsUsed: 8 }),
        reply(undefined, { stepsUsed: 8 }),
        reply({ ok: true }),
      ]);
      await mod.checkpointWithSchemaGate({
        session,
        request: {
          stage: "collate",
          prompt: "the task",
          schema: Payload,
          tools: ["read_file"],
          maxSteps: 32,
        },
      });
      assertEqual(
        calls[2]?.tools?.join(","),
        "__closing_no_tools__",
        "no effecting tools means no tools — an include-list that matches nothing",
      );
    });
  });

  await test("the stages that ship go through the gate: WarmUp retries a cut-short brief", async () => {
    await withTempDir("gate-stage", async (dir) => {
      await configWorkspace(dir, { capabilities: "capabilities: {}" });
      const config = await mod.loadConfig(dir, { mode: "local" });
      const brief = {
        persona: "sceptical about auth",
        rules: [],
        focusAreas: [],
        sources: [".yama/rulebook/index.md"],
        gaps: [],
      };
      const { session, prompts } = await sessionOver(path.join(dir, "store"), [
        reply(brief, { truncated: true }),
        reply(brief),
      ]);
      const out = await mod.runWarmUp({ session, config });
      assertEqual(prompts.length, 2, "the stage retried through the gate");
      assertEqual(
        out.data.persona,
        "sceptical about auth",
        "and the brief still came back",
      );
    });
  });

  section("Y4.2 — checklist completeness");

  const state = (tasks: unknown[]) => ({ sessionId: "run-gate", tasks });

  await test("pending and in_progress items are an incomplete review", async () => {
    const result = mod.checkChecklist(
      state([
        { id: "t1", title: "auth rules", status: "done" },
        { id: "t2", title: "migrations", status: "pending" },
        { id: "t3", title: "tests", status: "in_progress" },
      ]),
    );
    assertEqual(result.complete, false, "unfinished work is incomplete");
    assertEqual(
      result.pending.map((t: { id: string }) => t.id).join(","),
      "t2,t3",
      "both unfinished states count",
    );
  });

  await test("closing an item without a reason is also incomplete", async () => {
    const result = mod.checkChecklist(
      state([
        { id: "t1", title: "auth rules", status: "closed" },
        { id: "t2", title: "tests", status: "closed", note: "no tests exist" },
      ]),
    );
    assertEqual(result.complete, false, "a silent close is not a close");
    assertEqual(
      result.unexplained.map((t: { id: string }) => t.id).join(","),
      "t1",
      "only the unexplained one is flagged",
    );
    assertIncludes(
      mod.buildChecklistNudge(result),
      "t1",
      "the nudge names the item to explain",
    );
  });

  await test("everything done or closed-with-a-reason is complete", async () => {
    const result = mod.checkChecklist(
      state([
        { id: "t1", title: "auth rules", status: "done" },
        { id: "t2", title: "perf", status: "closed", note: "out of scope" },
      ]),
    );
    assertEqual(result.complete, true, "a finished checklist passes");
  });

  await test("the gate hands unfinished work back to the agent, then re-reads it", async () => {
    const tasks = [
      { id: "t1", title: "auth rules", status: "pending" },
      { id: "t2", title: "tests", status: "done" },
    ];
    const nudges: string[] = [];
    const engine = {
      tasksApi: async (sessionId: string) => ({ sessionId, tasks }),
    };
    const result = await mod.enforceChecklist({
      engine,
      sessionId: "run-gate",
      nudge: async (prompt: string) => {
        nudges.push(prompt);
        tasks[0] = { ...tasks[0], status: "done" };
      },
    });
    assertEqual(nudges.length, 1, "one round was enough");
    assertEqual(result.complete, true, "the re-read sees the finished item");
    assertIncludes(nudges[0], "t1", "the nudge names the open item");
    assertIncludes(
      nudges[0],
      "tasks_update",
      "the nudge says how to finish or close it",
    );
  });

  await test("an agent that ignores the nudge yields an incomplete report, not a hang", async () => {
    const engine = {
      tasksApi: async (sessionId: string) => ({
        sessionId,
        tasks: [{ id: "t1", title: "auth rules", status: "pending" }],
      }),
    };
    let rounds = 0;
    const result = await mod.enforceChecklist({
      engine,
      sessionId: "run-gate",
      maxRounds: 3,
      nudge: async () => {
        rounds += 1;
      },
    });
    assertEqual(rounds, 3, "the gate stops at maxRounds");
    assertEqual(result.complete, false, "and reports the checklist unfinished");
  });

  section("Y5.3 — markers and the findings ledger");

  await test("a marker round-trips, and marking twice does not double-mark", async () => {
    const body = mod.withFindingMarker("auth-token-log", "Never log a token.");
    assertIncludes(body, "<!-- yama:finding:auth-token-log -->", "the marker");
    assertIncludes(body, "`yama:finding:auth-token-log`", "the visible token");
    assertEqual(
      mod.scanMarkers(body).join(","),
      "auth-token-log",
      "the id is scannable, once, from both forms",
    );
    assertEqual(
      // The forge-side strip is simulated by removing the exact HTML marker —
      // no sanitizing regex here, the test only needs that ONE comment gone.
      mod
        .scanMarkers(body.split(mod.findingMarker("auth-token-log")).join(""))
        .join(","),
      "auth-token-log",
      "the id survives a forge that strips HTML comments from bodies",
    );
    assertEqual(
      mod.withFindingMarker("auth-token-log", body),
      body,
      "marking an already-marked body is a no-op",
    );
  });

  await test("scanning reads every marker in a comment thread, once each", async () => {
    const text = [
      "<!-- yama:finding:f1 -->",
      "some prose",
      "<!--yama:finding:f2-->",
      "<!-- yama:finding:f1 -->",
    ].join("\n");
    assertEqual(
      mod.scanMarkers(text).join(","),
      "f1,f2",
      "ids in order, deduped",
    );
    assertEqual(mod.scanMarkers("no markers here").length, 0, "no false hits");
  });

  await test("the ledger replaces a finding by id and appends the new ones", async () => {
    await withTempDir("gate-ledger", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      await mod.recordFindings(paths, [
        finding("f1", "MINOR"),
        finding("f2", "MAJOR"),
      ]);
      const ledger = await mod.recordFindings(paths, [
        finding("f2", "CRITICAL"),
        finding("f3", "INFO"),
      ]);
      assertEqual(
        ledger.findings.map((f: { id: string }) => f.id).join(","),
        "f1,f2,f3",
        "order is stable and nothing is lost",
      );
      assertEqual(
        ledger.findings[1].severity,
        "CRITICAL",
        "the newer run's version of f2 wins",
      );
      const onDisk = await mod.readLedger(paths);
      assertEqual(onDisk.findings.length, 3, "the ledger is on disk");
    });
  });

  section("Y4.3 — marker dedup before posting");

  await test("a finding already carrying a marker on the target is not re-posted", async () => {
    const result = mod.dedupePostedFindings({
      findings: [finding("f1", "MAJOR"), finding("f2", "MINOR")],
      comments: [
        { id: "c9", body: `old news\n${mod.findingMarker("f1")}` },
        { id: "c10", body: `someone else's comment` },
      ],
    });
    assertEqual(
      result.post.map((f: { id: string }) => f.id).join(","),
      "f2",
      "only the new finding is posted",
    );
    assertEqual(
      result.alreadyPosted[0].commentId,
      "c9",
      "bound to its comment",
    );
    assertEqual(result.alreadyPosted[0].findingId, "f1", "and to its finding");
  });

  await test("two workers reporting the same finding post it once", async () => {
    const result = mod.dedupePostedFindings({
      findings: [finding("f1", "MAJOR"), finding("f1", "MAJOR")],
      comments: [],
    });
    assertEqual(result.post.length, 1, "the duplicate collapses");
  });

  await test("markers with no finding this run are reported as stale, not dropped", async () => {
    const result = mod.dedupePostedFindings({
      findings: [finding("f1", "MAJOR")],
      comments: [{ id: "c1", body: mod.findingMarker("gone") }],
    });
    assertEqual(result.stale.join(","), "gone", "the old finding is named");
    assertEqual(result.post.length, 1, "and the new one still posts");
  });

  section("Y4.4 — posted = confirmed");

  await test("a comment id plus the finding's marker is what counts as posted", async () => {
    const intended = [finding("f1", "MAJOR"), finding("f2", "MINOR")];
    const confirmation = mod.confirmPosted({
      intended,
      results: [
        { id: 4711, body: mod.withFindingMarker("f1", "inline comment") },
        { comment: { id: "c2", body: mod.withFindingMarker("f2", "another") } },
      ],
    });
    assertEqual(confirmation.ok, true, "everything intended landed");
    assertEqual(
      confirmation.posted
        .map((p: { commentId: string }) => p.commentId)
        .join(","),
      "4711,c2",
      "ids are read from either shape",
    );
    assertEqual(
      mod.postingFailure(confirmation),
      undefined,
      "nothing to report",
    );
  });

  await test("a finding with no confirming result is reported loudly", async () => {
    const confirmation = mod.confirmPosted({
      intended: [finding("f1", "MAJOR"), finding("f2", "CRITICAL")],
      results: [{ id: "c1", body: mod.withFindingMarker("f1", "posted") }],
    });
    assertEqual(confirmation.ok, false, "an unconfirmed post is not a post");
    assertEqual(
      confirmation.unposted.join(","),
      "f2",
      "the missing id is named",
    );
    assertIncludes(
      String(mod.postingFailure(confirmation)),
      "f2",
      "the loud message names it too",
    );
  });

  await test("the agent claiming success without a comment id proves nothing", async () => {
    const confirmation = mod.confirmPosted({
      intended: [finding("f1", "MAJOR")],
      results: [{ status: "ok", message: "posted the comment" }],
    });
    assertEqual(confirmation.posted.length, 0, "no id, no confirmation");
    assertEqual(confirmation.unposted.join(","), "f1", "reported as unposted");
  });

  await test("echoing the marked body back is not evidence either — the id is", async () => {
    const confirmation = mod.confirmPosted({
      intended: [finding("f1", "MAJOR")],
      results: [{ body: mod.withFindingMarker("f1", "here is what I posted") }],
    });
    assertEqual(
      confirmation.posted.length,
      0,
      "a marker with no comment id confirms nothing",
    );
    assertEqual(confirmation.unposted.join(","), "f1", "still unposted");
  });

  await test("a comment that came back carrying no known marker is reported too", async () => {
    const confirmation = mod.confirmPosted({
      intended: [finding("f1", "MAJOR")],
      results: [
        { id: "c1", body: mod.withFindingMarker("f1", "posted") },
        { id: "c2", body: "a comment yama did not intend" },
      ],
    });
    assertEqual(confirmation.unmatched.join(","), "c2", "the stray comment id");
    assertEqual(confirmation.ok, false, "an unattributable comment is not ok");
  });

  section(
    "Y5.5 — the verdict policy is a pure function of findings and config",
  );

  const DEFAULTS = {
    blockOn: ["CRITICAL"],
    commentOn: ["MAJOR"],
    minConfidence: 0,
    blockAfter: 0,
  };

  await test("the default policy blocks on CRITICAL and says which finding did it", async () => {
    const verdict = mod.decideVerdict(
      [finding("f1", "CRITICAL"), finding("f2", "MINOR")],
      DEFAULTS,
    );
    assertEqual(verdict.decision, "block", "a CRITICAL blocks");
    assertIncludes(verdict.reasons.join("\n"), "f1", "the reason names it");
  });

  await test("MAJOR-only comments, and MINOR-only approves with the count stated", async () => {
    assertEqual(
      mod.decideVerdict([finding("f1", "MAJOR")], DEFAULTS).decision,
      "comment",
      "MAJOR reports without gating",
    );
    const quiet = mod.decideVerdict([finding("f1", "MINOR")], DEFAULTS);
    assertEqual(quiet.decision, "approve", "MINOR alone approves");
    assert(quiet.reasons.length > 0, "an approve with findings still says so");
  });

  await test("a clean run approves with nothing to say", async () => {
    const verdict = mod.decideVerdict([], DEFAULTS);
    assertEqual(verdict.decision, "approve", "no findings, no gate");
    assertEqual(verdict.reasons.length, 0, "and no reasons to give");
  });

  await test("the policy is config, not code: the same findings decide differently", async () => {
    const findings = [finding("f1", "MAJOR"), finding("f2", "MINOR")];
    assertEqual(
      mod.decideVerdict(findings, { ...DEFAULTS, blockOn: ["MAJOR"] }).decision,
      "block",
      "a stricter repository blocks on MAJOR",
    );
    assertEqual(
      mod.decideVerdict(findings, { ...DEFAULTS, commentOn: ["INFO"] })
        .decision,
      "approve",
      "a laxer one approves the same set",
    );
  });

  await test("enough comment-level findings become a block on their own", async () => {
    const many = ["a", "b", "c"].map((id) => finding(id, "MAJOR"));
    const verdict = mod.decideVerdict(many, { ...DEFAULTS, blockAfter: 3 });
    assertEqual(verdict.decision, "block", "the pile-up threshold fires");
    assertIncludes(verdict.reasons.join("\n"), "blockAfter", "and says why");
    assertEqual(
      mod.decideVerdict(many, { ...DEFAULTS, blockAfter: 4 }).decision,
      "comment",
      "one short of the threshold still only comments",
    );
  });

  await test("low-confidence findings are noise: they never move the verdict", async () => {
    const verdict = mod.decideVerdict(
      [finding("f1", "CRITICAL", { confidence: 0.2 })],
      { ...DEFAULTS, minConfidence: 0.5 },
    );
    assertEqual(verdict.decision, "approve", "a guess does not block a merge");
    assertIncludes(
      verdict.reasons.join("\n"),
      "confidence",
      "but the run says what it discounted",
    );
  });

  await test("ranking puts the most serious first, then the most confident", async () => {
    const ranked = mod.rankFindings([
      finding("c", "MINOR"),
      finding("a", "CRITICAL", { confidence: 0.5 }),
      finding("b", "CRITICAL", { confidence: 0.9 }),
    ]);
    assertEqual(
      ranked.map((f: { id: string }) => f.id).join(","),
      "b,a,c",
      "severity first, confidence second",
    );
  });

  section("Y4.5 — verdict to exit code");

  await test("only a block fails the pipeline", async () => {
    assertEqual(
      mod.exitCodeFor(mod.decideVerdict([finding("f1", "CRITICAL")], DEFAULTS)),
      1,
      "block exits 1",
    );
    assertEqual(
      mod.exitCodeFor(mod.decideVerdict([finding("f1", "MAJOR")], DEFAULTS)),
      0,
      "comment exits 0",
    );
    assertEqual(
      mod.exitCodeFor(mod.decideVerdict([], DEFAULTS)),
      0,
      "approve exits 0",
    );
  });

  section("Y1.1 — the delivery and verdict config blocks");

  await test("the fixture's blocks are parsed as written", async () => {
    const config = await mod.loadConfig(path.join(FIXTURES, "mini-repo"), {
      mode: "local",
    });
    assertEqual(config.yama.verdict.blockAfter, 5, "blockAfter from the file");
    assertEqual(config.yama.verdict.minConfidence, 0.4, "minConfidence");
    assertEqual(
      config.yama.delivery.maxInlineComments,
      10,
      "maxInlineComments",
    );
    assertEqual(config.yama.delivery.minSeverity, "MINOR", "minSeverity");
  });

  await test("absent blocks fall back to the documented defaults", async () => {
    await withTempDir("gate-config", async (dir) => {
      await configWorkspace(dir, { capabilities: "capabilities: {}" });
      const config = await mod.loadConfig(dir, { mode: "local" });
      assertEqual(
        config.yama.verdict.blockOn.join(","),
        "CRITICAL",
        "default blockOn",
      );
      assertEqual(
        config.yama.verdict.commentOn.join(","),
        "MAJOR",
        "default commentOn",
      );
      assertEqual(
        config.yama.delivery.inlineComments,
        true,
        "inline comments are on by default",
      );
      assertEqual(
        config.yama.delivery.verdict,
        false,
        "setting the platform verdict is opt-in",
      );
    });
  });

  await test("a local run has nothing to deliver to, and says so by name", async () => {
    await withTempDir("gate-config", async (dir) => {
      await configWorkspace(dir, { capabilities: PR_CAPABILITIES });
      const config = await mod.loadConfig(dir, { mode: "local" });
      assertEqual(config.deliveryActions.length, 0, "nothing is delivered");
      const off = config.degradations.map((d: { what: string }) => d.what);
      assert(
        off.includes("delivery.inlineComments"),
        "the disabled action is named as a degradation",
      );
    });
  });

  await test("a PR run delivers exactly the actions whose capability is mapped", async () => {
    await withTempDir("gate-config", async (dir) => {
      await configWorkspace(dir, { capabilities: PR_CAPABILITIES });
      const config = await mod.loadConfig(dir, { mode: "pr", pr: 7 });
      assertEqual(
        config.deliveryActions.join(","),
        "inlineComments",
        "only the mapped action survives",
      );
      const summary = config.degradations.find(
        (d: { what: string }) => d.what === "delivery.summaryComment",
      );
      assertIncludes(
        String(summary?.reason),
        "comment.summary.create",
        "the missing capability is named",
      );
    });
  });

  await test("an unknown key in the delivery block is a typo, not a shrug", async () => {
    await withTempDir("gate-config", async (dir) => {
      await configWorkspace(dir, {
        capabilities: "capabilities: {}",
        delivery: "delivery:\n  inlineComents: true\n",
      });
      let message = "";
      try {
        await mod.loadConfig(dir, { mode: "local" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "yama.yaml", "the failure names the file");
      assertIncludes(message, "delivery", "and the block that is wrong");
    });
  });

  await test("review.exclude keeps generated files out of the diff, and says which", async () => {
    // Measured on a real pull request: 940 of 953 changed lines were the lockfile, and
    // the rulebook could only ASK the model to skip it. This drops it before any stage
    // sees it — and reports what was dropped, because a review that quietly narrows
    // what it looked at is the failure this project exists to prevent.
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "@@ -1 +1 @@",
      "-lock old",
      "+lock new",
      "",
    ].join("\n");
    const diff = {
      files: [
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
        {
          path: "pnpm-lock.yaml",
          status: "modified",
          additions: 400,
          deletions: 380,
        },
        { path: "docs/logo.svg", status: "added", additions: 12, deletions: 0 },
      ],
      additions: 413,
      deletions: 381,
      patch,
      empty: false,
    };
    const out = mod.excludeFromDiff(diff, ["pnpm-lock.yaml", "*.svg"]);
    assertEqual(
      out.diff.files.map((f: { path: string }) => f.path).join(","),
      "src/a.ts",
      "only the reviewable file survives",
    );
    assertEqual(
      out.excluded.join(","),
      "pnpm-lock.yaml,docs/logo.svg",
      "and what was dropped is named — a basename pattern catches a nested path",
    );
    assertEqual(
      out.diff.additions,
      1,
      "the counts are recomputed, not inherited",
    );
    assert(
      !out.diff.patch.includes("lock new"),
      "the banked patch loses the excluded hunks too — otherwise a read-back returns them",
    );
    assert(out.diff.patch.includes("+new"), "and keeps the ones under review");

    const untouched = mod.excludeFromDiff(diff, []);
    assertEqual(untouched.excluded.length, 0, "an empty list excludes nothing");
    assertEqual(untouched.diff, diff, "and returns the diff it was given");

    // The matcher itself, on the shapes a repository actually writes.
    assertEqual(
      mod.matchesGlob("dist/x/y.js", "dist/**"),
      true,
      "directory tree",
    );
    assertEqual(
      mod.matchesGlob("src/dist.ts", "dist/**"),
      false,
      "not a prefix match",
    );
    assertEqual(
      mod.matchesGlob("a/b/c.min.js", "**/*.min.js"),
      true,
      "nested suffix",
    );
    assertEqual(
      mod.matchesGlob("src/deep/a.ts", "src/*.ts"),
      false,
      "* stays in one segment",
    );

    // Header shapes git really writes. The patch and the file list run one predicate,
    // so a header this cannot read is a file whose hunks would survive its exclusion.
    const headers = [
      'diff --git "a/weird name.svg" "b/weird name.svg"',
      "@@ -1 +1 @@",
      "-quoted old",
      "+quoted new",
      "diff --git a/src/old.ts b/src/renamed.svg",
      "@@ -1 +1 @@",
      "-renamed old",
      "+renamed new",
      "diff --git a/has b/dir.svg b/has b/dir.svg",
      "@@ -1 +1 @@",
      "-tricky old",
      "+tricky new",
      "diff --git a/src/keep.ts b/src/keep.ts",
      "@@ -1 +1 @@",
      "-keep old",
      "+keep new",
      "",
    ].join("\n");
    const parsed = mod.excludeFromDiff(
      {
        files: [
          {
            path: "weird name.svg",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
          {
            path: "src/renamed.svg",
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
          },
          {
            path: "has b/dir.svg",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
          {
            path: "src/keep.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        additions: 4,
        deletions: 4,
        patch: headers,
        empty: false,
      },
      ["*.svg"],
    );
    assert(
      !parsed.diff.patch.includes("quoted new"),
      "a quoted header is read, so its hunks go with it",
    );
    assert(
      !parsed.diff.patch.includes("renamed new"),
      "a rename is read from the side the diff produces",
    );
    assert(
      !parsed.diff.patch.includes("tricky new"),
      "and a path that itself contains ' b/' is read from the identical halves",
    );
    assert(
      parsed.diff.patch.includes("keep new"),
      "while the reviewable file keeps every hunk",
    );

    // A quoted header escapes every byte it had to; `--name-status -z` does not. Both
    // predicates have to see the SAME string, or the file list and the patch disagree
    // about what was excluded — which is how a named exclusion kept its hunks.
    const escaped = [
      'diff --git "a/caf\\303\\251.svg" "b/caf\\303\\251.svg"',
      "@@ -1 +1 @@",
      "-accent old",
      "+accent new",
      "diff --git a/plain.svg b/plain.svg",
      "@@ -1 +1 @@",
      "-plain old",
      "+plain new",
      "",
    ].join("\n");
    const byName = mod.excludeFromDiff(
      {
        files: [
          {
            path: "caf\u00e9.svg",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
          {
            path: "plain.svg",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        additions: 2,
        deletions: 2,
        patch: escaped,
        empty: false,
      },
      ["caf\u00e9.svg"],
    );
    assertEqual(
      byName.excluded.join(","),
      "caf\u00e9.svg",
      "the named file leaves the file list",
    );
    assert(
      !byName.diff.patch.includes("accent new"),
      "and its hunks leave the patch too — the octal escapes are undone, not compared raw",
    );
    assert(
      byName.diff.patch.includes("plain new"),
      "while the file nobody excluded keeps its hunks",
    );

    // The conventional ignore-file spelling. A leading double-star spans zero
    // directories, so it has to catch a file sitting at the repository root.
    assertEqual(
      mod.matchesGlob("c.svg", "**/*.svg"),
      true,
      "zero directories is a match",
    );
    assertEqual(
      mod.matchesGlob("a/b/c.svg", "**/*.svg"),
      true,
      "and so is any depth",
    );
    assertEqual(
      mod.matchesGlob("a/b.ts", "a/**/b.ts"),
      true,
      "a double star between segments spans zero of them as well",
    );
  });

  await test("a finding citing a file outside the change is dropped and named", async () => {
    const diff = {
      files: [
        { path: "src/real.ts", status: "modified", additions: 1, deletions: 0 },
        {
          path: "src/renamed.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
      ],
      additions: 1,
      deletions: 0,
      patch: "",
      empty: false,
    };
    const out = mod.groundFindings({
      findings: [
        { ...finding("f1", "MINOR"), file: "src/real.ts" },
        { ...finding("f2", "MAJOR"), file: "src/ghost.ts" },
        { ...finding("f3", "MINOR"), file: "src/old.ts" },
        { ...finding("f4", "CRITICAL"), file: "src/also-ghost.ts" },
      ],
      diff,
      allow: new Set(["f4"]),
    });
    assertEqual(
      out.grounded.map((entry: { id: string }) => entry.id).join(","),
      "f1,f3,f4",
      "changed file, rename's old side, and an allowed carry-over survive",
    );
    assertEqual(out.dropped.length, 1, "the fabrication is dropped");
    assertIncludes(
      out.dropped[0]?.reason ?? "",
      "src/ghost.ts",
      "and the drop names the file it invented",
    );
  });

  await test("a bare success result cannot confirm a post — the target re-read can", async () => {
    // GitHub's hosted MCP answers a review-comment write with exactly this: no id, no body.
    const bare = {
      content: [{ type: "text", text: "review comment successfully added" }],
    };
    const first = mod.confirmPosted({
      intended: [{ id: "f1" }, { id: "f2" }],
      results: [bare, bare],
    });
    assertEqual(first.ok, false, "no id and no marker confirm nothing");
    assertEqual(first.unposted.join(","), "f1,f2", "both findings unconfirmed");

    const merged = mod.confirmFromComments({
      confirmation: first,
      comments: [
        { id: "901", body: "the body\n\n<!-- yama:finding:f1 -->" },
        { id: "902", body: "an unrelated comment with no marker" },
      ],
    });
    assertEqual(merged.posted[0]?.commentId, "901", "the re-read confirms f1");
    assertEqual(
      merged.unposted.join(","),
      "f2",
      "what the target does not show stays unposted",
    );
    assertEqual(merged.ok, false, "one missing finding still fails the gate");

    const complete = mod.confirmFromComments({
      confirmation: first,
      comments: [
        { id: "901", body: "a\n\n<!-- yama:finding:f1 -->" },
        { id: "902", body: "b\n\n<!-- yama:finding:f2 -->" },
      ],
    });
    assertEqual(
      complete.ok,
      true,
      "the target showing every marker is delivery",
    );

    assertEqual(
      mod.confirmCreated([
        { content: [{ type: "text", text: '{"id":"55","url":"u"}' }] },
      ]),
      true,
      "an id in a clean result is the platform naming the comment",
    );
    assertEqual(
      mod.confirmCreated([bare]),
      false,
      "a bare success string is not",
    );
  });

  await test("a transient provider failure is retried; a misconfiguration is not", async () => {
    // The regression this exists for: a Cloudflare 524 in front of a provider proxy
    // ended an entire review twice, having told us in the body that it was retryable.
    assertEqual(
      mod.isTransientProviderError(
        new Error('524 {"error_name":"origin_response_timeout"}'),
      ),
      true,
      "a gateway timeout is transient",
    );
    assertEqual(
      mod.isTransientProviderError(
        new Error("Connection error: socket hang up"),
      ),
      true,
      "so is a dropped connection",
    );
    assertEqual(
      mod.isTransientProviderError({ status: 429, message: "rate limit" }),
      true,
      "and a rate limit",
    );
    assertEqual(
      mod.isTransientProviderError({
        status: 401,
        message: "invalid x-api-key",
      }),
      false,
      "a bad credential is NOT retried — three slow attempts would only hide it",
    );
    assertEqual(
      mod.isTransientProviderError(
        new Error("model not allowed for this team"),
      ),
      false,
      "nor is a model the key may not use",
    );

    // The override path: a status the provider set decides, and the message does not
    // get to overrule it. Each of these was retried three times before the fix.
    assertEqual(
      mod.isTransientProviderError({
        status: 401,
        message: "invalid x-api-key; upstream gateway timeout",
      }),
      false,
      "a 401 whose body mentions a timeout still fails fast",
    );
    assertEqual(
      mod.isTransientProviderError({
        status: 400,
        message: "invalid request: expected 500 tokens",
      }),
      false,
      "and a 400 quoting a 5xx-looking number is not a 5xx",
    );
    assertEqual(
      mod.isTransientProviderError({ status: 429, message: "slow down" }),
      true,
      "while a status that IS transient still retries",
    );
    // No usable status at all: the text is the only signal, which is the shape the
    // gateway failure that started this arrives in.
    assertEqual(
      mod.isTransientProviderError({ code: "ECONNRESET" }),
      true,
      "a Node error code is read from the text, not mistaken for an HTTP status",
    );
    assertEqual(
      mod.isTransientProviderError(undefined),
      false,
      "and nothing at all is not a reason to retry",
    );

    // And the runner acts on the classification: a transient throw is re-attempted,
    // and the checkpoint succeeds without the stage ever seeing the failure.
    await withTempDir("gate-retry", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      let calls = 0;
      const session = mod.createSessionRunner({
        engine: {
          generateStructured: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error('524 {"error_name":"origin_response_timeout"}');
            }
            return reply({ ok: true });
          },
          registerTool: () => undefined,
        },
        paths,
        sessionId: "run-retry",
      });
      const out = await session.checkpoint({
        stage: "warmup",
        prompt: "the task",
        schema: Payload,
      });
      assertEqual(calls, 2, "the transient failure was retried once");
      assertEqual(out.data.ok, true, "and the stage got its answer");
    });
  });

  await test("an accepted write confirms race-free: the sent body carries the marker", async () => {
    const call = (over: Record<string, unknown> = {}) => ({
      name: "create_inline",
      params: { body: "text\n\n<!-- yama:finding:f1 -->" },
      result: { content: [{ type: "text", text: "added" }] },
      isError: false,
      truncated: false,
      ...over,
    });
    const ok = mod.confirmAcceptedWrites({
      intended: [{ id: "f1" }, { id: "f2" }],
      results: [call()],
      tool: "create_inline",
    });
    assertEqual(
      ok.posted[0]?.findingId,
      "f1",
      "the accepted body's marker confirms it",
    );
    assertEqual(
      ok.unposted.join(","),
      "f2",
      "what was never accepted stays unposted",
    );
    const errored = mod.confirmAcceptedWrites({
      intended: [{ id: "f1" }],
      results: [call({ isError: true })],
      tool: "create_inline",
    });
    assertEqual(errored.posted.length, 0, "an errored call accepts nothing");
    const merged = mod.mergeConfirmations(ok, {
      posted: [{ findingId: "f2", commentId: "9" }],
      unposted: ["f1"],
      unmatched: [],
      ok: false,
    });
    assertEqual(merged.ok, true, "posted once anywhere is posted");
  });

  await test("a plan the agent never turned into a checklist is caught, and named", () => {
    // The two live shapes this exists for. yama PR #101: no items at all over 15 files.
    // curator PR #702: three items, every one scoped `<UNKNOWN>`, and a run that
    // APPROVED a change nobody had read. Guarding `plan.tasks` catches neither — the
    // schema pins it at .min(1), so a plan that validates always claims one.
    const task = (scope: string[]) => ({
      title: "check it",
      rationale: "the diff changed it",
      scope,
      delegate: false,
    });
    const item = (id: string) => ({
      id,
      title: `check ${id}`,
      status: "pending" as const,
    });

    const none = mod.checklistProblems({
      files: ["src/a.ts"],
      tasks: [task(["src/a.ts"])],
      checklist: [],
    });
    assertEqual(none.length, 1, "a plan nobody created is a problem");
    assertIncludes(
      none[0] ?? "",
      "tasks_create was never called",
      "and the reason says what was not done",
    );
    assertEqual(
      mod.preparationFatal({
        files: ["src/a.ts"],
        tasks: [task(["src/a.ts"])],
        checklist: [],
      }),
      true,
      "no checklist is fatal: there is nothing for the work stage to pick up",
    );

    assertEqual(
      mod.preparationFatal({
        files: ["src/a.ts", "src/b.ts"],
        tasks: [task(["<UNKNOWN>"])],
        checklist: [item("t1")],
      }),
      true,
      "items that answer for NOT ONE file are the #702 shape, and just as fatal",
    );

    assertEqual(
      mod.checklistProblems({
        files: ["src/a.ts"],
        tasks: [task(["src/a.ts"])],
        checklist: [item("t1")],
      }).length,
      0,
      "a checklist the engine holds, covering the change, passes",
    );
    assertEqual(
      mod.checklistProblems({ files: [], tasks: [], checklist: [] }).length,
      0,
      "and a change with no reviewable file owes no checklist at all",
    );
  });

  await test("coverage is measured against the change, not against the prose", () => {
    const task = (scope: string[]) => ({
      title: "check it",
      rationale: "why",
      scope,
      delegate: false,
    });
    const files = [
      "src/stages/work.ts",
      "src/stages/collate.ts",
      "docs/readme.md",
    ];

    const byDir = mod.checkCoverage({ files, tasks: [task(["src/stages"])] });
    assertEqual(
      byDir.covered.length,
      2,
      "a bare directory covers what is under it — nobody writing a scope means otherwise",
    );
    assertEqual(
      byDir.uncovered.join(","),
      "docs/readme.md",
      "and what it does not cover is named, one path at a time",
    );

    const placeholder = mod.checkCoverage({
      files,
      tasks: [task(["<UNKNOWN>"]), task(["TBD"])],
    });
    assertEqual(
      placeholder.covered.length,
      0,
      "a placeholder scope covers nothing",
    );
    assertEqual(
      placeholder.unresolved.length,
      0,
      "and is not reported as a path that merely moved",
    );

    const stale = mod.checkCoverage({ files, tasks: [task(["src/gone.ts"])] });
    assertEqual(
      stale.unresolved.join(","),
      "src/gone.ts",
      "a scope naming a file the change does not touch is called out on its own",
    );

    assertEqual(
      mod.checkCoverage({ files: ["a.ts", "b.ts"], tasks: [task([])] })
        .complete,
      true,
      "an unscoped item means the whole change, and on a small one it is honest",
    );
    assertEqual(
      mod.checkCoverage({
        files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
        tasks: [task([])],
      }).covered.length,
      0,
      "on a large one it is how a plan looks when nobody read the diff",
    );
  });

  await test("the preparation nudge says what is missing and what to do", () => {
    const nudge = mod.buildPreparationNudge({
      problems: ["2 of 3 changed file(s) are on no checklist item"],
      files: ["a.ts", "b.ts", "c.ts"],
      coverage: {
        covered: ["a.ts"],
        uncovered: ["b.ts", "c.ts"],
        unresolved: ["<UNKNOWN>"],
        complete: false,
      },
      checklist: [{ id: "t1", title: "check a.ts", status: "pending" }],
      facts: "THE CHANGE UNDER REVIEW — pull request #101.",
    });
    assertIncludes(
      nudge,
      "THE CHANGE UNDER REVIEW",
      "it restates the ground truth",
    );
    assertIncludes(nudge, "b.ts", "names the files nothing answers for");
    assertIncludes(
      nudge,
      "t1",
      "shows the checklist as the engine really holds it",
    );
    assertIncludes(nudge, "tasks_create", "and says the call that fixes it");
    assertIncludes(
      nudge,
      "needs no review is still accounted for",
      "while leaving the judgement — including 'this one is fine' — to the reviewer",
    );
    assertIncludes(
      mod.buildPreparationNudge({
        problems: ["no checklist exists"],
        files: ["a.ts"],
        coverage: {
          covered: [],
          uncovered: ["a.ts"],
          unresolved: [],
          complete: false,
        },
        checklist: [],
        final: true,
      }),
      "LAST ROUND",
      "and the last round asks for the smallest thing that can still work",
    );
  });

  await test("a review that established nothing does not get to approve", () => {
    // curator PR #702, exactly: four items, every one closed unworked, no findings, and
    // `decideVerdict([], policy)` returning APPROVE over a change nobody had read.
    const closed = (id: string) => ({
      id,
      title: `check ${id}`,
      status: "closed" as const,
      note: "blocked",
    });
    const reason = mod.reviewEstablishedNothing({
      changedFiles: 7,
      checklist: [closed("t1"), closed("t2")],
      findings: 0,
    });
    assert(reason !== undefined, "a run that worked nothing cannot decide");
    assertIncludes(
      reason ?? "",
      "not a review that found nothing",
      "and the reason draws the distinction that matters",
    );
    assertEqual(
      mod.reviewEstablishedNothing({
        changedFiles: 7,
        checklist: [{ id: "t1", title: "check", status: "done" }],
        findings: 0,
      }),
      undefined,
      "a run that WORKED its checklist and found nothing is a clean review, and says so",
    );
    assertEqual(
      mod.reviewEstablishedNothing({
        changedFiles: 7,
        checklist: [closed("t1")],
        findings: 2,
      }),
      undefined,
      "and findings prove the review happened whatever the checklist looks like",
    );
    assertEqual(
      mod.reviewEstablishedNothing({
        changedFiles: 0,
        checklist: [],
        findings: 0,
      }),
      undefined,
      "an empty change is owed nothing",
    );
  });

  await test("the same task created seventeen times is one task", () => {
    // Measured on this repository's own pull request: 327 checklist items over 86
    // distinct titles, one of them created seventeen times, from a plan whose own 25
    // tasks were all unique. `tasks_create` appends, so a model that calls it twice with
    // overlapping arrays gets duplicates — and the completeness gate would then demand
    // all 327 be settled, turning a stutter in one tool call into an unfinishable review.
    const item = (
      id: string,
      title: string,
      status: string,
      note?: string,
    ) => ({ id, title, status, ...(note !== undefined ? { note } : {}) });

    const distinct = mod.distinctTasks([
      item("t1", "check the token endpoint", "pending"),
      item("t2", "check the token endpoint", "done"),
      item("t3", "Check The Token Endpoint", "pending"),
      item(
        "t4",
        "check the migration",
        "closed",
        "no migration in this change",
      ),
    ]);
    assertEqual(distinct.length, 2, "two titles are two pieces of work");
    assertEqual(
      distinct.find((t: { title: string }) => t.title.includes("token"))
        ?.status,
      "done",
      "work done once is done, whichever copy it was recorded against",
    );

    const gate = mod.checkChecklist({
      sessionId: "run-1",
      tasks: [
        item("t1", "check the token endpoint", "done"),
        item("t2", "check the token endpoint", "pending"),
        item("t3", "check the token endpoint", "pending"),
      ],
    });
    assertEqual(
      gate.complete,
      true,
      "and the completeness gate is not held open by copies of finished work",
    );
    assertEqual(gate.tasks.length, 1, "it reports the work, not the copies");

    // The trade-off, pinned rather than left implicit (raised in review of this change):
    // two genuinely different items sharing a title also collapse, so a done one masks a
    // pending one. The engine's checklist carries no scope to separate them by, and
    // collapsing conservatively would restore the 317-pending failure this fixes. What
    // bounds it is the other gate: per-file coverage is checked at preparation, against
    // the plan's scopes, before the completeness gate is ever consulted.
    const sharedTitle = mod.checkChecklist({
      sessionId: "run-1",
      tasks: [
        item("t1", "check error handling", "done"),
        item("t2", "check error handling", "pending"),
      ],
    });
    assertEqual(
      sharedTitle.complete,
      true,
      "same title collapses even when the work differed — the cost of making stutter copies survivable",
    );

    const stillOpen = mod.checkChecklist({
      sessionId: "run-1",
      tasks: [
        item("t1", "check the token endpoint", "done"),
        item("t2", "check the migration", "pending"),
      ],
    });
    assertEqual(
      stillOpen.complete,
      false,
      "a genuinely different item still holds the gate open",
    );
  });

  await test("a reply is attached to the finding it answers, and travels as a claim", () => {
    // The recurring-run case: review 1 posts five findings, somebody answers two of them,
    // review 2 runs. It has to tell three situations apart that look identical without the
    // thread — fixed, argued with, and ignored — and a reply saying "fixed" is a claim the
    // current code either bears out or does not.
    const marker = (id: string) => `<!-- yama:finding:${id} -->`;
    const comments = [
      { id: "c1", body: `logs a token ${marker("auth-token-logged")}` },
      {
        id: "c2",
        body: "fixed in the latest commit",
        author: "a maintainer",
        inReplyTo: "c1",
      },
      { id: "c3", body: `weak hash ${marker("weak-hash")}` },
    ];

    const dedupe = mod.dedupePostedFindings({
      findings: [
        { id: "auth-token-logged", severity: "CRITICAL" },
        { id: "weak-hash", severity: "MAJOR" },
        { id: "new-one", severity: "MINOR" },
      ],
      comments,
    });
    assertEqual(
      dedupe.post.map((f: { id: string }) => f.id).join(","),
      "new-one",
      "only the finding nobody has seen gets posted",
    );
    const answered = dedupe.alreadyPosted.find(
      (p: { findingId: string }) => p.findingId === "auth-token-logged",
    );
    assertEqual(
      answered?.replies?.[0]?.author,
      "a maintainer",
      "the finding carries who answered it",
    );
    assertIncludes(
      answered?.replies?.[0]?.body ?? "",
      "fixed in the latest commit",
      "and what they said — which this run still found open, so it is a claim, not a fix",
    );
    const ignored = dedupe.alreadyPosted.find(
      (p: { findingId: string }) => p.findingId === "weak-hash",
    );
    assertEqual(
      ignored?.replies,
      undefined,
      "a finding nobody replied to is distinguishable from one that was answered",
    );

    const prompt = mod.buildDeliveryPrompt({
      plan: {
        actions: ["inlineComments"],
        comments: [],
        alreadyPosted: dedupe.alreadyPosted,
        stale: [],
      },
      registry: {
        toolFor: (capability: string) =>
          capability === "comment.reply"
            ? "add_reply_to_pull_request_comment"
            : "add_comment",
        argsFor: () => ({ owner: "juspay", repo: "yama" }),
      },
    });
    assertIncludes(
      prompt,
      "add_reply_to_pull_request_comment",
      "the reply tool is named from the capability map, never from code",
    );
    assertIncludes(
      prompt,
      "READ ITS OWN PARAMETERS",
      "and the agent calls it the way that tool documents itself",
    );
    const noReply = mod.buildDeliveryPrompt({
      plan: {
        actions: ["inlineComments"],
        comments: [],
        alreadyPosted: dedupe.alreadyPosted,
        stale: [],
      },
      registry: {
        toolFor: (capability: string) =>
          capability === "comment.reply" ? undefined : "add_comment",
        argsFor: () => ({}),
      },
    });
    assertIncludes(
      noReply,
      "Nothing you hold can answer an existing comment",
      "a forge with no reply tool says so, rather than faking one with a new comment",
    );
    assertIncludes(
      prompt,
      "STILL OPEN",
      "delivery is told they survived a second look",
    );
    assertIncludes(
      prompt,
      "a maintainer replied: fixed in the latest commit",
      "with the reply that has not been answered",
    );
    assertIncludes(
      prompt,
      "nobody has replied to it",
      "and the one nobody touched, said plainly",
    );
    assertIncludes(
      prompt,
      "your judgement",
      "whether to answer is the reviewer's call, not a step the shell forces",
    );
    assertIncludes(
      prompt,
      "None of it is counted as delivery",
      "and nothing extra is counted against the findings contract",
    );
  });

  await test("a run the gate had to rescue does not approve", () => {
    // Caught by this repository's own review of this change, and it was right: `recovered`
    // was recorded on the metric, printed in the progress line, and consulted by nothing.
    // decideVerdict is a pure function of findings, so a run whose stage had to be closed
    // out by the gate returned APPROVE indistinguishably from one that did its job.
    const clean = { decision: "approve" as const, reasons: ["nothing found"] };
    const rescued = mod.withRecoveryCaveat(clean, [
      { stage: "warmup", trusted: true },
      { stage: "taskInsertion", recovered: true },
    ]);
    assertEqual(
      rescued.decision,
      "comment",
      "an approval is a positive claim, and a rescued run cannot make it at full strength",
    );
    assertIncludes(
      rescued.reasons.join(" "),
      "taskInsertion",
      "and the reason names the stage that had to be closed out",
    );
    assertEqual(
      mod.withRecoveryCaveat(clean, [{ stage: "warmup", trusted: true }])
        .decision,
      "approve",
      "a run that answered on its own still approves",
    );
    assertEqual(
      mod.withRecoveryCaveat(clean, [{ stage: "work", recovered: true }])
        .decision,
      "approve",
      "a rescued WORK round does not: it answers to its own completeness gate, and on a slow gateway it is closed out routinely",
    );
    assertEqual(
      mod.withRecoveryCaveat(clean, [{ stage: "collate", recovered: true }])
        .decision,
      "comment",
      "but the stage the findings themselves came out of does",
    );
    assertEqual(
      mod.withRecoveryCaveat({ decision: "block", reasons: ["1 CRITICAL"] }, [
        { stage: "work", recovered: true },
      ]).decision,
      "block",
      "and a rescued run that still found something serious blocks on its own evidence",
    );
  });

  await test("a thread this reviewer already answered is not answered again", () => {
    // The one write surface this change adds outside the posted-confirmed contract. Without
    // a marker of its own, every recurring run would tell the same thread the same thing
    // again — the duplicate-posting failure that marker dedup exists to prevent.
    const replyMarker = (id: string) => `<!-- yama:reply:${id} -->`;
    const prompt = (replies: { body: string }[]) =>
      mod.buildDeliveryPrompt({
        plan: {
          actions: ["inlineComments"],
          comments: [],
          alreadyPosted: [{ findingId: "weak-hash", commentId: "c3", replies }],
          stale: [],
        },
        registry: {
          toolFor: (capability: string) =>
            capability === "comment.reply" ? "add_reply" : "add_comment",
          argsFor: () => ({}),
        },
      });

    const fresh = prompt([]);
    assertIncludes(fresh, "weak-hash", "an unanswered thread is offered");
    assertIncludes(
      fresh,
      replyMarker("weak-hash"),
      "with the marker the reply must carry",
    );

    const answered = prompt([
      { body: `still open after a second look ${replyMarker("weak-hash")}` },
    ]);
    assertIncludes(
      answered,
      "already carries this reviewer's answer",
      "a thread this reviewer already answered is not offered again",
    );
    assert(
      !answered.includes("marker for your reply"),
      "and no reply marker is handed out for it",
    );
  });

  await test("memory that cannot evict is a named degradation, not a silent one", () => {
    // Raised by this change's own review: the summarizer ceiling lives inside the engine,
    // "and Yama never names or detects a summarizer timeout as a named degradation — the
    // failure is silent context growth until the run dies at the window". Yama cannot see
    // the engine's internal timeout, but it does know whether anything will evict at all,
    // and that is the state that grows unbounded while looking healthy.
    const evicting = {
      enabled: true,
      ready: true,
      evicting: true,
      tokenThreshold: 16000,
    };
    const notEvicting = { ...evicting, evicting: false };
    assertEqual(
      mod.memoryDegradation(evicting),
      undefined,
      "a memory that summarizes needs no warning",
    );
    assertIncludes(
      mod.memoryDegradation(notEvicting)?.reason ?? "",
      "nothing will evict",
      "one that cannot says so, in the run report a human reads",
    );
    assertIncludes(
      mod.memoryDegradation(notEvicting)?.reason ?? "",
      "16000",
      "naming the threshold that will be crossed and not acted on",
    );
    assertIncludes(
      mod.memoryDegradation({ enabled: false, ready: false })?.reason ?? "",
      "starts from nothing",
      "and memory switched off is still its own, different degradation",
    );
  });

  await test("no prompt depends on a conversation being there", async () => {
    // Memory is on (TASKS:Y2.5) and this rule survives it. Summarization evicts, so a
    // prompt whose meaning lives in an earlier turn breaks under exactly the load that
    // makes it necessary — and it broke completely for the whole of v5, when the engine
    // was built with no memory config at all and every stage was a cold call. The gate's
    // own closing ask used to say "using only what you have already gathered in this
    // conversation" while switching every tool off, which on a cold call can only invent.
    const banned = [
      "in this conversation",
      "your last turn",
      "already gathered",
    ];
    const sources = [
      "stages/warmup.ts",
      "stages/taskInsertion.ts",
      "stages/work.ts",
      "stages/collate.ts",
      "stages/delivery.ts",
      "stages/target.ts",
      "gates/schema.ts",
      "gates/checklist.ts",
      "gates/coverage.ts",
      "core/instruction.ts",
    ];
    for (const source of sources) {
      const text = await readFile(path.join(REPO_ROOT, "src", source), "utf8");
      for (const phrase of banned) {
        assert(
          !text.includes(phrase),
          `${source} must not say "${phrase}" — every prompt has to stand on its own`,
        );
      }
    }
  });

  await test("what a run could not establish reaches the summary", () => {
    // The work stage wrote "conversation memory retrieval is disabled in this
    // environment" — the one line that explained curator PR #702 — into an artifact
    // nobody opens. It belongs in the report a human actually reads.
    const base = {
      runId: "run-1",
      mode: "pr" as const,
      target: { mode: "pr" as const, pr: 702 },
      startedAt: new Date().toISOString(),
      stages: [],
      tasks: [],
      degradations: [],
    };
    const rendered = mod.renderRunSummary(
      {
        ...base,
        unknowns: ["warmup: no rulebook was read", "work: memory off"],
      },
      "/tmp/store",
    );
    assertIncludes(
      rendered,
      "could not be established",
      "the section is named plainly",
    );
    assertIncludes(
      rendered,
      "work: memory off",
      "and carries the run's own words",
    );
    const many = mod.renderRunSummary(
      {
        ...base,
        unknowns: Array.from({ length: 12 }, (_, index) => `work: q${index}`),
      },
      "/tmp/store",
    );
    assertIncludes(
      many,
      "and 4 more",
      "a long list is truncated with the count, never silently cut",
    );
    assert(
      !mod
        .renderRunSummary(base, "/tmp/store")
        .includes("could not be established"),
      "and a run with nothing unknown says nothing",
    );
  });

  await test("every stage is told the change, not just the last stage's prose", () => {
    // Measured on curator PR #702: the stages after Task Insertion were handed only
    // `plan.changeSummary` — which said the change could not be retrieved — while the
    // diff sat in the run store under a stable id. A stage is one independent call, so
    // whatever its prompt does not carry, it does not have.
    const block = mod.renderTargetFacts({
      target: { mode: "pr", pr: 702, base: "origin/main" },
      diff: {
        files: [
          { path: "src/a.ts", status: "modified", additions: 4, deletions: 1 },
          {
            path: "src/b.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ],
        additions: 4,
        deletions: 1,
        patch: "diff --git a/src/a.ts b/src/a.ts",
        empty: false,
      },
      banked: {
        id: "7a42d65d",
        sizeBytes: 44943,
        preview: "diff --git",
        readBackHint: "retrieve_context({ artifactId: '7a42d65d' })",
      },
      excluded: ["pnpm-lock.yaml"],
    });
    assertIncludes(block, "pull request #702", "the target names itself");
    assertIncludes(block, "into origin/main", "and the ref it is going into");
    assertIncludes(block, "src/a.ts", "every changed file is listed");
    assertIncludes(block, "was src/old.ts", "a rename says where it came from");
    assertIncludes(block, "7a42d65d", "the banked patch is named by id");
    assertIncludes(
      block,
      "retrieve_context({ artifactId: '7a42d65d' })",
      "with the call that reads it back",
    );
    assertIncludes(
      block,
      "pnpm-lock.yaml",
      "and what was excluded is named, so a stage knows what it is not seeing",
    );
  });

  await test("a marker confirms whatever argument the platform carries it in", () => {
    // Bitbucket takes the text as `comment_text`, GitHub as `body`, and one platform's
    // spelling must not decide whether the other's comment counts as delivered.
    const bitbucket = mod.confirmAcceptedWrites({
      intended: [{ id: "f1" }],
      results: [
        {
          name: "add_comment",
          params: {
            workspace: "acme",
            repository: "svc",
            pull_request_id: 702,
            comment_text: "text\n\n<!-- yama:finding:f1 -->",
            file_path: "src/a.ts",
            line_number: 12,
          },
          result: { content: [{ type: "text", text: "created" }] },
          isError: false,
          truncated: false,
        },
      ],
      tool: "add_comment",
    });
    assertEqual(
      bitbucket.ok,
      true,
      "a marker in comment_text confirms the write",
    );
    const suggestion = mod.confirmAcceptedWrites({
      intended: [{ id: "f2" }],
      results: [
        {
          name: "add_comment",
          params: {
            comment_text: "prose\n\n<!-- yama:finding:f2 -->",
            suggestion: "const x = 1;",
            severity: "BLOCKER",
          },
          result: { content: [{ type: "text", text: "created" }] },
          isError: false,
          truncated: false,
        },
      ],
      tool: "add_comment",
    });
    assertEqual(
      suggestion.ok,
      true,
      "the platform's richer arguments do not hide the marker",
    );
    const elsewhere = mod.confirmAcceptedWrites({
      intended: [{ id: "f3" }],
      results: [
        {
          name: "add_comment",
          params: { comment_text: "no marker here" },
          result: { content: [{ type: "text", text: "created" }] },
          isError: false,
          truncated: false,
        },
      ],
      tool: "add_comment",
    });
    assertEqual(
      elsewhere.unposted.join(","),
      "f3",
      "and a call carrying no marker still confirms nothing",
    );
  });
}
