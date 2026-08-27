/**
 * Suite: the main session, the static instruction and the two implemented stages
 * (TASKS:Y2.2, Y2.4, Y3.1, Y3.2).
 *
 * The agentic half of a stage needs a provider, so the cases that need one skip without
 * credentials. Everything mechanical is tested for real: that a checkpoint banks the
 * verbatim output BEFORE it judges it, that a stage which produces nothing usable still
 * leaves its evidence on disk, what the prompts actually say, and how a recurring run is
 * recognised from the store.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  DIST_ENTRY,
  Skip,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  distModule,
  gitWorkspace as workspace,
  isBuilt,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("session-and-stages");

type RawShape = {
  content: string;
  structured: unknown;
  repaired: boolean;
  truncated: boolean;
  provider?: string;
  model?: string;
  stepsUsed?: number;
  toolsUsed?: string[];
};

/** An engine that answers with whatever the test decided, so the shell is what is tested. */
const fakeEngine = (
  replies: { data: unknown; trusted: boolean; raw: RawShape }[],
) => {
  const seen: { prompt: string; tools?: string[] }[] = [];
  let index = 0;
  return {
    seen,
    engine: {
      generateStructured: async (req: { prompt: string; tools?: string[] }) => {
        seen.push({
          prompt: req.prompt,
          ...(req.tools ? { tools: req.tools } : {}),
        });
        const reply = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return reply;
      },
      registerTool: () => undefined,
    },
  };
};

const raw = (content: string, structured: unknown): RawShape => ({
  content,
  structured,
  repaired: false,
  truncated: false,
  provider: "test-provider",
  model: "test-model",
  stepsUsed: 3,
  toolsUsed: ["read_file"],
});

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("the static system instruction");

  await test("it is one constant with nothing interpolated into it", async () => {
    const mod = await import(DIST_ENTRY);
    const instruction: unknown = mod.SYSTEM_INSTRUCTION;
    assertEqual(typeof instruction, "string", "SYSTEM_INSTRUCTION export");
    const text = String(instruction);
    assert(
      !text.includes("${"),
      "a static instruction must carry no interpolation",
    );
    assert(
      !text.includes("undefined"),
      "a static instruction must carry no stray values",
    );
    assertIncludes(
      text,
      "checklist",
      "it must state the completeness contract",
    );
    assertIncludes(
      text,
      "retrieve_context",
      "it must tell the agent how to read a bank back",
    );
  });

  section("the session runner banks before it judges");

  await test("a checkpoint banks the verbatim output and the structured envelope", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("session", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const { engine } = fakeEngine([
        {
          data: { ok: true },
          trusted: true,
          raw: raw("I looked at everything", { ok: true }),
        },
      ]);
      const session = mod.createSessionRunner({
        engine,
        paths,
        sessionId: "run-1",
      });

      const envelope = await session.checkpoint({
        stage: "warmup",
        prompt: "do the thing",
        schema: z.object({ ok: z.boolean() }),
        tools: ["read_file"],
      });
      assertEqual(envelope.trusted, true, "trusted envelope");
      assertEqual(envelope.stage, "warmup", "stage name");

      const back = await mod.readStage(
        paths,
        "warmup",
        z.object({ ok: z.boolean() }),
      );
      assertEqual(back?.data?.ok, true, "the envelope is on disk");

      const metrics = session.metrics();
      assertEqual(metrics.length, 1, "one metric per checkpoint");
      assertEqual(metrics[0].provider, "test-provider", "provider recorded");
      const banked = await readFile(metrics[0].rawPath, "utf8");
      assertIncludes(
        banked,
        "I looked at everything",
        "the verbatim output is banked",
      );
      assertIncludes(
        banked,
        "## structured",
        "the structured body is banked too",
      );
    });
  });

  await test("a stage that produces nothing usable still leaves its evidence", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("session", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const { engine } = fakeEngine([
        {
          data: undefined,
          trusted: false,
          raw: { ...raw("half a json", { ok: 1 }), truncated: true },
        },
      ]);
      const session = mod.createSessionRunner({
        engine,
        paths,
        sessionId: "run-1",
      });

      let thrown: unknown;
      try {
        await session.checkpoint({
          stage: "warmup",
          prompt: "do the thing",
          schema: z.object({ ok: z.boolean() }),
        });
      } catch (error) {
        thrown = error;
      }
      assert(
        thrown instanceof Error,
        "a stage with no usable output must fail",
      );
      const message = thrown instanceof Error ? thrown.message : "";
      assertIncludes(message, "cut short", "the failure says what went wrong");
      assertIncludes(
        message,
        "banked output",
        "the failure names the banked evidence",
      );

      const metrics = session.metrics();
      assertEqual(
        metrics[0].trusted,
        false,
        "an untrusted stage is recorded as such",
      );
      assertIncludes(
        await readFile(metrics[0].rawPath, "utf8"),
        "half a json",
        "the evidence is on disk even though the stage failed",
      );
    });
  });

  await test("a stage asked twice banks twice — neither answer is overwritten", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("session", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const { engine } = fakeEngine([
        {
          data: { ok: true },
          trusted: true,
          raw: raw("the first answer", { ok: true }),
        },
        {
          data: { ok: true },
          trusted: true,
          raw: raw("the second answer", { ok: true }),
        },
      ]);
      const session = mod.createSessionRunner({
        engine,
        paths,
        sessionId: "run-1",
      });
      const schema = z.object({ ok: z.boolean() });
      await session.checkpoint({ stage: "work", prompt: "a", schema });
      await session.checkpoint({ stage: "work", prompt: "b", schema });

      const metrics = session.metrics();
      assertEqual(metrics.length, 2, "one metric per checkpoint");
      assert(
        metrics[0].rawPath !== metrics[1].rawPath,
        "a second checkpoint must not bank over the first",
      );
      assertIncludes(
        await readFile(metrics[0].rawPath, "utf8"),
        "the first answer",
        "the first answer survives",
      );
      assertIncludes(
        await readFile(metrics[1].rawPath, "utf8"),
        "the second answer",
        "and so does the second",
      );
    });
  });

  await test("every stage of a run shares one session id", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("session", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const sessions: string[] = [];
      const engine = {
        generateStructured: async (req: { sessionId: string }) => {
          sessions.push(req.sessionId);
          return {
            data: { ok: true },
            trusted: true,
            raw: raw("x", { ok: true }),
          };
        },
        registerTool: () => undefined,
      };
      const session = mod.createSessionRunner({
        engine,
        paths,
        sessionId: "run-77",
      });
      const schema = z.object({ ok: z.boolean() });
      await session.checkpoint({ stage: "warmup", prompt: "a", schema });
      await session.checkpoint({ stage: "taskInsertion", prompt: "b", schema });
      assertEqual(
        sessions.join(","),
        "run-77,run-77",
        "one session across stages",
      );
    });
  });

  section("warm up — the prompt says where things are, and what is missing");

  await test("with a rulebook it points at the index first", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("warmup", async (dir) => {
      await workspace(dir);
      const config = await mod.loadConfig(dir, { mode: "local" });
      const prompt = mod.buildWarmUpPrompt(config);
      assertIncludes(prompt, "rulebook index", "index line");
      assertIncludes(prompt, "index.md", "the index path");
      assertIncludes(prompt, "read this FIRST", "index-first instruction");
      assertIncludes(
        prompt,
        "memory: none yet",
        "an absent memory directory is stated",
      );
      assertIncludes(
        prompt,
        "Switched off for this run",
        "degradations are carried into the prompt",
      );
    });
  });

  await test("with no rulebook it says so instead of inventing one", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("warmup", async (dir) => {
      await workspace(dir);
      await runCommand("rm", ["-rf", path.join(dir, ".yama", "rulebook")], {
        cwd: dir,
      });
      const config = await mod.loadConfig(dir, { mode: "local" });
      const prompt = mod.buildWarmUpPrompt(config);
      assertIncludes(prompt, "rulebook: none configured", "absent rulebook");
      assert(
        !prompt.includes("read this FIRST"),
        "there is no index to read first",
      );
    });
  });

  section("task insertion — the diff is referenced, not pasted");

  const bankedRef = {
    id: "stage-output-diff-local",
    label: "diff-local",
    sizeBytes: 12_345,
    preview: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
    readBackHint:
      'retrieve_context({ artifactId: "stage-output-diff-local", offset: 0, limit: 4000 })',
  };

  const diff = {
    files: [{ path: "app.ts", status: "modified", additions: 1, deletions: 1 }],
    additions: 1,
    deletions: 1,
    patch: "…",
    empty: false,
  };

  const brief = {
    persona: "sceptical about auth",
    rules: [],
    focusAreas: ["security", "tests"],
    sources: [".yama/rulebook/index.md"],
    gaps: [],
  };

  /** A prior finding, as the ledger holds one. */
  const priorFinding = (id: string, severity: string) => ({
    id,
    file: "src/auth.ts",
    line: 7,
    severity,
    category: "security",
    summary: `${id} summary`,
    impact: "a token reaches the log",
    evidence: [{ kind: "code", ref: "src/auth.ts:7" }],
  });

  await test("a fresh run gets the summary, the artifactId and the read-back call", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildTaskInsertionPrompt({
      brief,
      diff,
      banked: bankedRef,
      recurrence: {
        kind: "fresh",
        source: "none",
        priorFindings: [],
        priorFindingIds: [],
        previouslyReported: [],
      },
    });
    assertIncludes(
      prompt,
      "stage-output-diff-local",
      "the artifactId is named",
    );
    assertIncludes(
      prompt,
      "retrieve_context(",
      "the read-back call is spelled out",
    );
    assertIncludes(prompt, "app.ts", "the per-file summary is inline");
    assertIncludes(
      prompt,
      "tasks_create",
      "the agent is told to create the checklist",
    );
    assertIncludes(
      prompt,
      "first review of this target",
      "freshness is stated",
    );
    assertIncludes(prompt, "sceptical about auth", "the brief is carried in");
  });

  await test("a recurring run is told what the last one left open", async () => {
    const mod = await import(DIST_ENTRY);
    const prompt = mod.buildTaskInsertionPrompt({
      brief,
      diff,
      banked: bankedRef,
      recurrence: {
        kind: "recurring",
        source: "run-report",
        lastReviewedSha: "deadbee",
        lastReviewedAt: "2026-08-01T00:00:00.000Z",
        priorFindings: [
          priorFinding("f1", "MAJOR"),
          priorFinding("f2", "MINOR"),
        ],
        priorFindingIds: ["f1", "f2"],
        previouslyReported: [{ findingId: "f1", commentId: "c1" }],
      },
    });
    assertIncludes(prompt, "reviewed before", "recurrence is stated");
    assertIncludes(prompt, "deadbee", "the last reviewed sha");
    assertIncludes(prompt, "f1", "every open finding is named");
    assertIncludes(prompt, "f2", "every open finding is named");
    assertIncludes(prompt, "priorFindings", "and must be accounted for by id");
    assertIncludes(
      prompt,
      "carried as STILL OPEN",
      "silence about one is not a fix",
    );
    assertIncludes(
      prompt,
      "Already commented on this target",
      "what has already been said is named",
    );
  });

  section("recurrence comes from the run store");

  await test("an empty store is fresh, and a prior run makes it recurring", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("recur", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      const fresh = await mod.detectRecurrence(paths, "run-2");
      assertEqual(fresh.kind, "fresh", "no prior report");
      assertEqual(fresh.source, "none", "nothing to read from");

      await mod.writeRunReport(paths, {
        runId: "run-1",
        mode: "local",
        target: { mode: "local" },
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:05:00.000Z",
        headSha: "deadbee",
        stages: [],
        tasks: [],
        degradations: [],
      });
      await mod.writeLedger(paths, {
        updatedAt: "2026-08-01T00:05:00.000Z",
        findings: [
          {
            id: "f1",
            file: "app.ts",
            line: 1,
            severity: "MINOR",
            category: "style",
            summary: "s",
            impact: "i",
            evidence: [],
          },
        ],
      });

      const again = await mod.detectRecurrence(paths, "run-2");
      assertEqual(again.kind, "recurring", "a prior run makes this recurring");
      assertEqual(again.lastReviewedSha, "deadbee", "the sha to diff from");
      assertEqual(
        again.priorFindingIds.join(","),
        "f1",
        "prior findings to classify",
      );
    });
  });

  await test("re-reading the store inside the same run is still fresh", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("recur", async (dir) => {
      const paths = mod.storePathsForDir(dir);
      await mod.ensureStore(paths);
      await mod.writeRunReport(paths, {
        runId: "run-1",
        mode: "local",
        target: { mode: "local" },
        startedAt: "2026-08-01T00:00:00.000Z",
        stages: [],
        tasks: [],
        degradations: [],
      });
      const state = await mod.detectRecurrence(paths, "run-1");
      assertEqual(
        state.kind,
        "fresh",
        "a run must not treat its own report as a prior run",
      );
    });
  });

  section("diff acquisition through the stage");

  await test("a local target is the working tree, untracked files included", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("diff", async (dir) => {
      await workspace(dir);
      const diff = await mod.acquireTargetDiff({
        runId: "run-1",
        target: { mode: "local" },
        root: dir,
        storeDir: dir,
        dryRun: true,
      });
      assert(
        diff.files.length > 0,
        "the uncommitted edit is part of the local diff",
      );
    });
  });

  await test("runReview refuses a directory that is not a git work tree", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("review", async (dir) => {
      await workspace(dir);
      await runCommand("rm", ["-rf", path.join(dir, ".git")], { cwd: dir });
      let message = "";
      try {
        await mod.runReview({
          runId: mod.newRunId(),
          target: { mode: "local" },
          root: dir,
          storeDir: path.join(dir, ".yama", "artifacts", "local"),
          dryRun: true,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(
        message,
        "not a git work tree",
        "the run must refuse to guess",
      );
    });
  });

  section("the agentic half — needs a provider");

  /** The fixture config asks for google-ai, so that is the credential this suite needs. */
  const providerKey = (): string | undefined =>
    process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  await test("WarmUp reads the rulebook through the fs tools and banks a brief", async () => {
    if (providerKey() === undefined) {
      throw new Skip(
        "no GOOGLE_AI_API_KEY — the WarmUp stage needs a live provider",
      );
    }
    const mod = await import(DIST_ENTRY);
    const { createEngine } = await import(distModule("engine/index.js"));
    await withTempDir("warmup-live", async (dir) => {
      await workspace(dir);
      const config = await mod.loadConfig(dir, { mode: "local" });
      const storeDir = path.join(dir, ".yama", "artifacts", "local");
      const paths = mod.storePathsForDir(storeDir);
      await mod.ensureStore(paths);

      const run = {
        runId: mod.newRunId(),
        target: { mode: "local" },
        root: dir,
        storeDir,
        dryRun: true,
      };
      const engine = createEngine(mod.buildEngineConfig(config, run));
      mod.registerFsTools({
        register: engine.registerTool,
        config: { root: dir },
      });
      const session = mod.createSessionRunner({
        engine,
        paths,
        sessionId: run.runId,
      });

      const brief = await mod.runWarmUp({ session, config });
      assert(
        String(brief.data.persona).length > 0,
        "the brief must say how this repository wants to be reviewed",
      );
      assert(
        brief.data.sources.some((source: string) =>
          source.includes("index.md"),
        ),
        "the brief must cite the rulebook file it actually read",
      );
      const banked = await mod.readStage(
        paths,
        "warmup",
        mod.OperatingBriefSchema,
      );
      assert(banked !== undefined, "the brief must be banked to the run store");
    });
  });

  await test("newRunId sorts by time and is safe in a file name", async () => {
    const mod = await import(DIST_ENTRY);
    const id = mod.newRunId(new Date("2026-08-25T10:20:30.400Z"));
    assertEqual(id, "run-2026-08-25T10-20-30-400Z", "run id");
    assert(!/[:.]/.test(id), "a run id must be safe as a path segment");
  });
}
