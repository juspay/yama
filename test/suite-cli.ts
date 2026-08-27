/**
 * Suite: CLI surface + config fixture (TASKS:0.5, Y6.1).
 *
 * Everything here drives the BUILT package — `node dist/cli/index.js` and
 * `dist/index.js` — per NeuroLink rule 15. `src/` is never imported.
 *
 * `review` is wired end to end now, so what this suite pins for it is the half a
 * subprocess can check without a provider: how the target is resolved, which exit
 * code each class of failure maps to, and that a run which dies still leaves its
 * report in the store. The stage flow itself is driven with a scripted engine in
 * `suite-work.ts`, `init` / `doctor` in `suite-platform.ts`, and `learn` in
 * `suite-learn.ts`. No stub command is left: every one of them does its job.
 *
 * Exit codes are written as literals on purpose. They are the CI contract from
 * `src/cli/exitCodes.ts` ("add codes, never renumber them"), so a renumbering
 * has to break this suite.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIST_ENTRY,
  FIXTURES,
  assert,
  assertEqual,
  assertExit,
  assertIncludes,
  defineSuite,
  distModule,
  gitWorkspace,
  isBuilt,
  runCLI,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("cli");

const MINI_REPO = path.join(FIXTURES, "mini-repo");

/**
 * The slice of `ResolvedConfig` this suite reads back. Declared locally and
 * structurally: the suite drives the BUILT package, which ships no importable
 * runtime types, and Yama's own types must not be reached into from `src/`.
 */
type ResolvedShape = {
  chains: Record<string, { provider: string; model?: string }[]>;
  yama: { pool: { tier: string } };
  capabilities: Record<string, { server: string; tool: string } | undefined>;
  degradations: { what: string; reason: string }[];
};

/** EXIT_CODES.ok — run finished (verdict approve/comment). */
const EXIT_OK = 0;
/** EXIT_CODES.configError — bad invocation, or `.yama/` missing / invalid. */
const EXIT_CONFIG = 2;
/** EXIT_CODES.runError — the run itself failed: engine, MCP, platform or check. */
const EXIT_RUN = 3;

/** Collapse runs of whitespace so column padding in the CLI output is not load-bearing. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("help and command set");

  await test("--help exits ok and names every command", async () => {
    const r = await runCLI(["--help"]);
    assertExit(r, EXIT_OK, "yama --help");
    for (const command of ["review", "learn", "init", "doctor"]) {
      assertIncludes(r.stdout, command, "help output");
    }
  });

  await test("--help is branded as yama, not as the node script", async () => {
    const r = await runCLI(["--help"]);
    assertExit(r, EXIT_OK, "yama --help");
    assertIncludes(flat(r.stdout), "yama <command>", "help usage line");
  });

  await test("review --help lists the documented flags", async () => {
    const r = await runCLI(["review", "--help"]);
    assertExit(r, EXIT_OK, "yama review --help");
    for (const flag of ["--pr", "--branch", "--dry-run", "--json"]) {
      assertIncludes(r.stdout, flag, "review help output");
    }
  });

  section("argument validation exits with the config-error code");

  await test("no command names the commands that do exist", async () => {
    const r = await runCLI([]);
    assertExit(r, EXIT_CONFIG, "yama with no command");
    assertIncludes(r.stderr, "Pick a command", "no-command error");
    assertIncludes(
      flat(r.stderr),
      "yama --help",
      "no-command error should point at help",
    );
  });

  await test("an unknown command is rejected (strict mode)", async () => {
    const r = await runCLI(["frobnicate"]);
    assertExit(r, EXIT_CONFIG, "yama frobnicate");
    assertIncludes(r.stderr, "Unknown argument", "unknown-command error");
  });

  await test("--pr and --branch are mutually exclusive, checked before the handler", async () => {
    const r = await runCLI(["review", "--pr", "1", "--branch", "feat/x"]);
    assertExit(r, EXIT_CONFIG, "yama review --pr --branch");
    assertIncludes(r.stderr, "mutually exclusive", "conflicting-target error");
    assert(
      !r.stdout.includes("yama review —"),
      "conflicting targets must fail validation, not reach the review handler",
    );
  });

  await test("learn demands --pr", async () => {
    const r = await runCLI(["learn"]);
    assertExit(r, EXIT_CONFIG, "yama learn without --pr");
    assertIncludes(
      r.stderr,
      "Missing required argument: pr",
      "learn validation error",
    );
  });

  await test("learn refuses a repository that never opted in", async () => {
    await withTempDir("cli-learn", async (dir) => {
      const r = await runCLI(["learn", "--pr", "7"], { cwd: dir });
      assertExit(r, EXIT_CONFIG, "yama learn with no .yama/");
      assertIncludes(
        r.stderr,
        "Nothing was committed or pushed",
        "a failed learn says plainly that it wrote nothing",
      );
    });
  });

  section("review resolves its target and reports where the run store is");

  /**
   * A directory with no `.yama/` — the target line is printed before anything is
   * loaded, so these cases pin target resolution AND the config-error exit in one.
   */
  const reviewWithoutConfig = (
    argv: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    withTempDir("cli-review", async (dir) => runCLI(argv, { cwd: dir }));

  await test("--pr N is echoed as the target", async () => {
    const r = await reviewWithoutConfig(["review", "--pr", "42"]);
    assertExit(r, EXIT_CONFIG, "yama review --pr 42 with no .yama/");
    assertIncludes(flat(r.stdout), "PR #42", "review target line");
  });

  await test("--branch X is echoed as the target", async () => {
    const r = await reviewWithoutConfig(["review", "--branch", "feat/x"]);
    assertExit(r, EXIT_CONFIG, "yama review --branch feat/x with no .yama/");
    assertIncludes(flat(r.stdout), "branch feat/x", "review target line");
  });

  await test("no target falls back to the local diff, and names its run store", async () => {
    const r = await reviewWithoutConfig(["review"]);
    assertExit(r, EXIT_CONFIG, "yama review with no .yama/");
    assertIncludes(flat(r.stdout), "local diff", "review target line");
    assertIncludes(
      flat(r.stdout),
      path.join(".yama", "artifacts", "local"),
      "the run store for a local target",
    );
  });

  await test("--dry-run says so before it starts", async () => {
    const r = await reviewWithoutConfig(["review", "--dry-run"]);
    assertExit(r, EXIT_CONFIG, "yama review --dry-run with no .yama/");
    assertIncludes(flat(r.stdout), "dry run", "dry-run line");
  });

  section("review exit codes and what survives a failure");

  await test("a missing .yama/ is a config error, with the fix named", async () => {
    const r = await reviewWithoutConfig(["review"]);
    assertExit(r, EXIT_CONFIG, "yama review with no .yama/");
    assertIncludes(r.stderr, "no config directory", "missing-.yama error");
    assertIncludes(r.stderr, "yama init", "the fix");
  });

  await test("a run that fails exits 3 and still banks its report", async () => {
    await withTempDir("cli-review", async (dir) => {
      // A provider that cannot exist, so the failure is the run's, not the config's,
      // and it happens the same way whether or not this machine holds credentials.
      await gitWorkspace(dir, {
        yamaYaml: [
          "models:",
          "  main:",
          "    provider: not-a-real-provider",
          "    model: nothing",
          "",
        ].join("\n"),
      });
      const r = await runCLI(["review", "--dry-run", "--json", "out.json"], {
        cwd: dir,
        timeoutMs: 60_000,
      });
      assertExit(r, EXIT_RUN, "yama review against an impossible provider");
      assertIncludes(r.stderr, "yama review failed", "the failure is loud");
      assertIncludes(r.stderr, "run store", "and says where the evidence is");

      const report = JSON.parse(
        await readFile(
          path.join(dir, ".yama", "artifacts", "local", "run.json"),
          "utf8",
        ),
      );
      assertEqual(report.mode, "local", "the report knows its target");
      assert(
        typeof report.error === "string" && report.error.length > 0,
        "a failed run records why it stopped",
      );
      assert(
        !existsSync(path.join(dir, "out.json")),
        "--json must not write a result the run never produced",
      );
    });
  });

  /**
   * The verdict → exit code map is proved over real verdicts in `suite-gates.ts`, but
   * nothing proved the CLI USES it. A `review` that always exits 0 passes every other
   * test in this file and quietly stops blocking anything in CI — which is the whole
   * point of the exit code. A subprocess cannot reach a verdict without a provider, so
   * this reads the SHIPPED artifact, the way `suite-learn.ts` reads the git writer to
   * prove no force flag survived into it.
   */
  await test("a finished review takes its exit code from the verdict, not a constant", async () => {
    const source = await readFile(distModule("cli/index.js"), "utf8");
    const start = source.indexOf('.command("review"');
    const end = source.indexOf('.command("init"');
    assert(
      start >= 0 && end > start,
      "the built CLI declares a review command",
    );
    const review = source.slice(start, end);
    assertIncludes(
      review,
      "exitCodeFor(result.verdict)",
      "the success path of yama review",
    );
    assert(
      !review.includes("EXIT_CODES.ok"),
      "a run that finished must be coded by the verdict, never by a success constant",
    );
    for (const code of ["EXIT_CODES.configError", "EXIT_CODES.runError"]) {
      assertIncludes(review, code, "the failure codes the CI contract names");
    }
  });

  section("config layout and the mini-repo fixture");

  await test("the fixture declares every required .yama file", async () => {
    const mod = await import(DIST_ENTRY);
    const configDir: unknown = mod.CONFIG_DIR;
    const configFiles: unknown = mod.CONFIG_FILES;
    assertEqual(typeof configDir, "string", "CONFIG_DIR export");
    assert(
      typeof configFiles === "object" && configFiles !== null,
      "CONFIG_FILES must be exported from the built library entry",
    );
    const files = configFiles as Record<string, string>;
    for (const key of ["yama", "mcp"] as const) {
      assertEqual(typeof files[key], "string", `CONFIG_FILES.${key}`);
      assert(
        existsSync(path.join(MINI_REPO, String(configDir), String(files[key]))),
        `fixture mini-repo is missing its required ${key} config file`,
      );
    }
  });

  await test("loadConfig normalizes the fixture into model chains", async () => {
    const mod = await import(DIST_ENTRY);
    assertEqual(typeof mod.loadConfig, "function", "loadConfig export");
    const config = (await mod.loadConfig(MINI_REPO, {
      mode: "local",
    })) as ResolvedShape;

    // Every role resolves to a chain, even the ones that only fall back.
    assertEqual(
      Object.keys(config.chains).sort().join(","),
      "main,summarizer,worker",
      "model chain roles",
    );
    // main: one value per link.
    assertEqual(config.chains.main.length, 2, "main chain length");
    assertEqual(
      config.chains.main[0]?.provider,
      "google-ai",
      "main link 1 provider",
    );
    assertEqual(
      config.chains.main[1]?.provider,
      "anthropic",
      "main link 2 provider",
    );
    // worker: a scalar provider broadcast across two models (TASKS:Y1.4).
    assertEqual(config.chains.worker.length, 2, "worker chain length");
    assertEqual(
      config.chains.worker[1]?.provider,
      "google-ai",
      "broadcast provider",
    );
    assertEqual(
      config.chains.worker[1]?.model,
      "gemini-2.0-flash",
      "worker link 2 model",
    );
    assertEqual(config.yama.pool.tier, "low", "pool tier");
  });

  await test("loadConfig binds declared capabilities and degrades the rest", async () => {
    const mod = await import(DIST_ENTRY);
    const config = (await mod.loadConfig(MINI_REPO, {
      mode: "local",
    })) as ResolvedShape;

    // Declared: capability -> "<server>.<tool>", split on the first dot.
    assertEqual(
      config.capabilities["pr.diff"]?.server,
      "git",
      "pr.diff server",
    );
    assertEqual(
      config.capabilities["pr.diff"]?.tool,
      "git_diff",
      "pr.diff tool",
    );
    // The fixture declares no posting capability (TASKS:Y5.1) — off, not broken.
    assertEqual(
      config.capabilities["comment.inline.create"],
      undefined,
      "undeclared posting capability",
    );

    // Absent optional pieces are degradations, never errors (TASKS:Y1.2).
    const off = config.degradations.map((d) => d.what);
    for (const what of ["checks", "rulebook", "memory", "verdict.set"]) {
      assert(
        off.includes(what),
        `absent optional piece "${what}" must be reported as a degradation`,
      );
    }
  });

  await test("loadConfig fails loudly when .yama/ is absent", async () => {
    const mod = await import(DIST_ENTRY);
    const noConfigRepo = path.join(MINI_REPO, "src");
    let message = "";
    try {
      await mod.loadConfig(noConfigRepo, { mode: "local" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(message, "no config directory", "missing-.yama error");
    assertIncludes(message, "yama init", "missing-.yama fix hint");
  });

  section("a finished command exits — CI reads the code, not the output");

  await test("a run that connected to an MCP server does not hold the job open", async () => {
    await withTempDir("cli-exit", async (dir) => {
      await gitWorkspace(dir);
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        [
          "servers:",
          "  forge:",
          "    transport: stdio",
          "    command: node",
          `    args: ["${path.join(FIXTURES, "fake-mcp-server.mjs")}"]`,
          "capabilities:",
          "  comment.list:",
          "    tool: forge.list_comments",
          "    args:",
          '      pull: "${pr}"',
          "",
        ].join("\n"),
        "utf8",
      );

      // An MCP server is a live child process, and nothing in the review path
      // disconnects it. Without an explicit exit the command prints its whole answer
      // and then never returns — CI kills the job on its own timeout and the exit
      // code, which is the only thing it reads, is lost.
      const result = await runCLI(["doctor", "--pr", "7"], {
        cwd: dir,
        timeoutMs: 25_000,
      });
      assert(
        !result.stderr.includes("[harness] timed out"),
        "the command exited by itself rather than being killed",
      );
      assertEqual(result.exitCode, EXIT_OK, "with the code doctor decided on");
      assertIncludes(
        result.stdout,
        "list_comments",
        "having really talked to the server first",
      );
    });
  });

  await test("init and doctor are wired to the commands, not to a stub", async () => {
    const help = await runCLI(["init", "--help"]);
    assertExit(help, EXIT_OK, "yama init --help");
    for (const flag of ["--platform", "--force"]) {
      assertIncludes(help.stdout, flag, "init help output");
    }
    const doctor = await runCLI(["doctor", "--help"]);
    assertExit(doctor, EXIT_OK, "yama doctor --help");
    assertIncludes(doctor.stdout, "--base", "doctor help output");
  });
}
