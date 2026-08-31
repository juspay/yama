/**
 * Suite: the ENGINE-NATIVE seam (docs/engine-spec.md sections 1–4, TASKS:N1–N4).
 *
 * `src/engine/` now has two implementations behind five of its members, chosen by
 * `ENGINE_NATIVE`. `suite-engine.ts` holds the seam-local fallbacks to the contract; this
 * one holds NeuroLink's own primitives to the SAME contract, and then proves the thing that
 * actually makes the swap safe: both paths register the same model-visible tool names and
 * answer with the same envelope, so every prompt, stage and gate above the seam is
 * untouched by the choice.
 *
 * Driven as BUILT modules with a real `NeuroLink` instance. Only the live-delegation case
 * needs a provider; everything else is mechanical and must always run.
 */
import { NeuroLink } from "@juspay/neurolink";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  REPO_ROOT,
  Skip,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  distModule,
  isBuilt,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("engine-native");

/** Every tool name the seam puts in front of the model, on either path. */
const SEAM_TOOLS = [
  "tasks_create",
  "tasks_update",
  "tasks_list",
  "delegate_task",
  "collect_results",
  "retrieve_context",
  "run_command_bg",
  "command_status",
  "command_output",
  "command_kill",
] as const;

/**
 * A literal only the probe below banks, so "the engine read it back" cannot be satisfied by
 * some other artifact left in NeuroLink's process-wide store by an earlier case.
 */
const BANK_MARKER = "engine-native-routing-probe";

/** A prepared run store plus a live host to hang the native adapters off. */
const hostIn = async (dir: string) => {
  const store = await import(DIST_ENTRY);
  const paths = store.storePathsForDir(dir);
  await store.ensureStore(paths);
  return { store, paths, nl: new NeuroLink(), session: `native-${Date.now()}` };
};

/**
 * Boots `createEngine` in a SUBPROCESS under a given `YAMA_ENGINE_NATIVE`, because the flag
 * is read once at module load — which is the point of it. Reports the seam members and
 * which tool names answered, so the two paths can be compared as data.
 */
const bootSeam = async (
  native: boolean,
  dir: string,
): Promise<{ flag: boolean; members: string[]; answered: string[] }> => {
  const script = `
    const path = require("node:path");
    (async () => {
      const seam = await import(${JSON.stringify(distModule("engine/index.js"))});
      const store = await import(${JSON.stringify(DIST_ENTRY)});
      const dir = ${JSON.stringify(dir)};
      await store.ensureStore(store.storePathsForDir(dir));
      const engine = seam.createEngine({
        model: { provider: "google-ai", model: "gemini-2.5-flash" },
        systemPrompt: "system",
        storeDir: dir,
        commandPolicy: { allowedExecutables: ["/bin/echo"], cwdRoot: dir },
        workerTools: ["read_file", "list_files", "retrieve_context"],
      });
      const answered = [];
      for (const name of ${JSON.stringify(SEAM_TOOLS)}) {
        try {
          await engine.callTool(name, {});
          answered.push(name);
        } catch { /* an unregistered tool throws; that is the finding */ }
      }
      process.stdout.write("\\nYAMA_SEAM " + JSON.stringify({
        flag: seam.ENGINE_NATIVE,
        members: Object.keys(engine).sort(),
        answered,
      }) + "\\n");
      process.exit(0);
    })();
  `;
  const result = await runCommand("node", ["-e", script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
      // Set explicitly in BOTH directions: an ambient YAMA_ENGINE_NATIVE would otherwise
      // be inherited and the "native" probe would quietly measure the fallback.
      YAMA_ENGINE_NATIVE: native ? "1" : "0",
    },
    timeoutMs: 90_000,
  });
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.startsWith("YAMA_SEAM "));
  assert(line !== undefined, "the seam probe printed no result line");
  return JSON.parse((line ?? "").slice("YAMA_SEAM ".length));
};

/**
 * Banks one payload through the seam in a SUBPROCESS under a given `YAMA_ENGINE_NATIVE`,
 * then asks an unrelated, freshly constructed `NeuroLink` whether it knows that id.
 *
 * That answer is the ONE thing the two paths disagree about. Engine-native banking goes
 * through `nl.bankArtifact`, so the payload lands in NeuroLink's own store and its
 * file-backed index (TASKS:N3.3) hands it to any host in any process; the fallback writes
 * `<storeDir>/reports/<id>.md`, which the engine has never heard of. Everything else about
 * the two paths is identical on purpose — the tool names, the result envelopes, the seam
 * members — which is exactly why the ROUTING needs a probe that is not about any of them.
 */
const bootBank = async (
  native: boolean,
  dir: string,
): Promise<{ flag: boolean; engineReadsItBack: boolean }> => {
  const script = `
    (async () => {
      const { NeuroLink } = await import("@juspay/neurolink");
      const seam = await import(${JSON.stringify(distModule("engine/index.js"))});
      const store = await import(${JSON.stringify(DIST_ENTRY)});
      const dir = ${JSON.stringify(dir)};
      await store.ensureStore(store.storePathsForDir(dir));
      const engine = seam.createEngine({
        model: { provider: "google-ai", model: "gemini-2.5-flash" },
        systemPrompt: "system",
        storeDir: dir,
      });
      const marker = ${JSON.stringify(BANK_MARKER)};
      const ref = await engine.bankReport({
        kind: "stage-output",
        label: "which implementation banked this",
        payload: marker + " — banked whole, never truncated",
      });
      const whole = await new NeuroLink().readArtifact(ref.id).catch(() => null);
      process.stdout.write("\\nYAMA_BANK " + JSON.stringify({
        flag: seam.ENGINE_NATIVE,
        engineReadsItBack: typeof whole === "string" && whole.includes(marker),
      }) + "\\n");
      process.exit(0);
    })();
  `;
  const result = await runCommand("node", ["-e", script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
      YAMA_ENGINE_NATIVE: native ? "1" : "0",
    },
    timeoutMs: 90_000,
  });
  const line = result.stdout
    .split("\n")
    .find((entry) => entry.startsWith("YAMA_BANK "));
  assert(line !== undefined, "the banking probe printed no result line");
  return JSON.parse((line ?? "").slice("YAMA_BANK ".length));
};

/** NeuroLink wraps every registered tool's result; the payload is on `.data`. */
const unwrap = (envelope: unknown): Record<string, unknown> => {
  const record =
    envelope && typeof envelope === "object"
      ? (envelope as Record<string, unknown>)
      : {};
  const data = record.data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : record;
};

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("the swap is a non-event: both paths, one contract");

  await test("both paths expose the same ten seam members", async () => {
    await withTempDir("seam-native", async (nativeDir) => {
      await withTempDir("seam-fallback", async (fallbackDir) => {
        const native = await bootSeam(true, nativeDir);
        const fallback = await bootSeam(false, fallbackDir);
        assertEqual(native.flag, true, "ENGINE_NATIVE default");
        assertEqual(
          fallback.flag,
          false,
          "YAMA_ENGINE_NATIVE=0 flips the flag",
        );
        assertEqual(
          native.members.join(","),
          fallback.members.join(","),
          "seam members must not depend on the implementation",
        );
        assertEqual(
          native.members.length,
          10,
          "the Engine surface is ten members",
        );
      });
    });
  });

  await test("both paths register the same model-visible tool names", async () => {
    await withTempDir("tools-native", async (nativeDir) => {
      await withTempDir("tools-fallback", async (fallbackDir) => {
        const native = await bootSeam(true, nativeDir);
        const fallback = await bootSeam(false, fallbackDir);
        assertEqual(
          native.answered.join(","),
          SEAM_TOOLS.join(","),
          "every seam tool answers on the engine-native path",
        );
        assertEqual(
          fallback.answered.join(","),
          native.answered.join(","),
          "the two paths must present identical tool names",
        );
      });
    });
  });

  await test("the default path is the ENGINE's primitives, not the fallbacks", async () => {
    await withTempDir("routing-native", async (nativeDir) => {
      await withTempDir("routing-fallback", async (fallbackDir) => {
        const native = await bootBank(true, nativeDir);
        const fallback = await bootBank(false, fallbackDir);
        assertEqual(native.flag, true, "ENGINE_NATIVE default");
        assertEqual(
          fallback.flag,
          false,
          "YAMA_ENGINE_NATIVE=0 flips the flag",
        );
        assertEqual(
          native.engineReadsItBack,
          true,
          "the default path must bank through the engine, so an unrelated host reads it",
        );
        // The mirror. Without it the case passes on a probe that can never say yes —
        // a `readArtifact` that always returned null would prove the routing either way.
        assertEqual(
          fallback.engineReadsItBack,
          false,
          "the fallback path banks into the run store, which the engine never sees",
        );
      });
    });
  });

  section("the engine's own checklist (N1)");

  await test("the session the stage declares is the session the checklist lands in", async () => {
    await withTempDir("native-tasks", async (dir) => {
      const { nl, session } = await hostIn(dir);
      const { createChecklistNative } = await import(
        distModule("engine/native/tasks.js")
      );
      const api = createChecklistNative({ nl });
      // Exactly what `createStructuredCall` does before every stage checkpoint.
      nl.setToolContext({ sessionId: session });
      await nl.executeTool("tasks_create", {
        titles: ["auth rules", "migrations"],
      });
      // The tool context moves on — a later stage, or Delivery — before the run report
      // reads the checklist back. The read must follow the id it was given, not the host.
      nl.setToolContext({ sessionId: "some-later-stage" });
      const state = api.state(session);
      assertEqual(state.sessionId, session, "state is keyed by the session");
      assertEqual(state.tasks.length, 2, "items created");
      assertEqual(
        state.tasks.map((task: { id: string }) => task.id).join(","),
        "t1,t2",
        "ids are the engine's, never the model's",
      );
    });
  });

  await test("an update reaches the host read, note and all", async () => {
    await withTempDir("native-tasks-update", async (dir) => {
      const { nl, session } = await hostIn(dir);
      const { createChecklistNative } = await import(
        distModule("engine/native/tasks.js")
      );
      const api = createChecklistNative({ nl });
      nl.setToolContext({ sessionId: session });
      await nl.executeTool("tasks_create", { titles: ["one", "two"] });
      await nl.executeTool("tasks_update", {
        id: "t1",
        status: "done",
        note: "read it",
      });
      const [first, second] = api.state(session).tasks;
      assertEqual(first.status, "done", "t1 status");
      assertEqual(first.note, "read it", "t1 note");
      assertEqual(second.status, "pending", "t2 untouched");
    });
  });

  await test("closing an item without a reason is refused", async () => {
    await withTempDir("native-tasks-close", async (dir) => {
      const { nl, session } = await hostIn(dir);
      const { createChecklistNative } = await import(
        distModule("engine/native/tasks.js")
      );
      const api = createChecklistNative({ nl });
      nl.setToolContext({ sessionId: session });
      await nl.executeTool("tasks_create", { titles: ["one"] });
      const refusal = unwrap(
        await nl.executeTool("tasks_update", { id: "t1", status: "closed" }),
      );
      assertEqual(refusal.isError, true, "a silent close is a refusal");
      assertEqual(
        api.state(session).tasks[0].status,
        "pending",
        "the refused close did not land",
      );
    });
  });

  await test("two sessions are two checklists, and clear drops one", async () => {
    await withTempDir("native-tasks-sessions", async (dir) => {
      const { nl } = await hostIn(dir);
      const { createChecklistNative } = await import(
        distModule("engine/native/tasks.js")
      );
      const api = createChecklistNative({ nl });
      nl.setToolContext({ sessionId: "run-a" });
      await nl.executeTool("tasks_create", { titles: ["a1", "a2"] });
      nl.setToolContext({ sessionId: "run-b" });
      await nl.executeTool("tasks_create", { titles: ["b1"] });
      assertEqual(api.state("run-a").tasks.length, 2, "run-a is its own list");
      assertEqual(api.state("run-b").tasks.length, 1, "run-b is its own list");
      assertEqual(api.clear("run-a"), true, "clear reports what it dropped");
      assertEqual(api.state("run-a").tasks.length, 0, "run-a is gone");
      assertEqual(api.state("run-b").tasks.length, 1, "run-b survived");
    });
  });

  await test("an unknown session reads empty rather than throwing", async () => {
    await withTempDir("native-tasks-unknown", async (dir) => {
      const { nl } = await hostIn(dir);
      const { createChecklistNative } = await import(
        distModule("engine/native/tasks.js")
      );
      const api = createChecklistNative({ nl });
      assertEqual(
        api.state("never-existed").tasks.length,
        0,
        "empty checklist",
      );
      assertEqual(api.clear("never-existed"), false, "nothing to drop");
    });
  });

  section("banking outlives the engine's temp directory (N3)");

  const bankIn = async (dir: string) => {
    const context = await hostIn(dir);
    const { createBankNative } = await import(
      distModule("engine/native/bank.js")
    );
    return {
      ...context,
      bank: createBankNative({
        nl: context.nl,
        paths: context.paths,
        currentSession: () => context.session,
      }),
    };
  };

  await test("the preview is bounded and the payload is not", async () => {
    await withTempDir("native-bank", async (dir) => {
      const { bank } = await bankIn(dir);
      const payload = "y".repeat(200_000);
      const ref = await bank.bank({
        kind: "worker-report",
        label: "big",
        payload,
      });
      assertEqual(ref.sizeBytes, 200_000, "the whole payload is accounted for");
      assert(
        ref.preview.length <= 4_001,
        "the preview must stay inside the 4000-character ceiling",
      );
      assertIncludes(
        ref.readBackHint,
        "retrieve_context(",
        "the read-back call is spelled out",
      );
      assertIncludes(ref.readBackHint, ref.id, "the hint names the artifact");
      assertEqual(
        (await bank.read(ref.id))?.length,
        200_000,
        "nothing was discarded",
      );
    });
  });

  await test("the run store carries a byte-exact copy, keyed by the engine's id", async () => {
    await withTempDir("native-bank-mirror", async (dir) => {
      const { bank, store, paths } = await bankIn(dir);
      const payload = `head\n${"z".repeat(50_000)}\ntail`;
      const ref = await bank.bank({
        kind: "command-output",
        label: "check-lint",
        payload,
      });
      const mirrored = await store.readPayload(paths, ref.id);
      assertEqual(mirrored, payload, "the mirrored copy must be byte-exact");
      assertEqual(
        store.payloadPath(paths, ref.id).startsWith(paths.reportsDir),
        true,
        "the copy lands in the run store's reports directory",
      );
    });
  });

  await test("a payload the engine has dropped is still readable from the store", async () => {
    await withTempDir("native-bank-durable", async (dir) => {
      const { bank, nl } = await bankIn(dir);
      const payload = "the evidence for finding auth-token-logged";
      const ref = await bank.bank({
        kind: "worker-report",
        label: "durable",
        payload,
      });
      // A CI job that restores the run store has no tmpdir from the run that wrote it.
      await nl.getArtifactStore().delete(ref.id);
      assertEqual(
        await bank.read(ref.id),
        payload,
        "the run store is the durable copy",
      );
    });
  });

  await test("read pages precisely, and an unknown id is undefined", async () => {
    await withTempDir("native-bank-page", async (dir) => {
      const { bank } = await bankIn(dir);
      const ref = await bank.bank({
        kind: "stage-output",
        label: "paged",
        payload: "ABCDEFGHIJ",
      });
      assertEqual(
        await bank.read(ref.id, { offset: 3, limit: 4 }),
        "DEFG",
        "offset and limit address the payload",
      );
      assertEqual(
        await bank.read("no-such-artifact"),
        undefined,
        "a missing artifact is undefined, never an empty string",
      );
    });
  });

  await test("read-back is the engine's own retrieve_context, no Yama tool needed", async () => {
    await withTempDir("native-bank-tool", async (dir) => {
      const { bank, nl } = await bankIn(dir);
      const payload = "0123456789".repeat(1_000);
      const ref = await bank.bank({
        kind: "worker-report",
        label: "readback",
        payload,
      });
      const page = unwrap(
        await nl.executeTool("retrieve_context", {
          artifactId: ref.id,
          offset: 0,
          limit: 25,
        }),
      );
      assertEqual(
        page.totalSize,
        payload.length,
        "totalSize is the whole file",
      );
      assertEqual(page.hasMore, true, "hasMore says there is more to read");
      assertEqual(String(page.content).length, 25, "the page respects limit");
    });
  });

  section("background commands are a contract the engine enforces (N4)");

  const commandsIn = async (
    dir: string,
    policy?: { allowedExecutables: string[]; cwdRoot: string },
  ) => {
    const context = await hostIn(dir);
    const { createCommandNative } = await import(
      distModule("engine/native/command.js")
    );
    return {
      ...context,
      commands: createCommandNative({
        nl: context.nl,
        paths: context.paths,
        currentSession: () => context.session,
        ...(policy !== undefined ? { policy } : {}),
      }),
    };
  };

  /** Whatever a refusal arrived as, the message is what the caller has to act on. */
  const refusalOf = async (body: () => Promise<unknown>): Promise<string> => {
    try {
      await body();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  };

  await test("no policy means nothing runs, and the message names the fix", async () => {
    await withTempDir("native-cmd-nopolicy", async (dir) => {
      const { commands } = await commandsIn(dir);
      const message = await refusalOf(() =>
        commands.start({ argv: ["/bin/echo", "hi"], cwd: dir }),
      );
      assertIncludes(
        message,
        ".yama/checks.yaml",
        "the refusal must name the file that fixes it",
      );
    });
  });

  await test("an executable outside the allowlist is refused by name", async () => {
    await withTempDir("native-cmd-allow", async (dir) => {
      const { commands } = await commandsIn(dir, {
        allowedExecutables: ["/bin/echo"],
        cwdRoot: dir,
      });
      const message = await refusalOf(() =>
        commands.start({ argv: ["/bin/ls"], cwd: dir }),
      );
      assertIncludes(message, "/bin/ls", "the refusal names what was refused");
      assertIncludes(message, "/bin/echo", "and what is permitted instead");
    });
  });

  await test("a cwd outside the sandbox root is refused", async () => {
    await withTempDir("native-cmd-cwd", async (dir) => {
      const root = path.join(dir, "repo");
      await mkdir(root, { recursive: true });
      const { commands } = await commandsIn(dir, {
        allowedExecutables: ["/bin/echo"],
        cwdRoot: root,
      });
      const message = await refusalOf(() =>
        // The parent of the sandbox root: a real directory, and out of bounds.
        commands.start({ argv: ["/bin/echo", "hi"], cwd: dir }),
      );
      assertIncludes(
        message,
        "outside",
        "the refusal must say the cwd left the root",
      );
      assertIncludes(message, root, "and name the root it left");
    });
  });

  await test("a real run banks both streams and the run store keeps them", async () => {
    await withTempDir("native-cmd-run", async (dir) => {
      const { commands, store, paths } = await commandsIn(dir, {
        allowedExecutables: ["/bin/sh"],
        cwdRoot: dir,
      });
      const run = await commands.start({
        argv: ["/bin/sh", "-c", "echo out; echo err 1>&2; exit 3"],
        cwd: dir,
      });
      const settled = await run.done;
      assertEqual(settled.state, "exited", "the command settled");
      assertEqual(settled.exitCode, 3, "the exit code is the verdict");
      assert(settled.stdout !== undefined, "stdout must be banked");
      assert(settled.stderr !== undefined, "stderr must be banked");
      assertEqual(
        (await store.readPayload(paths, settled.stdout?.id ?? "")) ?? "",
        "out\n",
        "the run store carries stdout",
      );
      assertEqual(
        (await store.readPayload(paths, settled.stderr?.id ?? "")) ?? "",
        "err\n",
        "the run store carries stderr",
      );
    });
  });

  await test("output pages rather than truncates", async () => {
    await withTempDir("native-cmd-page", async (dir) => {
      const { commands } = await commandsIn(dir, {
        allowedExecutables: ["/bin/sh"],
        cwdRoot: dir,
      });
      const run = await commands.start({
        argv: ["/bin/sh", "-c", "printf 'ABCDEFGHIJ'"],
        cwd: dir,
      });
      await run.done;
      const page = await run.output({ stream: "stdout", offset: 2, limit: 3 });
      assertEqual(page.content, "CDE", "the page is the window asked for");
      assertEqual(page.totalSize, 10, "totalSize is the whole stream");
      assertEqual(page.hasMore, true, "hasMore says there is more");
    });
  });

  await test("a killed command keeps everything it had already written", async () => {
    await withTempDir("native-cmd-kill", async (dir) => {
      const { commands, store, paths } = await commandsIn(dir, {
        allowedExecutables: ["/bin/sh"],
        cwdRoot: dir,
      });
      const run = await commands.start({
        argv: ["/bin/sh", "-c", "echo before; sleep 45"],
        cwd: dir,
      });
      // Give the child long enough to have written its first line.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const settled = await run.kill();
      assert(
        settled.state === "killed" || settled.state === "exited",
        "a killed command settles rather than hanging",
      );
      assertIncludes(
        (await store.readPayload(paths, settled.stdout?.id ?? "")) ?? "",
        "before",
        "what was written before the kill survives it",
      );
    });
  });

  await test("commands do not leak across sessions or paths", async () => {
    await withTempDir("native-cmd-scope", async (dir) => {
      const { commands } = await commandsIn(dir, {
        allowedExecutables: ["/bin/echo"],
        cwdRoot: dir,
      });
      const run = await commands.start({
        argv: ["/bin/echo", "scoped"],
        cwd: dir,
      });
      await run.done;
      assertEqual(
        commands.get(run.taskId)?.taskId,
        run.taskId,
        "the seam can find the run it started",
      );
      assertEqual(
        commands.get("c-never-started"),
        undefined,
        "and refuses to invent one it did not",
      );
    });
  });

  section("delegation (N2)");

  /**
   * A provider this machine can actually reach, or `undefined`. Vertex first, because that
   * is what the linked engine's own suites run on; the API-key form is the other shape a
   * developer is likely to have.
   */
  const liveModel = (): { provider: string; model: string } | undefined => {
    if (
      (process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "") !== "" &&
      (process.env.GOOGLE_CLOUD_PROJECT_ID ?? "") !== ""
    ) {
      return {
        provider: "vertex",
        model: process.env.VERTEX_MODEL ?? "gemini-2.5-flash",
      };
    }
    const key =
      process.env.GOOGLE_AI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    return (key ?? "") !== ""
      ? { provider: "google-ai", model: "gemini-2.5-flash" }
      : undefined;
  };

  const delegationIn = async (
    dir: string,
    model: { provider: string; model: string } = {
      provider: "google-ai",
      model: "gemini-2.5-flash",
    },
  ) => {
    const context = await hostIn(dir);
    const { createDelegationNative } = await import(
      distModule("engine/native/delegation.js")
    );
    return {
      ...context,
      delegation: createDelegationNative({
        nl: context.nl,
        paths: context.paths,
        model,
        systemPrompt: "Review code. Cite evidence.",
        maxConcurrent: 2,
        workerTools: ["read_file", "list_files", "retrieve_context"],
        currentSession: () => context.session,
      }),
    };
  };

  await test("collecting nothing is empty, never a failure", async () => {
    await withTempDir("native-delegate-empty", async (dir) => {
      const { delegation } = await delegationIn(dir);
      assertEqual(
        (await delegation.collect({ mode: "all", waitMs: 0 })).length,
        0,
        "no workers, no results",
      );
      assertEqual(
        (await delegation.collect({ workerId: "w-never", waitMs: 0 })).length,
        0,
        "an unknown worker is nothing new, not an exception",
      );
      assertEqual(delegation.counts().pending, 0, "nothing outstanding");
    });
  });

  await test("the host clamps a worker's toolset, whatever the model asked for", async () => {
    const { clampWorkerTools } = await import(distModule("engine/policy.js"));
    const permitted = ["read_file", "list_files", "retrieve_context"];
    assertEqual(
      clampWorkerTools(["read_file", "delegate_task"], permitted).join(","),
      "read_file",
      "a tool outside the permitted set is stripped",
    );
    assertEqual(
      clampWorkerTools(["delegate_task"], permitted).join(","),
      permitted.join(","),
      "a request that names nothing permitted gets the whole permitted set",
    );
    assertEqual(
      clampWorkerTools(undefined, permitted).join(","),
      permitted.join(","),
      "no request at all is the same answer",
    );
  });

  await test("a spawned worker comes back with its report banked in the run store", async () => {
    const live = liveModel();
    if (live === undefined) {
      throw new Skip(
        "no provider credentials — spawning a worker needs a live model",
      );
    }
    await withTempDir("native-delegate-live", async (dir) => {
      const { delegation, store, paths } = await delegationIn(dir, live);
      const handle = await delegation.delegate({
        task: "Reply with the single word ACKNOWLEDGED and nothing else.",
      });
      assert(handle.workerId.length > 0, "a spawn hands back a worker id");
      const results = await delegation.collect({ mode: "all", waitMs: 55_000 });
      assertEqual(results.length, 1, "the worker was collected exactly once");
      const [result] = results;
      assertEqual(result.workerId, handle.workerId, "the id round-trips");
      // Without this, the case passes on a worker that never ran: the engine settles a
      // failure into a claimable outcome with a banked report too, which is right, and
      // which makes "a report came back" no evidence at all that delegation works.
      assertEqual(result.ok, true, "the worker completed");
      assert(result.summary.length > 0, "a completed worker says something");
      assert(
        result.report !== undefined,
        "a collected worker always carries its banked report",
      );
      assertIncludes(
        result.report?.readBackHint ?? "",
        "retrieve_context(",
        "the report says how to read it back",
      );
      assert(
        ((await store.readPayload(paths, result.report?.id ?? "")) ?? "")
          .length > 0,
        "the run store carries the worker's full report",
      );
      assertEqual(
        (await delegation.collect({ mode: "all", waitMs: 0 })).length,
        0,
        "a claimed worker is claimed exactly once",
      );
    });
  });
}
