import {
  ConnectionRegistry,
  findEmptyCredentials,
  normalizeToolName,
  selectServers,
  serverSetHash,
  toHostConfig,
  type McpHost,
} from "../../../src/v4/connections/Registry.js";
import {
  CapabilityError,
  CapabilityResolver,
  assertLiveCapabilities,
  resolveCapabilities,
} from "../../../src/v4/connections/Capabilities.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  McpServerConfig,
  ResolvedConfig,
  ServerRegistration,
} from "../../../src/v4/types/index.js";

function configWith(
  servers: Record<string, McpServerConfig>,
  extra: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    version: 4,
    ai: { provider: "vertex" },
    mcp: { servers },
    projectRoot: "/repo",
    notices: [],
    ...optionalDefaults(),
    ...extra,
  } as ResolvedConfig;
}

/** A scriptable stand-in for NeuroLink's external-MCP surface. */
class FakeHost implements McpHost {
  added: Array<{ id: string; config: Record<string, unknown> }> = [];
  removed: string[] = [];
  constructor(
    private readonly tools: Record<string, string[]>,
    private readonly failures: Record<string, string> = {},
  ) {}

  async addExternalMCPServer(id: string, config: Record<string, unknown>) {
    this.added.push({ id, config });
    if (this.failures[id]) {
      return { success: false, error: this.failures[id] };
    }
    return {
      success: true,
      metadata: { toolsDiscovered: (this.tools[id] ?? []).length },
    };
  }

  async removeExternalMCPServer(id: string) {
    this.removed.push(id);
    return undefined;
  }

  getExternalMCPServerTools(id: string) {
    return (this.tools[id] ?? []).map((name) => ({ name }));
  }
}

describe("normalizeToolName", () => {
  it.each([
    ["github:get_pr", "get_pr"],
    ["github.get_pr", "get_pr"],
    ["server/get_pr", "get_pr"],
    ["get_pr", "get_pr"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeToolName(input)).toBe(expected);
  });
});

describe("toHostConfig", () => {
  it("sends only url and headers for a remote transport", () => {
    const config = toHostConfig({
      transport: "http",
      url: "https://x.invalid",
      headers: { Authorization: "Bearer t" },
      command: "should-be-dropped",
      args: ["also-dropped"],
    });
    expect(config.url).toBe("https://x.invalid");
    expect(config.headers).toEqual({ Authorization: "Bearer t" });
    expect(config.command).toBeUndefined();
    expect(config.args).toBeUndefined();
  });

  it("sends only command, args and env for stdio", () => {
    const config = toHostConfig({
      transport: "stdio",
      command: "uvx",
      args: ["serena"],
      env: { KEY: "v" },
      url: "should-be-dropped",
    });
    expect(config.command).toBe("uvx");
    expect(config.args).toEqual(["serena"]);
    expect(config.url).toBeUndefined();
  });

  it("infers http when a url is present and stdio otherwise", () => {
    expect(toHostConfig({ url: "https://x.invalid" }).transport).toBe("http");
    expect(toHostConfig({ command: "x" }).transport).toBe("stdio");
  });

  it("forwards unknown keys verbatim but never Yama-only keys", () => {
    const config = toHostConfig({
      url: "https://x.invalid",
      timeout: 30_000,
      retryConfig: { maxAttempts: 3 },
      someFutureOption: true,
      roles: ["main"],
      stages: ["post"],
      capabilities: { readPullRequest: "get_pr" },
      allowedTools: ["get_pr"],
    } as McpServerConfig);

    expect(config.timeout).toBe(30_000);
    expect(config.retryConfig).toEqual({ maxAttempts: 3 });
    expect(config.someFutureOption).toBe(true);
    expect(config.roles).toBeUndefined();
    expect(config.stages).toBeUndefined();
    expect(config.capabilities).toBeUndefined();
    expect(config.allowedTools).toBeUndefined();
  });
});

describe("selectServers", () => {
  const config = configWith({
    a: { url: "https://a.invalid", roles: ["main"] },
    b: { url: "https://b.invalid", roles: ["sub"] },
    c: { url: "https://c.invalid" },
    d: { url: "https://d.invalid", enabled: false },
  });

  it("filters by role and treats a missing roles list as both", () => {
    expect(
      selectServers(config, "main", {})
        .map((s) => s.id)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(
      selectServers(config, "sub", {})
        .map((s) => s.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("skips disabled servers", () => {
    expect(selectServers(config, "main", {}).map((s) => s.id)).not.toContain(
      "d",
    );
  });

  it("substitutes env placeholders", () => {
    const withEnv = configWith({
      a: {
        url: "https://a.invalid",
        headers: { Authorization: "Bearer ${TOK}" },
      },
    });
    const [server] = selectServers(withEnv, "main", { TOK: "secret" });
    expect(server.definition.headers?.Authorization).toBe("Bearer secret");
  });
});

describe("serverSetHash", () => {
  it("is stable across key order", () => {
    const a = serverSetHash([
      { id: "x", definition: { url: "u", timeout: 1 } },
    ]);
    const b = serverSetHash([
      { id: "x", definition: { timeout: 1, url: "u" } },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a definition changes", () => {
    const a = serverSetHash([{ id: "x", definition: { url: "u" } }]);
    const b = serverSetHash([{ id: "x", definition: { url: "v" } }]);
    expect(a).not.toBe(b);
  });
});

describe("findEmptyCredentials", () => {
  it("flags unresolved placeholders and bare schemes", () => {
    expect(
      findEmptyCredentials({
        headers: { Authorization: "Bearer ${MISSING}", "X-Api-Key": "  " },
      }),
    ).toEqual(["Authorization", "X-Api-Key"]);
    expect(
      findEmptyCredentials({ headers: { Authorization: "Bearer" } }),
    ).toEqual(["Authorization"]);
  });

  it("ignores resolved credentials and non-credential headers", () => {
    expect(
      findEmptyCredentials({
        headers: { Authorization: "Bearer real-token", Accept: "" },
      }),
    ).toEqual([]);
  });
});

describe("ConnectionRegistry", () => {
  it("registers each enabled server once", async () => {
    const host = new FakeHost({ a: ["t1", "t2"] });
    const registry = new ConnectionRegistry();
    const result = await registry.register(
      host,
      configWith({ a: { url: "https://a.invalid" } }),
      "main",
      {},
    );
    expect(result).toEqual([{ id: "a", ok: true, tools: ["t1", "t2"] }]);
    expect(host.added).toHaveLength(1);
  });

  it("memoizes: an unchanged config does not re-register", async () => {
    const host = new FakeHost({ a: ["t1"] });
    const registry = new ConnectionRegistry();
    const config = configWith({ a: { url: "https://a.invalid" } });

    await registry.register(host, config, "main", {});
    await registry.register(host, config, "main", {});
    await registry.register(host, config, "main", {});

    expect(host.added).toHaveLength(1);
  });

  it("re-registers and evicts when the server set changes", async () => {
    const host = new FakeHost({ a: ["t1"], b: ["t2"] });
    const registry = new ConnectionRegistry();

    await registry.register(
      host,
      configWith({ a: { url: "https://a.invalid" } }),
      "main",
      {},
    );
    await registry.register(
      host,
      configWith({ b: { url: "https://b.invalid" } }),
      "main",
      {},
    );

    expect(host.removed).toContain("a");
    expect(host.added.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("reports a failed registration without throwing", async () => {
    const host = new FakeHost({}, { a: "bad credentials" });
    const registry = new ConnectionRegistry();
    const [result] = await registry.register(
      host,
      configWith({ a: { url: "https://a.invalid" } }),
      "main",
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bad credentials");
  });

  it("warns when a credential resolved to nothing", async () => {
    const warnings: string[] = [];
    const host = new FakeHost({ a: ["t1"] });
    const registry = new ConnectionRegistry({
      info: () => {},
      warn: (message) => warnings.push(message),
    });

    await registry.register(
      host,
      configWith({
        a: {
          url: "https://a.invalid",
          headers: { Authorization: "Bearer ${NOPE}" },
        },
      }),
      "main",
      {},
    );

    expect(
      warnings.some((line) => /resolved to an empty value/.test(line)),
    ).toBe(true);
  });

  describe("allowlist enforcement", () => {
    it("re-registers with everything outside the allowlist denied", async () => {
      const host = new FakeHost({ a: ["read", "write", "delete"] });
      const registry = new ConnectionRegistry();

      const [result] = await registry.register(
        host,
        configWith({ a: { url: "https://a.invalid", allowedTools: ["read"] } }),
        "main",
        {},
      );

      expect(result.ok).toBe(true);
      expect(result.allowlistEnforced).toBe(true);
      expect(result.tools).toEqual(["read"]);
      const last = host.added[host.added.length - 1];
      expect(last.config.blockedTools).toEqual(["write", "delete"]);
    });

    it("does not re-register when everything advertised is already allowed", async () => {
      const host = new FakeHost({ a: ["read"] });
      const registry = new ConnectionRegistry();
      await registry.register(
        host,
        configWith({ a: { url: "https://a.invalid", allowedTools: ["read"] } }),
        "main",
        {},
      );
      expect(host.added).toHaveLength(1);
    });

    it("FAILS CLOSED: empty discovery removes the server rather than running unrestricted", async () => {
      const host = new FakeHost({ a: [] });
      const registry = new ConnectionRegistry();

      const [result] = await registry.register(
        host,
        configWith({ a: { url: "https://a.invalid", allowedTools: ["read"] } }),
        "main",
        {},
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/advertised no tools/);
      expect(host.removed).toContain("a");
    });

    it("matches allowlist entries on the normalized tool name", async () => {
      const host = new FakeHost({ a: ["srv:read", "srv:write"] });
      const registry = new ConnectionRegistry();
      const [result] = await registry.register(
        host,
        configWith({ a: { url: "https://a.invalid", allowedTools: ["read"] } }),
        "main",
        {},
      );
      expect(result.tools).toEqual(["srv:read"]);
    });
  });
});

describe("resolveCapabilities", () => {
  const registrations: ServerRegistration[] = [
    { id: "vcs", ok: true, tools: ["get_pr", "add_comment", "set_status"] },
  ];

  it("resolves declared capabilities that the server really advertises", () => {
    const report = resolveCapabilities(
      configWith({
        vcs: {
          url: "u",
          capabilities: {
            readPullRequest: "get_pr",
            postInlineComment: "add_comment",
          },
        },
      }),
      registrations,
    );

    expect(report.missing).toEqual([]);
    expect(report.resolved.map((entry) => entry.capability).sort()).toEqual([
      "postInlineComment",
      "readPullRequest",
    ]);
  });

  it("reports a declared tool the server does not have, with what it does have", () => {
    const report = resolveCapabilities(
      configWith({
        vcs: { url: "u", capabilities: { postSummary: "post_summary" } },
      }),
      registrations,
    );

    expect(report.resolved).toEqual([]);
    expect(report.missing).toEqual([
      {
        capability: "postSummary",
        serverId: "vcs",
        declared: "post_summary",
        available: ["get_pr", "add_comment", "set_status"],
      },
    ]);
  });

  it("reports every capability of a server that failed to register", () => {
    const report = resolveCapabilities(
      configWith({
        vcs: { url: "u", capabilities: { readPullRequest: "get_pr" } },
      }),
      [{ id: "vcs", ok: false, tools: [], error: "boom" }],
    );
    expect(report.missing[0].available).toEqual([]);
  });

  it("does not let a second server silently override the first provider", () => {
    const report = resolveCapabilities(
      configWith({
        primary: { url: "u", capabilities: { readPullRequest: "get_pr" } },
        secondary: { url: "u", capabilities: { readPullRequest: "get_pr" } },
      }),
      [
        { id: "primary", ok: true, tools: ["get_pr"] },
        { id: "secondary", ok: true, tools: ["get_pr"] },
      ],
    );
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0].serverId).toBe("primary");
  });

  it("defaults stages to every stage and roles to both", () => {
    const report = resolveCapabilities(
      configWith({
        vcs: { url: "u", capabilities: { readPullRequest: "get_pr" } },
      }),
      registrations,
    );
    expect(report.resolved[0].roles).toEqual(["main", "sub"]);
    expect(report.resolved[0].stages).toContain("review");
  });
});

describe("assertLiveCapabilities", () => {
  const complete = configWith({
    vcs: {
      url: "u",
      capabilities: {
        readPullRequest: "get_pr",
        postInlineComment: "add_comment",
        postSummary: "add_comment",
      },
    },
  });
  const registrations: ServerRegistration[] = [
    { id: "vcs", ok: true, tools: ["get_pr", "add_comment"] },
  ];

  it("passes when every required capability resolves", () => {
    expect(() =>
      assertLiveCapabilities(
        resolveCapabilities(complete, registrations),
        "live",
        complete,
      ),
    ).not.toThrow();
  });

  it("fails a live run missing a posting capability", () => {
    const config = configWith({
      vcs: { url: "u", capabilities: { readPullRequest: "get_pr" } },
    });
    expect(() =>
      assertLiveCapabilities(
        resolveCapabilities(config, registrations),
        "live",
        config,
      ),
    ).toThrow(CapabilityError);
  });

  it("lets a dry run proceed without posting capabilities", () => {
    const config = configWith({
      vcs: { url: "u", capabilities: { readPullRequest: "get_pr" } },
    });
    expect(() =>
      assertLiveCapabilities(
        resolveCapabilities(config, registrations),
        "dry-run",
        config,
      ),
    ).not.toThrow();
  });

  it("requires listApprovals only when a blocking ownership rule exists", () => {
    const withBlockingOwnership = configWith(
      {
        vcs: {
          url: "u",
          capabilities: {
            readPullRequest: "get_pr",
            postInlineComment: "add_comment",
            postSummary: "add_comment",
          },
        },
      },
      {
        ownership: [
          { id: "core", paths: ["src/**"], owners: ["@a"], blocking: true },
        ],
      },
    );

    expect(() =>
      assertLiveCapabilities(
        resolveCapabilities(withBlockingOwnership, registrations),
        "live",
        withBlockingOwnership,
      ),
    ).toThrow(/listApprovals/);
  });

  it("names the tools a server really advertises so the fix is copy-pasteable", () => {
    const config = configWith({
      vcs: {
        url: "u",
        capabilities: {
          readPullRequest: "wrong_name",
          postInlineComment: "add_comment",
          postSummary: "add_comment",
        },
      },
    });
    expect(() =>
      assertLiveCapabilities(
        resolveCapabilities(config, registrations),
        "live",
        config,
      ),
    ).toThrow(/it advertises: get_pr, add_comment/);
  });
});

describe("CapabilityResolver — stage scoping is a security control", () => {
  const config = configWith({
    vcs: {
      url: "u",
      stages: ["post"],
      capabilities: { postInlineComment: "add_comment" },
    },
    intel: {
      url: "u",
      stages: ["review"],
      roles: ["sub"],
      capabilities: { codeIntel: "find_refs" },
    },
  });
  const resolver = new CapabilityResolver(
    resolveCapabilities(config, [
      { id: "vcs", ok: true, tools: ["add_comment"] },
      { id: "intel", ok: true, tools: ["find_refs"] },
    ]),
  );

  it("does not expose posting during the review stage", () => {
    expect(resolver.find("postInlineComment", "review")).toBeUndefined();
    expect(resolver.find("postInlineComment", "post")).toBeDefined();
  });

  it("respects role scoping", () => {
    expect(resolver.find("codeIntel", "review", "main")).toBeUndefined();
    expect(resolver.find("codeIntel", "review", "sub")).toBeDefined();
  });

  it("require() explains that the capability exists but not in this stage", () => {
    expect(() => resolver.require("postInlineComment", "review")).toThrow(
      /exists on "vcs" but is not exposed during the "review" stage/,
    );
  });

  it("require() says plainly when nothing provides it", () => {
    expect(() => resolver.require("readTicket", "review")).toThrow(
      /not provided by any configured server/,
    );
  });

  it("toolNames lists only what the stage exposes", () => {
    expect(resolver.toolNames("post")).toEqual(["add_comment"]);
    expect(resolver.toolNames("review", "sub")).toEqual(["find_refs"]);
  });
});
