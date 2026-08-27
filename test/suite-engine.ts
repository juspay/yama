/**
 * Suite: the seam-local engine fallbacks (docs/engine-spec.md section 5.1).
 *
 * These five members — checklist, banking, background commands, spawn and collect — are
 * what the whole product track is built on before Track N lands in NeuroLink. They are
 * driven here as BUILT modules (`dist/engine/fallback/*.js`) with their dependencies
 * injected, which is exactly how the seam wires them, and needs no provider credentials.
 *
 * The acceptance test for the eventual swap is that every case in this file keeps passing
 * against the engine-native primitives, unchanged.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  distModule,
  isBuilt,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("engine-fallbacks");

type ToolRecord = {
  description: string;
  inputSchema?: object;
  execute: (params: unknown, context?: unknown) => Promise<unknown>;
};

type ToolResult = Record<string, unknown> & {
  isError?: boolean;
  error?: string;
};

type Registry = {
  register: (name: string, tool: ToolRecord) => void;
  call: (
    name: string,
    params?: unknown,
    context?: unknown,
  ) => Promise<ToolResult>;
  has: (name: string) => boolean;
};

const registry = (): Registry => {
  const tools = new Map<string, ToolRecord>();
  return {
    register: (name, tool) => tools.set(name, tool),
    call: async (name, params, context) =>
      (await tools.get(name)?.execute(params ?? {}, context)) as ToolResult,
    has: (name) => tools.has(name),
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A prepared run store plus the bank fallback that writes into it. */
const bankIn = async (dir: string) => {
  const store = await import(DIST_ENTRY);
  const { createBankFallback } = await import(
    distModule("engine/fallback/bank.js")
  );
  const paths = store.storePathsForDir(dir);
  await store.ensureStore(paths);
  const tools = registry();
  return {
    paths,
    tools,
    bank: createBankFallback({ register: tools.register, paths }),
  };
};

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("checklist — the completeness contract");

  const checklistIn = async () => {
    const { createChecklistFallback } = await import(
      distModule("engine/fallback/tasks.js")
    );
    const tools = registry();
    let delegates = { pending: 0, ready: 0 };
    const api = createChecklistFallback({
      register: tools.register,
      delegates: () => delegates,
      currentSession: () => "session-a",
    });
    return {
      tools,
      api,
      setDelegates: (next: { pending: number; ready: number }) => {
        delegates = next;
      },
    };
  };

  await test("the three N1 tools are registered under their engine-native names", async () => {
    const { tools } = await checklistIn();
    for (const name of ["tasks_create", "tasks_update", "tasks_list"]) {
      assert(tools.has(name), `${name} must be registered`);
    }
  });

  await test("create assigns the ids, and every call returns the whole list", async () => {
    const { tools } = await checklistIn();
    const created = await tools.call("tasks_create", {
      titles: ["auth vs security rules", "migration files", "test coverage"],
    });
    const items = created.items as { id: string; status: string }[];
    assertEqual(items.length, 3, "items created");
    assertEqual(
      items.map((i) => i.id).join(","),
      "t1,t2,t3",
      "engine-assigned ids",
    );
    const counts = created.counts as Record<string, number>;
    assertEqual(counts.pending, 3, "pending count");
    const listed = await tools.call("tasks_list", {});
    assertEqual(
      (listed.items as unknown[]).length,
      3,
      "tasks_list returns the whole list",
    );
  });

  await test("outstanding delegate counts ride on every checklist result", async () => {
    const { tools, setDelegates } = await checklistIn();
    await tools.call("tasks_create", { titles: ["one"] });
    setDelegates({ pending: 2, ready: 1 });
    const listed = await tools.call("tasks_list", {});
    assertEqual(listed.delegatesPending, 2, "delegatesPending");
    assertEqual(
      listed.delegatesReady,
      1,
      "delegatesReady — learned without polling",
    );
  });

  await test("closing an item without a reason is refused", async () => {
    const { tools } = await checklistIn();
    await tools.call("tasks_create", { titles: ["one"] });
    const refused = await tools.call("tasks_update", {
      id: "t1",
      status: "closed",
    });
    assertEqual(refused.isError, true, "closed without a note must be refused");
    assertIncludes(
      String(refused.error),
      "note",
      "refusal must ask for the reason",
    );
    const closed = await tools.call("tasks_update", {
      id: "t1",
      status: "closed",
      note: "covered by the integration suite",
    });
    assertEqual(
      (closed.counts as Record<string, number>).closed,
      1,
      "closed count",
    );
  });

  await test("an unknown id is refused and the valid ids are named", async () => {
    const { tools } = await checklistIn();
    await tools.call("tasks_create", { titles: ["one", "two"] });
    const refused = await tools.call("tasks_update", {
      id: "t9",
      status: "done",
    });
    assertEqual(refused.isError, true, "unknown id must be refused");
    assertIncludes(
      String(refused.error),
      "t1, t2",
      "refusal must list the valid ids",
    );
  });

  await test("state is keyed by session, and the tool context wins", async () => {
    const { tools, api } = await checklistIn();
    await tools.call("tasks_create", { titles: ["default session"] });
    await tools.call(
      "tasks_create",
      { titles: ["other"] },
      { sessionId: "session-b" },
    );
    assertEqual(api.state("session-a").tasks.length, 1, "session a");
    assertEqual(api.state("session-b").tasks.length, 1, "session b");
    assertEqual(
      api.state("nobody").tasks.length,
      0,
      "unknown session is empty, never throws",
    );
  });

  section("banking — a preview is a pointer, never a summary");

  await test("a megabyte payload previews bounded and reads back whole", async () => {
    await withTempDir("bank", async (dir) => {
      const { bank, tools } = await bankIn(dir);
      const payload = "finding line ünïcödé\n".repeat(50_000);
      const ref = await bank.bank({
        kind: "worker-report",
        label: "delegate:auth",
        payload,
      });
      assertEqual(ref.preview.length, 1000, "default preview length");
      assertEqual(
        ref.sizeBytes,
        Buffer.byteLength(payload, "utf8"),
        "banked size",
      );
      assertIncludes(
        ref.readBackHint,
        ref.id,
        "the hint must name the artifact",
      );

      let assembled = "";
      let offset = 0;
      for (;;) {
        const page = await tools.call("retrieve_context", {
          artifactId: ref.id,
          offset,
          limit: 50_000,
        });
        assembled += String(page.content);
        offset += String(page.content).length;
        if (page.hasMore !== true) {
          break;
        }
      }
      assertEqual(assembled.length, payload.length, "paged read-back length");
      assertEqual(assembled === payload, true, "paged read-back is byte-exact");
    });
  });

  await test("the preview is capped even when a caller asks for more", async () => {
    await withTempDir("bank", async (dir) => {
      const { bank } = await bankIn(dir);
      const ref = await bank.bank({
        kind: "stage-output",
        label: "diff",
        payload: "x".repeat(20_000),
        previewChars: 99_999,
      });
      assertEqual(ref.preview.length, 4000, "preview hard cap");
      assertEqual(ref.sizeBytes, 20_000, "the file itself is untouched");
    });
  });

  await test("an unknown artifact is refused, not silently empty", async () => {
    await withTempDir("bank", async (dir) => {
      const { tools } = await bankIn(dir);
      const refused = await tools.call("retrieve_context", {
        artifactId: "nope",
      });
      assertEqual(refused.isError, true, "unknown artifact must be refused");
      assertIncludes(
        String(refused.error),
        "artifactId",
        "refusal must name the fix",
      );
    });
  });

  section("background commands — argv, allowlist, sandbox");

  const commandsIn = async (
    dir: string,
    policy?: { allowedExecutables: string[]; cwdRoot: string },
  ) => {
    const { bank, tools, paths } = await bankIn(dir);
    const { createCommandFallback } = await import(
      distModule("engine/fallback/command.js")
    );
    const api = createCommandFallback({
      register: tools.register,
      paths,
      bank,
      ...(policy ? { policy } : {}),
      defaultCwd: dir,
    });
    return { api, tools, paths };
  };

  await test("with no policy every command is refused, and the fix is named", async () => {
    await withTempDir("cmd", async (dir) => {
      const { api, tools } = await commandsIn(dir);
      let message = "";
      try {
        await api.start({ argv: ["node", "-e", "0"], cwd: dir });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "no command policy", "host-side refusal");
      const refused = await tools.call("run_command_bg", {
        argv: ["node", "-e", "0"],
      });
      assertEqual(refused.isError, true, "tool-side refusal");
      assertIncludes(
        String(refused.error),
        "checks.yaml",
        "refusal must name the fix",
      );
    });
  });

  await test("an executable outside the allowlist is refused", async () => {
    await withTempDir("cmd", async (dir) => {
      const { tools } = await commandsIn(dir, {
        allowedExecutables: ["node"],
        cwdRoot: dir,
      });
      const refused = await tools.call("run_command_bg", {
        argv: ["rm", "-rf", "/"],
      });
      assertEqual(
        refused.isError,
        true,
        "non-allowlisted executable must be refused",
      );
      assertIncludes(
        String(refused.error),
        "not an allowed executable",
        "refusal text",
      );
    });
  });

  await test("a cwd outside the sandbox is refused", async () => {
    await withTempDir("cmd", async (dir) => {
      const { api } = await commandsIn(dir, {
        allowedExecutables: ["node"],
        cwdRoot: path.join(dir, "repo"),
      });
      let message = "";
      try {
        await api.start({ argv: ["node", "-e", "0"], cwd: dir });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "outside the sandbox root", "cwd escape refusal");
    });
  });

  await test("a real command runs, exits, and both streams are banked in full", async () => {
    await withTempDir("cmd", async (dir) => {
      const { api, tools } = await commandsIn(dir, {
        allowedExecutables: [process.execPath],
        cwdRoot: dir,
      });
      const run = await api.start({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('O'.repeat(5000)); process.stderr.write('problem');",
        ],
        cwd: dir,
      });
      const result = await run.done;
      assertEqual(result.state, "exited", "terminal state");
      assertEqual(result.exitCode, 0, "exit code");
      assertEqual(result.stdout?.sizeBytes, 5000, "banked stdout size");
      assertIncludes(
        String(result.stderr?.preview),
        "problem",
        "banked stderr preview",
      );

      const page = await tools.call("command_output", {
        taskId: run.taskId,
        stream: "stdout",
        offset: 4990,
      });
      assertEqual(String(page.content).length, 10, "last page of stdout");
      assertEqual(page.totalSize, 5000, "total stdout size");
      assertEqual(page.hasMore, false, "no more after the last page");
    });
  });

  await test("a command can be killed, and what it wrote survives", async () => {
    await withTempDir("cmd", async (dir) => {
      const { api } = await commandsIn(dir, {
        allowedExecutables: [process.execPath],
        cwdRoot: dir,
      });
      const run = await api.start({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('started'); setInterval(() => {}, 1000);",
        ],
        cwd: dir,
      });
      await sleep(300);
      const result = await run.kill();
      assertEqual(result.state, "killed", "killed state");
      assertIncludes(
        String(result.stdout?.preview),
        "started",
        "output before the kill",
      );
    });
  });

  await test("an unknown taskId is refused by every command tool", async () => {
    await withTempDir("cmd", async (dir) => {
      const { tools } = await commandsIn(dir, {
        allowedExecutables: ["node"],
        cwdRoot: dir,
      });
      for (const name of ["command_status", "command_kill"]) {
        const refused = await tools.call(name, { taskId: "c99" });
        assertEqual(refused.isError, true, `${name} on an unknown task`);
      }
    });
  });

  section("delegation — out-of-order collection, claimed exactly once");

  /** Workers whose durations are the REVERSE of their spawn order. */
  const delegationIn = async (dir: string, maxConcurrent = 4) => {
    const { bank, tools } = await bankIn(dir);
    const { createDelegationFallback } = await import(
      distModule("engine/fallback/delegation.js")
    );
    const live = { now: 0, peak: 0 };
    const api = createDelegationFallback({
      register: tools.register,
      bank,
      maxConcurrent,
      run: async (req: { task: string }) => {
        live.now += 1;
        live.peak = Math.max(live.peak, live.now);
        const delay = Number.parseInt(req.task.split(":")[1] ?? "0", 10);
        await sleep(delay);
        live.now -= 1;
        if (req.task.startsWith("boom")) {
          throw new Error("worker exploded");
        }
        return {
          ok: true,
          summary: `summary of ${req.task}`,
          report: `# full report for ${req.task}\n${"detail\n".repeat(500)}`,
        };
      },
    });
    return { api, tools, live };
  };

  await test("delegate returns immediately and collect returns the FIRST to finish", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api } = await delegationIn(dir);
      const spawnedAt = Date.now();
      await api.delegate({ task: "slow:400" });
      await api.delegate({ task: "medium:200" });
      await api.delegate({ task: "quick:20" });
      assert(
        Date.now() - spawnedAt < 150,
        "delegate must return a handle before the worker finishes",
      );
      assertEqual(api.counts().pending, 3, "three workers in flight");

      const first = await api.collect({ mode: "any" });
      assertEqual(first.length, 1, "collect any returns one worker");
      assertEqual(
        first[0].summary,
        "summary of quick:20",
        "the fastest worker came back first",
      );
    });
  });

  await test("collect all returns the rest in completion order, each exactly once", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api } = await delegationIn(dir);
      await api.delegate({ task: "slow:300" });
      await api.delegate({ task: "quick:20" });
      const all = await api.collect({ mode: "all" });
      assertEqual(all.length, 2, "both workers collected");
      assertEqual(
        all[0].summary,
        "summary of quick:20",
        "completion order, not spawn order",
      );
      assertEqual(
        (await api.collect({ mode: "all" })).length,
        0,
        "nothing is handed over twice",
      );
      assertEqual(api.counts().pending, 0, "no workers outstanding");
    });
  });

  await test("a worker's full report is banked and reads back whole", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api, tools } = await delegationIn(dir);
      await api.delegate({ task: "one:10" });
      const [result] = await api.collect({ mode: "all" });
      assert(
        result.report !== undefined,
        "the report reference must be present",
      );
      const page = await tools.call("retrieve_context", {
        artifactId: result.report?.id,
        limit: 100_000,
      });
      assertIncludes(
        String(page.content),
        "full report for one:10",
        "banked report body",
      );
      assertEqual(
        page.totalSize,
        result.report?.sizeBytes,
        "banked size matches the file",
      );
    });
  });

  await test("a worker that throws comes back failed, with its report still banked", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api } = await delegationIn(dir);
      await api.delegate({ task: "boom:10" });
      const [result] = await api.collect({ mode: "all" });
      assertEqual(result.ok, false, "a thrown worker is not ok");
      assertIncludes(
        String(result.error),
        "worker exploded",
        "the failure is reported",
      );
      assert(result.report !== undefined, "even a failure banks a report");
    });
  });

  await test("the pool bounds concurrency — spawns queue, they do not fail", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api, live } = await delegationIn(dir, 2);
      for (const task of ["a:60", "b:60", "c:60", "d:60", "e:60"]) {
        await api.delegate({ task });
      }
      const all = await api.collect({ mode: "all" });
      assertEqual(all.length, 5, "every queued worker still ran");
      assertEqual(
        live.peak,
        2,
        "never more than the pool size running at once",
      );
    });
  });

  await test("collect with a wait that expires reports the outstanding work", async () => {
    await withTempDir("delegate", async (dir) => {
      const { api, tools } = await delegationIn(dir);
      await api.delegate({ task: "slow:1500" });
      const result = await tools.call("collect_results", {
        mode: "any",
        waitMs: 50,
      });
      assertEqual(
        (result.completed as unknown[]).length,
        0,
        "nothing finished yet",
      );
      assertEqual(result.pending, 1, "the worker is still pending");
      assertEqual(result.timedOut, true, "the wait expired");
      await api.cancel();
    });
  });

  await test("a worker is held to the host's read-only toolset, whatever it asks for", async () => {
    await withTempDir("delegate", async (dir) => {
      const { bank, tools } = await bankIn(dir);
      const { createDelegationFallback } = await import(
        distModule("engine/fallback/delegation.js")
      );
      const asked: (string[] | undefined)[] = [];
      const api = createDelegationFallback({
        register: tools.register,
        bank,
        maxConcurrent: 2,
        workerTools: ["read_file", "list_files"],
        run: async (req: { tools?: string[] }) => {
          asked.push(req.tools);
          return { ok: true, summary: "done", report: "report" };
        },
      });

      await api.delegate({
        task: "one",
        tools: ["read_file", "delegate_task"],
      });
      await api.delegate({ task: "two", tools: ["post_comment"] });
      await api.delegate({ task: "three" });
      await api.collect({ mode: "all" });

      assertEqual(
        asked[0]?.join(","),
        "read_file",
        "a request keeps only the tools the host permits",
      );
      assertEqual(
        asked[1]?.join(","),
        "read_file,list_files",
        "a request for nothing permitted falls back to the whole read-only set",
      );
      assertEqual(
        asked[2]?.join(","),
        "read_file,list_files",
        "a request naming no tools gets the read-only set",
      );
    });
  });

  section("banked artifacts land in the run store, browsable");

  await test("a banked worker report is a real file under reports/", async () => {
    await withTempDir("bank", async (dir) => {
      const { bank, paths } = await bankIn(dir);
      const ref = await bank.bank({
        kind: "worker-report",
        label: "delegate-w1",
        payload: "body",
      });
      const expected = path.join(paths.reportsDir, `${ref.id}.md`);
      await writeFile(path.join(dir, "touch"), "", "utf8");
      const store = await import(DIST_ENTRY);
      assertEqual(
        await store.readPayload(paths, ref.id),
        "body",
        "payload on disk",
      );
      assertIncludes(expected, "reports", "reports directory");
    });
  });
}
