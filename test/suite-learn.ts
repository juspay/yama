/**
 * Suite: `yama learn` — the post-merge knowledge update (TASKS:Y7.2).
 *
 * This is the only command in Yama that can change a repository, so most of what is pinned
 * here is what it REFUSES to do: write outside `.yama/`, commit somebody else's staged
 * work, push through a URL with a token in it, or run twice off its own commit. The happy
 * path is asserted against a real git repository — a real `git commit` is made and read
 * back — because a write path proved only with mocks is a write path nobody has run.
 *
 * Nothing here needs a provider: the triage answer is scripted through the same schema the
 * seam would hold it to. No test ever pushes; every repository it touches is a temporary
 * directory with no remote, and the one push case asserts a REFUSAL.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  DIST_ENTRY,
  FIXTURES,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  distModule,
  isBuilt,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("learn");

const SYNTHETIC = path.join(FIXTURES, "synthetic-pr");

const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(SYNTHETIC, name), "utf8"));

/** `.yama/yama.yaml` for a repository that has opted into learning. */
const LEARN_YAMA = (extra: readonly string[] = []): string =>
  [
    "models:",
    "  main:",
    "    provider: google-ai",
    "    model: gemini-2.5-flash",
    "learn:",
    "  enabled: true",
    ...extra,
    "",
  ].join("\n");

const LEARN_MCP = [
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

/** A git repository that has been reviewed once and whose pull request has merged. */
const learnWorkspace = async (
  dir: string,
  options: { yamaYaml?: string } = {},
): Promise<void> => {
  await mkdir(path.join(dir, ".yama"), { recursive: true });
  await writeFile(
    path.join(dir, ".yama", "yama.yaml"),
    options.yamaYaml ?? LEARN_YAMA(),
    "utf8",
  );
  await writeFile(path.join(dir, ".yama", "mcp.yaml"), LEARN_MCP, "utf8");
  const git = (args: string[]) => runCommand("git", args, { cwd: dir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Yama Test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "app.ts"), "export const a = 1;\n", "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "the change that merged"]);
};

/** The triage a scripted model returns. Schema-valid, and deliberately opinionated. */
const TRIAGE = {
  resolutions: [
    {
      findingId: "auth-token-logged",
      resolution: "accepted",
      evidence: ["8805"],
      note: "fixed in 3f1a2b",
    },
    {
      findingId: "duplicate-helper",
      resolution: "dismissed",
      evidence: ["8804"],
      note: "legacy module is being deleted next sprint",
    },
    {
      findingId: "weak-hash",
      resolution: "unanswered",
      evidence: [],
      note: "nobody replied",
    },
  ],
  facts: [
    {
      id: "no-duplication-findings-in-legacy",
      kind: "suppression",
      statement:
        "Do not raise duplication findings against src/legacy/** — that module is being deleted.",
      rationale:
        'A reviewer said: "duplicating it here is deliberate. Please stop raising duplication against src/legacy/**".',
      scope: ["src/legacy/**"],
      sources: ["8804", "duplicate-helper"],
    },
    {
      id: "tokens-must-never-reach-logs",
      kind: "convention",
      statement: "Redact any token before it reaches a log line.",
      rationale: "The team fixed the reported case rather than arguing it.",
      scope: [],
      sources: ["8805", "auth-token-logged"],
    },
  ],
  summary:
    "Duplication in the legacy module is deliberate; token logging is not.",
};

/**
 * An engine whose model is scripted and whose platform is the synthetic pull request.
 * Every answer goes through the caller's own schema, exactly as the seam does.
 */
const learnEngine = async (options: { triage?: unknown } = {}) => {
  const comments = await readFixture("comments.json");
  const prompts: string[] = [];
  const toolCalls: { name: string; params: unknown }[] = [];
  const engine = {
    generateStructured: async (req: {
      prompt: string;
      schema: {
        safeParse: (value: unknown) => { success: boolean; data?: unknown };
      };
    }) => {
      prompts.push(req.prompt);
      const answer = "triage" in options ? options.triage : TRIAGE;
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
        },
      };
    },
    registerTool: () => undefined,
    connectMcp: async () => ["list_comments"],
    callTool: async (name: string, params: unknown) => {
      toolCalls.push({ name, params });
      return comments;
    },
    memoryStatus: () => ({ enabled: true, ready: true, tokenThreshold: 64000 }),
    tasksApi: async (sessionId: string) => ({ sessionId, tasks: [] }),
    delegate: async () => ({ workerId: "none" }),
    collect: async () => [],
    bankReport: async (req: { label: string; payload: string }) => ({
      id: `stage-output-${req.label}`,
      label: req.label,
      sizeBytes: req.payload.length,
      preview: req.payload.slice(0, 200),
      readBackHint: `retrieve_context({ artifactId: "stage-output-${req.label}" })`,
    }),
    backgroundRun: async () => {
      throw new Error("learn runs no commands");
    },
  };
  return { engine, prompts, toolCalls };
};

/** Seeds the run store for PR 7 with what the previous review left. */
const seedStore = async (dir: string): Promise<void> => {
  const mod = await import(DIST_ENTRY);
  const paths = mod.resolveStorePaths(dir, { mode: "pr", pr: 7 });
  await mod.ensureStore(paths);
  await mod.writeLedger(paths, await readFixture("prior-findings.json"));
};

const gitIn = (dir: string) => (args: string[]) =>
  runCommand("git", args, { cwd: dir });

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("learn is opt-in, and says so");

  await test("a repository that never set learn.enabled is refused before anything is read", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-off", async (dir) => {
      await learnWorkspace(dir, {
        yamaYaml: [
          "models:",
          "  main:",
          "    provider: google-ai",
          "    model: gemini-2.5-flash",
          "",
        ].join("\n"),
      });
      const { engine, toolCalls, prompts } = await learnEngine();
      let message = "";
      let hint = "";
      try {
        await mod.runLearn({ root: dir, pr: 7, dryRun: true }, engine);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        hint = String((error as { hint?: string }).hint ?? "");
      }
      assertIncludes(message, "learn is not enabled", "the refusal");
      assertIncludes(hint, "learn.enabled", "and the exact knob");
      assertEqual(toolCalls.length, 0, "no platform call was made");
      assertEqual(prompts.length, 0, "and no model call either");
    });
  });

  section("what learn reads, and what it banks before a model sees it");

  await test("the comments come from the capability, with the run's coordinates", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-read", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const { engine, toolCalls, prompts } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: true },
        engine,
      );
      assertEqual(toolCalls[0]?.name, "list_comments", "the resolved tool");
      assertEqual(
        JSON.stringify(toolCalls[0]?.params),
        JSON.stringify({ pull: "7" }),
        "with ${pr} filled from the target",
      );
      assertEqual(result.commentsRead, 5, "every comment on the thread");
      assertEqual(
        result.findingsKnown,
        3,
        "and what the review of it had found",
      );
      assertEqual(prompts.length, 1, "triage is ONE structured pass");
      // The id alone proves nothing: the banked thread's own preview quotes every
      // marker. What has to be in the prompt is the LEDGER's reading of the finding,
      // which only the findings list renders.
      assertIncludes(
        prompts[0],
        "reported 3 finding(s)",
        "the review's own findings are put in front of the triage",
      );
      assertIncludes(
        prompts[0],
        "auth-token-logged  CRITICAL  src/auth.ts:42",
        "each one with the severity and place the ledger recorded",
      );
      assertIncludes(
        prompts[0],
        "retrieve_context(",
        "the whole thread is banked and read back, never pasted",
      );
      assertIncludes(
        prompts[0],
        "only what a HUMAN decided",
        "and a fact has to come from a person",
      );
    });
  });

  await test("the verbatim engine answer is banked whatever became of it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-bank", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      // An answer that cannot pass the schema: the run must fail AND leave the evidence.
      const { engine } = await learnEngine({ triage: { facts: "not a list" } });
      let message = "";
      try {
        await mod.runLearn({ root: dir, pr: 7, dryRun: true }, engine);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "nothing schema-valid", "the failure");
      const paths = mod.resolveStorePaths(dir, { mode: "pr", pr: 7 });
      const banked = await readdir(paths.reportsDir);
      assert(
        banked.some((file) => file.startsWith("learn-pr-7")),
        "the answer that failed is exactly the one somebody needs to read",
      );
    });
  });

  section("the memory it writes is a document, not a database");

  await test("one file per fact, plus an index rebuilt from the directory", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-files", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );

      const facts = path.join(dir, ".yama", "memory", "facts");
      assert(
        existsSync(path.join(facts, "no-duplication-findings-in-legacy.md")),
        "the suppression has its own file, named by its id",
      );
      const suppression = await readFile(
        path.join(facts, "no-duplication-findings-in-legacy.md"),
        "utf8",
      );
      assertIncludes(suppression, "src/legacy/**", "carrying its scope");
      assertIncludes(
        suppression,
        "yama-fact:",
        "and its id, so disk is the truth",
      );
      assertIncludes(suppression, "pull request #7", "and where it came from");

      const index = await readFile(
        path.join(dir, ".yama", "memory", "index.md"),
        "utf8",
      );
      for (const fact of result.facts) {
        assertIncludes(index, fact.id, "every fact is in the index");
      }
      assertIncludes(index, "generated", "and the index says it is generated");
    });
  });

  await test("a fact deleted by hand disappears from the index on the next run", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-index", async (dir) => {
      const memory = path.join(dir, ".yama", "memory", "facts");
      await mkdir(memory, { recursive: true });
      await writeFile(
        path.join(memory, "kept-by-hand.md"),
        "# A human wrote this\n\n- yama-fact: kept-by-hand\n- kind: knowledge\n",
        "utf8",
      );
      const onDisk = await mod.readFactFiles(path.join(dir, ".yama", "memory"));
      const index = mod.renderMemoryIndex(onDisk, [
        {
          id: "new-one",
          kind: "convention",
          statement: "Something new.",
          rationale: "r",
          scope: [],
          sources: [],
        },
      ]);
      assertIncludes(index, "kept-by-hand", "a hand-written fact is listed");
      assertIncludes(index, "A human wrote this", "with its own statement");
      assertIncludes(index, "new-one", "alongside what this run learned");
      assert(
        !index.includes("deleted-fact"),
        "and nothing that is not on disk",
      );
    });
  });

  section(
    "the commit plan is the whole write, decided before anything is written",
  );

  await test("a dry run computes everything and changes nothing", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-dry", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const before = (await gitIn(dir)(["rev-parse", "HEAD"])).stdout.trim();

      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: true },
        engine,
      );

      assertEqual(result.write.dryRun, true, "it was a dry run");
      assertEqual(result.write.written.length, 0, "nothing was written");
      assertEqual(result.write.commit, undefined, "nothing was committed");
      assertEqual(result.write.pushed, false, "nothing was pushed");
      assertIncludes(String(result.write.skipped), "dry-run", "and it says so");

      // The plan is complete even though nothing happened — that is the point of it.
      assertEqual(result.write.plan.branch, "main", "the branch it would use");
      assertIncludes(
        result.write.plan.subject,
        "[skip ci]",
        "the subject cannot re-trigger CI",
      );
      assertIncludes(result.write.plan.subject, "#7", "and names the PR");
      assertEqual(
        result.write.plan.paths.length,
        3,
        "two fact files and the index",
      );
      for (const staged of result.write.plan.paths) {
        assert(
          staged.startsWith(".yama/"),
          "every path in the plan is inside .yama/",
        );
      }
      assertEqual(result.write.plan.refusals.length, 0, "nothing objected");
      assertEqual(result.write.plan.push, false, "push is off by default");

      assert(
        !existsSync(path.join(dir, ".yama", "memory", "index.md")),
        "the memory directory was not created",
      );
      assertEqual(
        (await gitIn(dir)(["rev-parse", "HEAD"])).stdout.trim(),
        before,
        "and HEAD did not move",
      );
      // The run store is the only thing on disk that a dry run may create — it is where
      // the banked evidence goes, and CI carries it as an artifact rather than committing it.
      const status = (await gitIn(dir)(["status", "--porcelain"])).stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.endsWith(".yama/artifacts/"));
      assertEqual(
        status.join(" | "),
        "",
        "a dry run changes nothing but the run store",
      );
    });
  });

  await test("a real run makes exactly one commit, touching only .yama/", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-commit", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );

      assert(result.write.commit !== undefined, "a commit was made");
      assertEqual(result.write.pushed, false, "and nothing was pushed");

      const subject = (
        await gitIn(dir)(["log", "-1", "--format=%s"])
      ).stdout.trim();
      assertIncludes(subject, "[skip ci]", "the commit cannot re-trigger CI");
      assertIncludes(subject, "chore(yama):", "and is prefixed as configured");

      const touched = (
        await gitIn(dir)(["show", "--name-only", "--format=", "HEAD"])
      ).stdout
        .split("\n")
        .filter((line) => line.trim() !== "");
      assert(touched.length > 0, "the commit has files in it");
      for (const file of touched) {
        assert(
          file.startsWith(".yama/memory/"),
          "a learn commit touches nothing but the memory",
        );
      }
      const body = (await gitIn(dir)(["log", "-1", "--format=%b"])).stdout;
      assertIncludes(body, "legacy module", "the summary is the commit body");
    });
  });

  await test("it refuses to commit work somebody else staged", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-foreign", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      // Somebody's half-finished edit, already staged in this checkout.
      await writeFile(
        path.join(dir, "app.ts"),
        "export const a = 99;\n",
        "utf8",
      );
      await gitIn(dir)(["add", "app.ts"]);

      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );
      assertEqual(result.write.commit, undefined, "nothing was committed");
      assertIncludes(
        String(result.write.skipped),
        "outside .yama/",
        "and it names the rule it will not break",
      );
      assertIncludes(String(result.write.skipped), "app.ts", "and the file");

      const staged = await gitIn(dir)(["diff", "--cached", "--name-only"]);
      assertIncludes(
        staged.stdout,
        "app.ts",
        "the other person's staged work is left exactly as it was",
      );
      assert(
        !staged.stdout.includes(".yama/memory"),
        "and the memory files were unstaged again",
      );
    });
  });

  await test("it refuses to push through a URL carrying a credential", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-creds", async (dir) => {
      await learnWorkspace(dir, {
        yamaYaml: LEARN_YAMA(["  push: true"]),
      });
      await seedStore(dir);
      await gitIn(dir)([
        "remote",
        "add",
        "origin",
        "https://someone:ghp_notarealtoken@example.invalid/repo.git",
      ]);

      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );
      assertEqual(result.write.commit, undefined, "nothing was committed");
      assertEqual(result.write.pushed, false, "and nothing was pushed");
      assertIncludes(
        String(result.write.skipped),
        "credentials embedded in its URL",
        "the refusal names what is wrong",
      );
      assertIncludes(
        String(result.write.skipped),
        "credential helper",
        "and what to do instead",
      );
      assert(
        !String(result.write.skipped).includes("ghp_notarealtoken"),
        "and the refusal does not repeat the secret back",
      );
    });
  });

  await test("a second learn off its own commit is a loop, and is refused", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-loop", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const { engine } = await learnEngine();
      const first = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );
      assert(first.write.commit !== undefined, "the first run committed");

      const second = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );
      assertEqual(second.write.commit, undefined, "the second one did not");
      assertIncludes(
        String(second.write.skipped),
        "already this exact learn commit",
        "and says the loop is why",
      );
    });
  });

  await test("learning nothing new is an outcome, not a failure", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-noop", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      // Production's case (juspay/yama #91, #92, #93): memory already exists from
      // an earlier merge, and this pull request's discussion holds no durable
      // fact. Nothing is rendered but the index, which rebuilds to exactly what
      // is already committed — so there is nothing TO commit, which is an
      // OUTCOME, not the refusal a bare `skipped` reported it as.
      const seeded = await learnEngine();
      const first = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        seeded.engine,
      );
      assert(
        first.write.commit !== undefined,
        "the earlier merge wrote memory",
      );

      // Someone else's commit, so this run is not sitting on learn's own.
      await gitIn(dir)([
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "chore: unrelated work",
      ]);

      const { engine } = await learnEngine({
        triage: {
          resolutions: [],
          facts: [],
          summary: "nothing in this discussion was worth keeping",
        },
      });
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: false },
        engine,
      );
      assertEqual(result.write.commit, undefined, "nothing was committed");
      assertEqual(
        result.write.nothingToCommit,
        true,
        "and the result says there was nothing TO commit",
      );
      assertIncludes(
        String(result.write.skipped),
        "identical",
        "the reason still reads plainly",
      );
      assertIncludes(
        mod.renderLearnResult(result),
        "NOTHING NEW",
        "and it prints as an outcome, not as a refusal",
      );
    });
  });

  await test("a detached HEAD names the knob that fixes it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-detached", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const sha = (await gitIn(dir)(["rev-parse", "HEAD"])).stdout.trim();
      await gitIn(dir)(["checkout", "-q", "--detach", sha]);

      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: true },
        engine,
      );
      assertIncludes(
        result.write.plan.refusals.join(" "),
        "learn.branch",
        "CI checks pull requests out detached, and the fix is named",
      );
    });
  });

  section("the shipped write path has no way to force anything");

  await test("no force flag exists anywhere in the built git writer", async () => {
    const source = await readFile(distModule("tools/gitWriter.js"), "utf8");
    for (const flag of ["--force", "-f", "force-with-lease", "reflog"]) {
      assert(
        !source.includes(`"${flag}"`),
        `the shipped writer must never pass ${flag} to git`,
      );
    }
    assertIncludes(source, '"push"', "it does push");
    assert(
      !source.includes("credential.helper") &&
        !source.includes("http.extraheader"),
      "and it never writes a credential into git configuration",
    );
  });

  section("what learn prints");

  await test("the summary names what was read, learned and done", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("learn-render", async (dir) => {
      await learnWorkspace(dir);
      await seedStore(dir);
      const { engine } = await learnEngine();
      const result = await mod.runLearn(
        { root: dir, pr: 7, dryRun: true },
        engine,
      );
      const text = mod.renderLearnResult(result);
      assertIncludes(text, "5 comment(s)", "what it read");
      assertIncludes(text, "1 accepted", "what the discussion settled");
      assertIncludes(text, "1 dismissed", "including the disagreement");
      assertIncludes(text, "suppression", "what kind of fact came out of it");
      assertIncludes(text, "[skip ci]", "the commit it would make");
      assertIncludes(text, "NOT DONE", "and that it did not make it");
    });
  });
}
