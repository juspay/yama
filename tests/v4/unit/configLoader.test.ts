import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  substituteEnv,
} from "../../../src/v4/config/Loader.js";
import { adaptV3Config } from "../../../src/v4/config/v3Compat.js";

let root: string;

const write = (relative: string, content: string): void => {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
};

const MINIMAL_YAMA = `version: 4
ai:
  provider: vertex
  model: claude-sonnet-4-6
`;

const MINIMAL_MCP = `servers:
  github:
    transport: http
    url: https://example.invalid/mcp
    capabilities:
      readPullRequest: get_pull_request
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yama-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("required files", () => {
  it("loads with only yama.yaml and mcp.yaml", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.version).toBe(4);
    expect(config.ai.provider).toBe("vertex");
    expect(config.mcp.servers.github.capabilities?.readPullRequest).toBe(
      "get_pull_request",
    );
  });

  it("fails with an actionable message when yama.yaml is missing", async () => {
    write(".yama/mcp.yaml", MINIMAL_MCP);
    await expect(loadConfig({ projectRoot: root, env: {} })).rejects.toThrow(
      /yama init/,
    );
  });

  it("fails when mcp.yaml is missing, explaining why it is needed", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    await expect(loadConfig({ projectRoot: root, env: {} })).rejects.toThrow(
      /cannot read a pull request without at least one server/,
    );
  });

  it("reports the failing path when a file is malformed", async () => {
    write(".yama/yama.yaml", "version: 3\nai: {provider: vertex}\n");
    write(".yama/mcp.yaml", MINIMAL_MCP);
    await expect(loadConfig({ projectRoot: root, env: {} })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("optionality — every absent file resolves to a no-op default", () => {
  beforeEach(() => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
  });

  it("defaults review, checks, ownership, guards and rules", async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.review.concurrency.power).toBe("medium");
    expect(config.review.verdict.enabled).toBe(true);
    expect(config.review.confidenceThreshold).toBe(80);
    expect(config.review.changedLinesOnly).toBe(true);
    expect(config.review.remediation.maxAttemptsPerStage).toBe(2);
    expect(config.checks.checks).toEqual([]);
    expect(config.ownership).toEqual([]);
    expect(config.guards).toEqual([]);
    expect(config.rules).toEqual([]);
  });

  it("keeps checks off for forks by default — untrusted code", async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.checks.allowForks).toBe(false);
  });

  it("disables learning by default until it is deliberately configured", async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.learn.trigger).toBe("disabled");
  });

  it("excludes lockfiles and build output without any config", async () => {
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.review.excludePatterns).toContain("**/pnpm-lock.yaml");
    expect(config.review.excludePatterns).toContain("**/dist/**");
  });
});

describe("optional files when present", () => {
  beforeEach(() => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
  });

  it("merges review.yaml over defaults without losing unset keys", async () => {
    write(
      ".yama/review.yaml",
      `concurrency: { power: high }\nconfidenceThreshold: 90\n`,
    );
    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.review.concurrency.power).toBe("high");
    expect(config.review.confidenceThreshold).toBe(90);
    // untouched defaults survive the merge
    expect(config.review.verdict.enabled).toBe(true);
    expect(config.review.remediation.maxAttemptsPerStage).toBe(2);
  });

  it("lets a project turn the verdict off entirely", async () => {
    write(".yama/review.yaml", `verdict: { enabled: false }\n`);
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.review.verdict.enabled).toBe(false);
  });

  it("replaces arrays rather than concatenating them", async () => {
    write(".yama/review.yaml", `excludePatterns: ["only/this/**"]\n`);
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.review.excludePatterns).toEqual(["only/this/**"]);
  });

  it("loads ownership and guards policy", async () => {
    write(
      ".yama/policy/ownership.yaml",
      `rules:
  - id: core
    paths: ["src/core/**"]
    owners: ["@alice"]
    minApprovals: 1
`,
    );
    write(
      ".yama/policy/guards.yaml",
      `guards:
  - id: payments
    paths: ["src/payments/**"]
    severityFloor: MAJOR
`,
    );
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.ownership[0].owners).toEqual(["@alice"]);
    expect(config.guards[0].severityFloor).toBe("MAJOR");
  });

  it("validates checks and rejects a check with both run and type", async () => {
    write(
      ".yama/checks.yaml",
      `checks:
  - id: lint
    run: "pnpm lint"
    type: builtin.owners
`,
    );
    await expect(loadConfig({ projectRoot: root, env: {} })).rejects.toThrow(
      /exactly one of/,
    );
  });
});

describe("rules directory", () => {
  beforeEach(() => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
  });

  it("loads rules recursively from single-rule and array files", async () => {
    write(
      ".yama/rules/naming.yaml",
      `id: naming.types
title: Types live in the types folder
summary: The folder is the types folder — config.ts, not config.types.ts
`,
    );
    write(
      ".yama/rules/nested/security.yaml",
      `rules:
  - id: sec.input
    title: Validate external input
    summary: Never trust query parameters
  - id: sec.secrets
    title: No hardcoded secrets
    summary: Secrets come from the environment
`,
    );
    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.rules.map((rule) => rule.id).sort()).toEqual([
      "naming.types",
      "sec.input",
      "sec.secrets",
    ]);
  });

  it("skips a malformed rule file loudly instead of failing the whole run", async () => {
    write(".yama/rules/good.yaml", `id: a\ntitle: A\nsummary: A rule\n`);
    write(".yama/rules/bad.yaml", `id: b\ntitle: B\n`); // missing summary

    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.rules.map((rule) => rule.id)).toEqual(["a"]);
    expect(
      config.notices.some(
        (notice) => notice.level === "warn" && /bad\.yaml/.test(notice.message),
      ),
    ).toBe(true);
  });

  it("warns on a duplicate rule id rather than silently overriding", async () => {
    write(".yama/rules/one.yaml", `id: dup\ntitle: One\nsummary: First\n`);
    write(".yama/rules/two.yaml", `id: dup\ntitle: Two\nsummary: Second\n`);

    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.rules).toHaveLength(1);
    expect(
      config.notices.some((notice) =>
        /Duplicate rule id "dup"/.test(notice.message),
      ),
    ).toBe(true);
  });
});

describe("environment overrides", () => {
  beforeEach(() => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
  });

  it("honours concurrency, verdict, checks and threshold", async () => {
    const config = await loadConfig({
      projectRoot: root,
      env: {
        YAMA_CONCURRENCY: "high",
        YAMA_VERDICT: "false",
        YAMA_CHECKS: "0",
        YAMA_CONFIDENCE_THRESHOLD: "95",
      },
    });
    expect(config.review.concurrency.power).toBe("high");
    expect(config.review.verdict.enabled).toBe(false);
    expect(config.checks.enabled).toBe(false);
    expect(config.review.confidenceThreshold).toBe(95);
  });

  it("ignores an out-of-range threshold rather than clamping silently", async () => {
    const config = await loadConfig({
      projectRoot: root,
      env: { YAMA_CONFIDENCE_THRESHOLD: "500" },
    });
    expect(config.review.confidenceThreshold).toBe(80);
  });

  it("does not expose rules or ownership to environment override", async () => {
    const config = await loadConfig({
      projectRoot: root,
      env: { YAMA_OWNERSHIP: "[]", YAMA_RULES: "[]" },
    });
    expect(config.ownership).toEqual([]);
    expect(config.rules).toEqual([]);
  });
});

describe("v3 compatibility", () => {
  it("loads a legacy single-file config and says so", async () => {
    write(
      "yama.config.yaml",
      `version: 2
ai:
  provider: vertex
  model: claude-sonnet-4-6
  explore:
    provider: vertex
    model: gemini-2.5-flash
mcpServers:
  servers:
    github:
      transport: http
      url: https://example.invalid/mcp
      roles: [review, explore]
      modes: [pr]
review:
  excludePatterns: ["dist/**"]
  maxFilesPerReview: 50
`,
    );

    const config = await loadConfig({ projectRoot: root, env: {} });

    expect(config.ai.provider).toBe("vertex");
    expect(config.review.excludePatterns).toEqual(["dist/**"]);
    expect(config.review.maxFiles).toBe(50);
    expect(
      config.notices.some((notice) => /yama migrate/.test(notice.message)),
    ).toBe(true);
  });

  it("prefers .yama/yama.yaml when both shapes exist", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write("yama.config.yaml", `version: 2\nai: { provider: legacy }\n`);

    const config = await loadConfig({ projectRoot: root, env: {} });
    expect(config.ai.provider).toBe("vertex");
  });
});

describe("adaptV3Config", () => {
  it("maps explore model onto the cheap v4 slots", () => {
    const adapted = adaptV3Config({
      ai: {
        provider: "vertex",
        model: "big",
        explore: { provider: "vertex", model: "small" },
      },
      mcpServers: { servers: {} },
    });
    const ai = adapted.yama.ai as Record<string, unknown>;
    expect(ai.subAgent).toEqual({ provider: "vertex", model: "small" });
    expect(ai.judge).toEqual({ provider: "vertex", model: "small" });
    expect(ai.compaction).toEqual({ provider: "vertex", model: "small" });
  });

  it("renames v3 roles and drops modes", () => {
    const adapted = adaptV3Config({
      ai: { provider: "vertex" },
      mcpServers: {
        servers: {
          github: { roles: ["review", "explore"], modes: ["pr"], url: "u" },
        },
      },
    });
    const servers = adapted.mcp.servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers.github.roles).toEqual(["main", "sub"]);
    expect(servers.github.modes).toBeUndefined();
  });

  it("infers capabilities for well-known servers", () => {
    const adapted = adaptV3Config({
      ai: { provider: "vertex" },
      mcpServers: { servers: { github: { url: "u" } } },
    });
    const servers = adapted.mcp.servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(
      (servers.github.capabilities as Record<string, string>).postInlineComment,
    ).toBe("create_pull_request_review_comment");
  });

  it("flags an unmappable server instead of guessing a tool name", () => {
    const adapted = adaptV3Config({
      ai: { provider: "vertex" },
      mcpServers: { servers: { "acme-custom": { command: "acme" } } },
    });
    const servers = adapted.mcp.servers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers["acme-custom"].capabilities).toBeUndefined();
    expect(
      adapted.notices.some((notice) =>
        /no capability map/.test(notice.message),
      ),
    ).toBe(true);
  });

  it("surfaces v3 prompt text as orphans rather than injecting it", () => {
    const adapted = adaptV3Config({
      ai: { provider: "vertex" },
      mcpServers: { servers: {} },
      review: {
        workflowInstructions: "Always check the ledger first.",
        focusAreas: [
          { name: "Security Analysis", description: "SQL injection" },
        ],
      },
    });

    expect(adapted.orphans).toHaveLength(2);
    expect(adapted.orphans[0].suggestedPath).toBe(
      ".yama/knowledge/workflow.md",
    );
    expect(adapted.orphans[1].suggestedPath).toBe(
      ".yama/knowledge/focus/security-analysis.md",
    );
    expect(
      adapted.notices.some((notice) =>
        /NOT being injected/.test(notice.message),
      ),
    ).toBe(true);
  });

  it("maps v3 verification modes onto the confidence threshold", () => {
    const strict = adaptV3Config({
      ai: { provider: "v" },
      mcpServers: { servers: {} },
      review: { verification: "strict" },
    });
    expect(strict.review?.confidenceThreshold).toBe(90);

    const off = adaptV3Config({
      ai: { provider: "v" },
      mcpServers: { servers: {} },
      review: { verification: "off" },
    });
    expect(off.review?.confidenceThreshold).toBe(0);
  });
});

describe("substituteEnv", () => {
  it("substitutes placeholders through nested structures", () => {
    const result = substituteEnv(
      {
        headers: { Authorization: "Bearer ${TOKEN}" },
        args: ["--k", "${KEY}"],
      },
      { TOKEN: "abc", KEY: "xyz" },
    );
    expect(result).toEqual({
      headers: { Authorization: "Bearer abc" },
      args: ["--k", "xyz"],
    });
  });

  it("leaves an unresolved placeholder intact so it can be reported precisely", () => {
    const result = substituteEnv({ url: "${MISSING}/path" }, {});
    expect(result.url).toBe("${MISSING}/path");
  });
});

describe("prompt management", () => {
  it("is off unless a repository asks for it", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root });
    // Enabled by default would make every run pay a network round trip for
    // prompts it already ships.
    expect(config.prompts.enabled).toBe(false);
  });

  it("reads the platform settings when one is configured", async () => {
    write(
      ".yama/yama.yaml",
      `${MINIMAL_YAMA}
prompts:
  enabled: true
  provider: langfuse
  label: production
  timeoutMs: 5000
  only: [yama-review, yama-judge]
`,
    );
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root });
    expect(config.prompts).toMatchObject({
      enabled: true,
      provider: "langfuse",
      label: "production",
      timeoutMs: 5000,
      only: ["yama-review", "yama-judge"],
    });
  });

  it("rejects a prompt id that does not exist", async () => {
    // A typo in `only:` would otherwise silently manage nothing, which looks
    // exactly like a platform that is working.
    write(
      ".yama/yama.yaml",
      `${MINIMAL_YAMA}
prompts:
  enabled: true
  only: [yama-reviewer]
`,
    );
    write(".yama/mcp.yaml", MINIMAL_MCP);

    await expect(loadConfig({ projectRoot: root })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("the product model", () => {
  it("is empty when the repository has never bootstrapped", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root });
    expect(config.product).toEqual([]);
    expect(config.impactLog).toEqual([]);
    // Absent is the documented "impact analysis degrades" state, not an error.
    expect(config.notices.filter((n) => n.level === "warn")).toEqual([]);
  });

  it("loads the capability map and the impact ledger", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write(
      ".yama/product/capabilities.yaml",
      `capabilities:
  - id: checkout
    name: Checkout
    paths: ["src/checkout/**"]
    userVisible: true
    failureMode: accepts the order but never charges
    criticality: high
`,
    );
    write(
      ".yama/product/impact-log/pr-10.yaml",
      `pullRequestId: 10
at: "2026-01-01T00:00:00Z"
capabilities: [checkout]
summary: reworked the charge path
`,
    );

    const config = await loadConfig({ projectRoot: root });
    expect(config.product).toHaveLength(1);
    expect(config.product[0].failureMode).toMatch(/never charges/);
    expect(config.impactLog).toHaveLength(1);
    // `at` is what the writer emits; `mergedAt` is the declared field.
    expect(config.impactLog[0].mergedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("reports a malformed capability map instead of matching nothing", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write(
      ".yama/product/capabilities.yaml",
      `capabilities:
  - name: missing an id
    paths: ["src/**"]
`,
    );

    const config = await loadConfig({ projectRoot: root });
    expect(config.product).toEqual([]);
    expect(
      config.notices.some(
        (notice) =>
          notice.level === "warn" && /capabilities\.yaml/.test(notice.message),
      ),
    ).toBe(true);
  });
});

describe("required description sections", () => {
  it("defaults to none", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    const config = await loadConfig({ projectRoot: root });
    expect(config.review.description.sections).toBeUndefined();
  });

  it("reads the sections a project requires", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write(
      ".yama/review.yaml",
      `description:
  sections:
    - { title: Testing, required: true }
    - { title: Rollback }
`,
    );

    const config = await loadConfig({ projectRoot: root });
    expect(config.review.description.sections).toEqual([
      { title: "Testing", required: true },
      { title: "Rollback" },
    ]);
  });
});

describe("keys that are accepted but do nothing", () => {
  it("says so when a config extends a baseline that is never loaded", async () => {
    // Silent, this is the worst kind of config key: the team writes it, the
    // baseline never loads, and every review runs on defaults while the file
    // says otherwise.
    write(
      ".yama/yama.yaml",
      `${MINIMAL_YAMA}
extends: "github:acme/yama-config@v2"
`,
    );
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root });
    expect(
      config.notices.some(
        (notice) =>
          notice.level === "warn" &&
          /extends.*is not implemented/.test(notice.message),
      ),
    ).toBe(true);
  });
});

describe("review tuning keys from the incident review", () => {
  it("defaults deletions to content and leaves the step cap unset", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);

    const config = await loadConfig({ projectRoot: root });
    // "content" is the original behaviour; absent config must not change it.
    expect(config.review.deletions).toBe("content");
    // No default step cap: an uncapped turn is the shipped behaviour, and a
    // default here would be the budget rule 13 forbids.
    expect(config.review.maxStepsPerTurn).toBeUndefined();
  });

  it("reads both keys when a repository sets them", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write(
      ".yama/review.yaml",
      `deletions: ignore
maxStepsPerTurn: 30
`,
    );

    const config = await loadConfig({ projectRoot: root });
    expect(config.review.deletions).toBe("ignore");
    expect(config.review.maxStepsPerTurn).toBe(30);
  });

  it("rejects a deletions value that is not a policy", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    write(".yama/review.yaml", `deletions: maybe\n`);

    await expect(loadConfig({ projectRoot: root })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe("learn skip-ci marker config", () => {
  it("defaults to enabled (undefined, treated as true at the call site)", async () => {
    write(".yama/yama.yaml", MINIMAL_YAMA);
    write(".yama/mcp.yaml", MINIMAL_MCP);
    const config = await loadConfig({ projectRoot: root });
    expect(config.learn.git?.skipCi).toBeUndefined();
  });

  it("reads skipCi: false for a repo that bans skip directives", async () => {
    write(
      ".yama/yama.yaml",
      `${MINIMAL_YAMA}
learn:
  trigger: merge-event
  git:
    remote: "https://github.com/acme/repo.git"
    branch: main
    skipCi: false
`,
    );
    write(".yama/mcp.yaml", MINIMAL_MCP);
    const config = await loadConfig({ projectRoot: root });
    expect(config.learn.git?.skipCi).toBe(false);
  });
});
