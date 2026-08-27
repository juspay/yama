/**
 * Suite: the run store (TASKS:Y2.3).
 *
 * Everything here drives `dist/index.js`. The store is the project's memory between
 * stages and between runs, so what this suite pins is the two contracts that make it
 * trustworthy: a payload survives a round trip byte for byte, and a file that is present
 * but corrupt fails loudly instead of being silently rebuilt over.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  DIST_ENTRY,
  assert,
  assertEqual,
  assertIncludes,
  defineSuite,
  isBuilt,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("store");

/** The slice of the store surface this suite reads back, declared structurally. */
type StoreApi = {
  runStoreSlug: (target: unknown) => string;
  resolveStorePaths: (root: string, target: unknown) => Record<string, string>;
  storePathsForDir: (dir: string) => Record<string, string>;
  ensureStore: (paths: unknown) => Promise<void>;
  writeStage: (paths: unknown, envelope: unknown) => Promise<string>;
  readStage: (
    paths: unknown,
    stage: string,
    schema: unknown,
  ) => Promise<{ data: unknown; stage: string } | undefined>;
  writePayload: (
    paths: unknown,
    label: string,
    payload: string,
  ) => Promise<{ id: string; file: string }>;
  readPayload: (paths: unknown, id: string) => Promise<string | undefined>;
  readLedger: (paths: unknown) => Promise<{ findings: unknown[] }>;
  writeLedger: (paths: unknown, ledger: unknown) => Promise<string>;
  readRunReport: (
    paths: unknown,
  ) => Promise<Record<string, unknown> | undefined>;
  writeRunReport: (paths: unknown, report: unknown) => Promise<string>;
};

const load = async (): Promise<StoreApi> => {
  const mod = await import(DIST_ENTRY);
  return mod as StoreApi;
};

const REPORT = {
  runId: "run-1",
  mode: "local",
  target: { mode: "local" },
  startedAt: "2026-08-25T00:00:00.000Z",
  headSha: "abc123",
  stages: [],
  tasks: [],
  degradations: [],
};

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("layout");

  await test("the slug names the target, and is safe in a path", async () => {
    const store = await load();
    assertEqual(store.runStoreSlug({ mode: "local" }), "local", "local slug");
    assertEqual(store.runStoreSlug({ mode: "pr", pr: 42 }), "pr-42", "pr slug");
    assertEqual(
      store.runStoreSlug({ mode: "branch", branch: "feat/a b" }),
      "branch-feat-a-b",
      "branch slug with a slash and a space",
    );
  });

  await test("resolveStorePaths puts the run under .yama/artifacts/<slug>", async () => {
    const store = await load();
    const paths = store.resolveStorePaths("/repo", { mode: "pr", pr: 7 });
    assertEqual(
      paths.dir,
      path.join("/repo", ".yama", "artifacts", "pr-7"),
      "run directory",
    );
    assertEqual(paths.stagesDir, path.join(paths.dir, "stages"), "stages dir");
    assertEqual(
      paths.reportsDir,
      path.join(paths.dir, "reports"),
      "reports dir",
    );
    assertEqual(paths.checksDir, path.join(paths.dir, "checks"), "checks dir");
    assertEqual(
      paths.runFile,
      path.join(paths.dir, "run.json"),
      "run report file",
    );
  });

  await test("ensureStore creates the whole skeleton and is idempotent", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(path.join(dir, "run"));
      await store.ensureStore(paths);
      await store.ensureStore(paths);
      for (const key of [
        "stagesDir",
        "reportsDir",
        "checksDir",
        "workersDir",
      ]) {
        const found = await store.readPayload(paths, "nothing");
        assertEqual(found, undefined, "absent payload reads as undefined");
        assert(typeof paths[key] === "string", `${key} must be a path`);
      }
    });
  });

  section("stage envelopes");

  await test("a stage envelope round-trips through its own schema", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      const schema = z.object({
        persona: z.string(),
        rules: z.array(z.string()),
      });
      await store.writeStage(paths, {
        stage: "warmup",
        data: { persona: "careful", rules: ["a", "b"] },
        trusted: true,
        truncated: false,
        completedAt: "2026-08-25T00:00:00.000Z",
      });
      const back = await store.readStage(paths, "warmup", schema);
      assert(
        back !== undefined,
        "the stage that was just written must read back",
      );
      assertEqual(back?.stage, "warmup", "stage name");
      assertEqual(
        JSON.stringify(back?.data),
        JSON.stringify({ persona: "careful", rules: ["a", "b"] }),
        "stage payload",
      );
    });
  });

  await test("an absent stage is undefined, not an error", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      const back = await store.readStage(paths, "collate", z.object({}));
      assertEqual(back, undefined, "unwritten stage");
    });
  });

  await test("a payload that no longer fits its schema is a loud failure", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      await store.writeStage(paths, {
        stage: "warmup",
        data: { persona: 7 },
        completedAt: "2026-08-25T00:00:00.000Z",
      });
      let message = "";
      try {
        await store.readStage(
          paths,
          "warmup",
          z.object({ persona: z.string() }),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(
        message,
        "no longer fits its schema",
        "schema-drift error",
      );
      assertIncludes(message, "warmup.json", "the error must name the file");
    });
  });

  await test("a corrupt store file names itself instead of being rebuilt over", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      await writeFile(paths.runFile, "{ not json", "utf8");
      let message = "";
      try {
        await store.readRunReport(paths);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "is not valid JSON", "corrupt-report error");
      assertIncludes(message, "run.json", "the error must name the file");
    });
  });

  section("banked payloads");

  await test("a megabyte payload comes back byte for byte", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      const payload = "line of diff — ünïcödé\n".repeat(45_000);
      const { id, file } = await store.writePayload(
        paths,
        "worker-report:auth",
        payload,
      );
      const onDisk = await readFile(file, "utf8");
      assertEqual(onDisk.length, payload.length, "banked file length");
      const back = await store.readPayload(paths, id);
      assertEqual(back, payload, "read-back payload");
    });
  });

  await test("the label becomes a browsable file name", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      const { id } = await store.writePayload(
        paths,
        "delegate:worker 1/2",
        "x",
      );
      assertEqual(id, "delegate-worker-1-2", "slugified label");
    });
  });

  section("ledger and run report");

  await test("an absent ledger reads as empty, and a written one round-trips", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      assertEqual(
        (await store.readLedger(paths)).findings.length,
        0,
        "empty ledger",
      );
      await store.writeLedger(paths, {
        updatedAt: "2026-08-25T00:00:00.000Z",
        findings: [
          {
            id: "f1",
            file: "src/auth.ts",
            line: 12,
            severity: "MAJOR",
            category: "security",
            summary: "token is logged",
            impact: "credentials reach the log sink",
            evidence: [{ kind: "code", ref: "src/auth.ts:12-13" }],
          },
        ],
      });
      const back = await store.readLedger(paths);
      assertEqual(back.findings.length, 1, "ledger size after write");
    });
  });

  await test("the run report round-trips, carrying the head sha for the next run", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await store.ensureStore(paths);
      await store.writeRunReport(paths, REPORT);
      const back = await store.readRunReport(paths);
      assertEqual(back?.runId, "run-1", "run id");
      assertEqual(back?.headSha, "abc123", "head sha");
    });
  });

  await test("a run report missing a required field is rejected on read", async () => {
    const store = await load();
    await withTempDir("store", async (dir) => {
      const paths = store.storePathsForDir(dir);
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.runFile, JSON.stringify({ runId: "x" }), "utf8");
      let message = "";
      try {
        await store.readRunReport(paths);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(
        message,
        "does not match its schema",
        "invalid-report error",
      );
    });
  });
}
