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
  let index = 0;
  return {
    prompts,
    engine: {
      generateStructured: async (req: { prompt: string }) => {
        prompts.push(req.prompt);
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
        "the retry AND the finalize ask were spent before giving up",
      );
      assertIncludes(
        prompts[2] ?? "",
        "Do NOT call any more tools",
        "the last ask is the finalize — JSON only, no more work",
      );
      assertIncludes(message, "finalize", "the failure says the finalize ran");
      assertIncludes(message, "banked output", "the failure names the file");
      const banked = session.metrics().at(-1)?.rawPath ?? "";
      assertIncludes(
        await readFile(banked, "utf8"),
        "## structured",
        "both attempts are on disk",
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
}
