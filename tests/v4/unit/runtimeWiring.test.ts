import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnBinding } from "../../../src/v4/tools/progress.js";
import { buildWorkspaceTools } from "../../../src/v4/tools/workspace.js";
import { applyStageTools } from "../../../src/v4/core/ToolExposure.js";
import { normalizeComments } from "../../../src/v4/connections/Comments.js";
import { renderRunReport } from "../../../src/v4/core/RunReport.js";
import { runConfiguredChecks } from "../../../src/v4/checks/execute.js";
import { isForkPullRequest } from "../../../src/v4/config/defaults.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import { CheckSecurityError } from "../../../src/v4/checks/Runner.js";
import {
  authoredRuleIds,
  partitionLearned,
  writeLearnedRules,
  LEARNED_RULES_PATH,
} from "../../../src/v4/learn/KnowledgeWriter.js";
import type {
  CommandRunner,
  ResolvedConfig,
  RuntimeHost,
  YamaTool,
} from "../../../src/v4/types/index.js";

// ── progress binding ─────────────────────────────────────────────────────────

describe("report_progress — how a turn tells the pipeline what it did", () => {
  it("accumulates across several calls in one turn", async () => {
    const binding = createTurnBinding();
    binding.begin("orient");

    await binding.tool.execute({
      plan: { groups: [{ id: "g1", paths: ["a.ts"] }], declined: [] },
    });
    await binding.tool.execute({ completedGroups: ["g1"], claimedFindings: 2 });
    await binding.tool.execute({ claimedFindings: 1 });

    const progress = binding.drain();
    expect(progress.plan?.groups).toEqual([{ id: "g1", paths: ["a.ts"] }]);
    expect(progress.completedGroups).toEqual(["g1"]);
    expect(progress.claimedFindings).toBe(3);
  });

  it("latches done — a further call cannot un-finish a turn", async () => {
    const binding = createTurnBinding();
    binding.begin("review");
    await binding.tool.execute({ done: true });
    await binding.tool.execute({ completedGroups: ["g2"] });
    expect(binding.drain().done).toBe(true);
  });

  it("resets between turns", async () => {
    const binding = createTurnBinding();
    binding.begin("review");
    await binding.tool.execute({ done: true, claimedFindings: 5 });
    binding.begin("review");
    expect(binding.drain()).toMatchObject({ done: false, claimedFindings: 0 });
  });

  it("ignores malformed input rather than recording garbage", async () => {
    const binding = createTurnBinding();
    binding.begin("orient");
    await binding.tool.execute({
      completedGroups: ["ok", 42, null],
      plan: { groups: [{ id: "g1", paths: ["a"] }, { paths: ["b"] }] },
    });
    const progress = binding.drain();
    expect(progress.completedGroups).toEqual(["ok"]);
    expect(progress.plan?.groups).toEqual([{ id: "g1", paths: ["a"] }]);
  });
});

// ── stage-scoped tool exposure ───────────────────────────────────────────────

describe("stage tool exposure is a security control", () => {
  const tool = (name: string, stages: string[]): YamaTool => ({
    name,
    description: "",
    inputSchema: {},
    stages: stages as YamaTool["stages"],
    roles: ["main"],
    execute: async () => ({}),
  });

  it("registers only this stage's tools and unregisters the rest", () => {
    const registered: string[] = [];
    const unregistered: string[] = [];
    const host = {
      registerTool: (name: string) => registered.push(name),
      unregisterTool: (name: string) => {
        unregistered.push(name);
        return true;
      },
    } as unknown as RuntimeHost;

    const tools = [tool("read_file", ["review"]), tool("post_it", ["post"])];
    const visible = applyStageTools(host, tools, "review", "main");

    expect(visible.map((entry) => entry.name)).toEqual(["read_file"]);
    expect(registered).toEqual(["read_file"]);
    // A review turn reads attacker-controlled text; posting must be out of reach.
    expect(unregistered).toEqual(["post_it"]);
  });
});

// ── workspace tools ──────────────────────────────────────────────────────────

describe("workspace tools", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "yama-ws-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(root, ".env"), "SECRET=hunter2\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const tools = () => buildWorkspaceTools({ projectRoot: root });
  const byName = (name: string): YamaTool =>
    tools().find((tool) => tool.name === name)!;

  it("reads a file", async () => {
    const result = (await byName("read_file").execute({
      path: "src/a.ts",
    })) as {
      content: string;
    };
    expect(result.content).toContain("three");
  });

  it("reads a line range with line numbers", async () => {
    const result = (await byName("read_file").execute({
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
    })) as { content: string; totalLines: number };
    expect(result.content).toBe("2\ttwo\n3\tthree");
    expect(result.totalLines).toBe(4);
  });

  it("refuses to escape the repository", async () => {
    const result = (await byName("read_file").execute({
      path: "../../../etc/passwd",
    })) as { error: string };
    expect(result.error).toMatch(/outside the repository/);
  });

  it("refuses credential files inside the repository", async () => {
    const result = (await byName("read_file").execute({ path: ".env" })) as {
      error: string;
    };
    expect(result.error).toMatch(/protected location/);
  });

  it("refuses a mutating git subcommand", async () => {
    const result = (await byName("git").execute({
      command: "git push origin main",
    })) as { error: string };
    expect(result.error).toMatch(/read-only allow-list/);
  });

  it("refuses shell metacharacters in a git command", async () => {
    const result = (await byName("git").execute({
      command: "git log; rm -rf /",
    })) as { error: string };
    expect(result.error).toMatch(/metacharacter/);
  });

  it("runs an allowed git command", async () => {
    const result = (await byName("git").execute({
      command: "git --version",
    })) as { error?: string };
    // `--version` is a global flag with no subcommand: refused by design.
    expect(result.error).toMatch(/subcommand/);
  });

  it("search refuses a path outside the repository", async () => {
    const result = (await byName("search_code").execute({
      pattern: "x",
      path: "/etc",
    })) as { error: string };
    expect(result.error).toMatch(/outside the repository/);
  });
});

// ── check execution ──────────────────────────────────────────────────────────

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 x
+y
`;

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const defaults = optionalDefaults();
  return {
    version: 4,
    ai: { provider: "litellm" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
    ...defaults,
    ...overrides,
  } as ResolvedConfig;
}

const changeSet = buildChangeSet({
  diff: DIFF,
  excludePatterns: [],
  maxFiles: 100,
});

const pool = async <T>(tasks: Array<() => Promise<T>>): Promise<T[]> =>
  Promise.all(tasks.map((task) => task()));

describe("runConfiguredChecks — the security rules that are not tunable down", () => {
  const runner: CommandRunner = async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });

  const withChecks = (checks: unknown[], allowForks = false) =>
    config({
      checks: { enabled: true, allowForks, checks },
    } as Partial<ResolvedConfig>);

  it("refuses when the pull request edits a script a check runs", async () => {
    const diff = DIFF.replace(/src\/a\.ts/g, "scripts/lint.sh");
    await expect(
      runConfiguredChecks({
        config: withChecks([{ id: "lint", run: "bash scripts/lint.sh" }]),
        changeSet: buildChangeSet({ diff, excludePatterns: [], maxFiles: 100 }),
        projectRoot: "/repo",
        pool,
        runner,
      }),
    ).rejects.toBeInstanceOf(CheckSecurityError);
  });

  it("refuses when the pull request edits checks.yaml itself", async () => {
    const diff = DIFF.replace(/src\/a\.ts/g, ".yama/checks.yaml");
    await expect(
      runConfiguredChecks({
        config: withChecks([{ id: "lint", run: "echo" }]),
        changeSet: buildChangeSet({ diff, excludePatterns: [], maxFiles: 100 }),
        projectRoot: "/repo",
        pool,
        runner,
      }),
    ).rejects.toThrow(/modifies \.yama\/checks\.yaml/);
  });

  it("skips every check on a fork unless allowForks is on", async () => {
    const results = await runConfiguredChecks({
      config: withChecks([{ id: "lint", run: "echo" }]),
      changeSet,
      projectRoot: "/repo",
      pool,
      runner,
      isFork: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("skipped");
    expect(results[0].reason).toMatch(/fork/);
  });

  it("runs on a fork when allowForks is explicitly enabled", async () => {
    const results = await runConfiguredChecks({
      config: withChecks([{ id: "lint", run: "echo" }], true),
      changeSet,
      projectRoot: "/repo",
      pool,
      runner,
      isFork: true,
    });
    expect(results[0].status).toBe("passed");
  });

  it("returns a result for every enabled check, so none reads as silently absent", async () => {
    const results = await runConfiguredChecks({
      config: withChecks([
        { id: "a", run: "echo" },
        { id: "b", run: "echo", when: { paths: ["**/*.go"] } },
      ]),
      changeSet,
      projectRoot: "/repo",
      pool,
      runner,
    });
    expect(results.map((result) => result.checkId).sort()).toEqual(["a", "b"]);
    expect(results.find((result) => result.checkId === "b")?.status).toBe(
      "skipped",
    );
  });
});

describe("isForkPullRequest", () => {
  it("is a fork when head and base repositories differ", () => {
    expect(
      isForkPullRequest({
        GITHUB_HEAD_REPOSITORY: "someone/yama",
        GITHUB_REPOSITORY: "juspay/yama",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("is not a fork when they match", () => {
    expect(
      isForkPullRequest({
        GITHUB_HEAD_REPOSITORY: "juspay/yama",
        GITHUB_REPOSITORY: "juspay/yama",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("treats pull_request_target as a fork when it cannot tell", () => {
    expect(
      isForkPullRequest({
        GITHUB_EVENT_NAME: "pull_request_target",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

// ── comment normalisation ────────────────────────────────────────────────────

describe("normalizeComments — one shape from any VCS", () => {
  it("reads a GitHub-shaped list", () => {
    expect(
      normalizeComments([
        {
          id: 7,
          body: "hello",
          user: { login: "yama-bot" },
          path: "a.ts",
          line: 3,
        },
      ]),
    ).toEqual([
      { id: "7", body: "hello", author: "yama-bot", filePath: "a.ts", line: 3 },
    ]);
  });

  it("reads a Bitbucket-shaped envelope", () => {
    expect(
      normalizeComments({
        values: [
          { id: 1, content: { raw: "hi" }, user: { display_name: "Bot" } },
        ],
      }),
    ).toEqual([{ id: "1", body: "hi", author: "Bot" }]);
  });

  it("drops entries with no body rather than inventing one", () => {
    expect(
      normalizeComments([{ id: 1 }, { id: 2, body: "keep" }]),
    ).toHaveLength(1);
  });

  it("returns empty for anything unrecognisable", () => {
    expect(normalizeComments(null)).toEqual([]);
    expect(normalizeComments("nope")).toEqual([]);
  });
});

// ── run report ───────────────────────────────────────────────────────────────

describe("renderRunReport names specifics, never counts", () => {
  it("prints the missing item for a degraded stage", () => {
    const report = renderRunReport(
      {
        stages: {
          outcomes: [
            {
              stage: "post",
              status: "degraded",
              attempts: 2,
              missing: ["f1 — MAJOR src/a.ts:3"],
            },
          ],
          partial: true,
          degradedStages: ["post"],
        },
        verdict: {
          decision: "CHANGES_REQUESTED",
          reasons: ["1 major finding"],
          advisory: false,
        },
        checks: [],
        review: { turnLoopEnd: "agent-finished", turns: 3, interventions: [] },
        summaryPosted: false,
        statusRecorded: false,
      } as never,
      ["a warning"],
      [],
    );

    expect(report).toContain("f1 — MAJOR src/a.ts:3");
    expect(report).toContain("(2 attempts)");
    expect(report).toContain("Summary    NOT posted");
    expect(report).toContain("(partial run)");
    expect(report).toContain("a warning");
  });
});

// ── knowledge writer ─────────────────────────────────────────────────────────

describe("KnowledgeWriter keeps learned rules apart from authored ones", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yama-kw-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("treats everything as authored before any learned file exists", async () => {
    const ids = await authoredRuleIds(root, [
      { id: "a", title: "A", summary: "" },
    ]);
    expect([...ids]).toEqual(["a"]);
  });

  it("round-trips: what it writes it later recognises as learned", async () => {
    const learned = [{ id: "convention.x", title: "X", summary: "s" }];
    await writeLearnedRules(root, learned);

    const ids = await authoredRuleIds(root, [
      { id: "convention.x", title: "X", summary: "s" },
      { id: "hand.written", title: "H", summary: "s" },
    ]);
    expect([...ids]).toEqual(["hand.written"]);
  });

  it("writes under .yama/ so the git writer's scope check accepts it", async () => {
    const result = await writeLearnedRules(root, []);
    expect(result.paths).toEqual([LEARNED_RULES_PATH]);
    expect(LEARNED_RULES_PATH.startsWith(".yama/")).toBe(true);
  });

  it("partitions by id", () => {
    const { learned, authored } = partitionLearned(
      [
        { id: "a", title: "", summary: "" },
        { id: "b", title: "", summary: "" },
      ],
      new Set(["a"]),
    );
    expect(learned.map((rule) => rule.id)).toEqual(["b"]);
    expect(authored.map((rule) => rule.id)).toEqual(["a"]);
  });
});
