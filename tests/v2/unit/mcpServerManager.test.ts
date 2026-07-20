/**
 * Unit tests for MCPServerManager — generic, config-driven MCP registration.
 * Exercises the public setup path against a stubbed NeuroLink to verify how
 * registration results are consumed and what config NeuroLink receives.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MCPServerManager } from "../../../src/v2/core/MCPServerManager.js";
import { MCPServersConfig } from "../../../src/v2/types/index.js";

type StubCall = {
  id: string;
  config: Record<string, unknown>;
};

function makeNeurolinkStub(
  addResult: unknown = { success: true, metadata: { toolsDiscovered: 3 } },
) {
  const calls: StubCall[] = [];
  return {
    calls,
    addExternalMCPServer: jest.fn(
      async (id: string, config: Record<string, unknown>) => {
        calls.push({ id, config });
        return addResult;
      },
    ),
    removeExternalMCPServer: jest.fn(async () => ({ success: true })),
    getExternalMCPServerTools: jest.fn(() => [] as Array<{ name: string }>),
    listMCPServers: jest.fn(async () => []),
    getMCPStatus: jest.fn(async () => ({ totalServers: 1, totalTools: 3 })),
  };
}

const baseConfig = (definition: Record<string, unknown>): MCPServersConfig => ({
  servers: { srv: definition },
});

describe("MCPServerManager.setupMCPServers", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("registers an enabled server and reports the discovered tool count", async () => {
    const nl = makeNeurolinkStub({
      success: true,
      metadata: { toolsDiscovered: 44 },
    });
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example", roles: ["review"] }),
      "pr",
      "review",
      {},
    );

    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("srv registered (44 tools)"),
    );
  });

  it("warns loudly and does not mark the server registered when NeuroLink reports success:false", async () => {
    const nl = makeNeurolinkStub({ success: false, error: "401 bad token" });
    const manager = new MCPServerManager();
    const config = baseConfig({ url: "https://mcp.example" });

    await manager.setupMCPServers(nl, config, "pr", "review", {});
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to register MCP server "srv": 401 bad token',
      ),
    );

    // Not marked registered — a later setup call retries it.
    await manager.setupMCPServers(nl, config, "pr", "review", {});
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(2);
  });

  it("skips already-registered servers on a second setup call", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();
    const config = baseConfig({ url: "https://mcp.example" });

    await manager.setupMCPServers(nl, config, "pr", "review", {});
    await manager.setupMCPServers(nl, config, "pr", "review", {});
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(1);
  });

  it("warns when a server registers but advertises zero tools", async () => {
    const nl = makeNeurolinkStub({
      success: true,
      metadata: { toolsDiscovered: 0 },
    });
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example" }),
      "pr",
      "review",
      {},
    );

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("advertised 0 tools"),
    );
  });

  it("tolerates an addExternalMCPServer that returns nothing (older API/mocks)", async () => {
    const nl = makeNeurolinkStub(undefined);
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example" }),
      "pr",
      "review",
      {},
    );

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("srv registered"),
    );
  });

  it("filters servers by mode and role", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();
    const config: MCPServersConfig = {
      servers: {
        prOnly: { url: "https://a", modes: ["pr"] },
        localOnly: { url: "https://b", modes: ["local"] },
        exploreOnly: { url: "https://c", roles: ["explore"] },
        off: { url: "https://d", enabled: false },
      },
    };

    await manager.setupMCPServers(nl, config, "pr", "review", {});

    expect(nl.calls.map((c) => c.id)).toEqual(["prOnly"]);
  });

  it("passes through generic NeuroLink options (auth, httpOptions, unknown keys) and strips Yama-routing keys", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({
        transport: "http",
        url: "https://mcp.example",
        headers: { Authorization: "Bearer x" },
        auth: { type: "bearer", bearer: { token: "x" } },
        httpOptions: { requestTimeout: 120000 },
        rateLimiting: { requestsPerMinute: 60 },
        futureOption: "forwarded",
        timeout: 30000,
        retryConfig: { maxAttempts: 3 },
        roles: ["review"],
        modes: ["pr"],
        allowedTools: undefined,
        enabled: true,
      }),
      "pr",
      "review",
      {},
    );

    const sent = nl.calls[0].config;
    expect(sent.auth).toEqual({ type: "bearer", bearer: { token: "x" } });
    expect(sent.httpOptions).toEqual({ requestTimeout: 120000 });
    expect(sent.rateLimiting).toEqual({ requestsPerMinute: 60 });
    expect(sent.futureOption).toBe("forwarded");
    expect(sent.timeout).toBe(30000);
    expect(sent.retryConfig).toEqual({ maxAttempts: 3 });
    // Yama-routing keys never reach NeuroLink.
    expect(sent).not.toHaveProperty("roles");
    expect(sent).not.toHaveProperty("modes");
    expect(sent).not.toHaveProperty("enabled");
    expect(sent).not.toHaveProperty("allowedTools");
  });

  it("sends only remote fields for http servers and only process fields for stdio servers", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();
    const config: MCPServersConfig = {
      servers: {
        remote: {
          transport: "http",
          url: "https://mcp.example",
          command: "should-not-leak",
          args: ["x"],
          env: { A: "b" },
        },
        local: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "server"],
          url: "https://should-not-leak",
          headers: { Authorization: "no" },
        },
      },
    };

    await manager.setupMCPServers(nl, config, "pr", "review", {});

    const remote = nl.calls.find((c) => c.id === "remote")!.config;
    expect(remote.url).toBe("https://mcp.example");
    expect(remote).not.toHaveProperty("command");
    expect(remote).not.toHaveProperty("args");
    expect(remote).not.toHaveProperty("env");

    const local = nl.calls.find((c) => c.id === "local")!.config;
    expect(local.command).toBe("npx");
    expect(local.args).toEqual(["-y", "server"]);
    expect(local).not.toHaveProperty("url");
    expect(local).not.toHaveProperty("headers");
  });

  it("re-registers a server whose definition changed in config", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example", blockedTools: ["a"] }),
      "pr",
      "review",
      {},
    );
    // Same id, changed tool policy — must be re-registered, not skipped.
    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example", blockedTools: ["a", "b"] }),
      "pr",
      "review",
      {},
    );

    expect(nl.removeExternalMCPServer).toHaveBeenCalledWith("srv");
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(2);
    expect(nl.calls[1].config.blockedTools).toEqual(["a", "b"]);
  });

  it("unregisters servers that were removed from config or disabled", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example", modes: ["pr"] }),
      "pr",
      "review",
      {},
    );
    // Same mode, but the server is now disabled — it must not stay live.
    await manager.setupMCPServers(
      nl,
      baseConfig({ url: "https://mcp.example", modes: ["pr"], enabled: false }),
      "pr",
      "review",
      {},
    );

    expect(nl.removeExternalMCPServer).toHaveBeenCalledWith("srv");
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(1);
  });

  it("unregisters servers not enabled for the new mode on a mode switch", async () => {
    const nl = makeNeurolinkStub();
    const manager = new MCPServerManager();
    const config: MCPServersConfig = {
      servers: {
        prServer: { url: "https://pr", modes: ["pr"] },
        bothServer: { url: "https://both" },
      },
    };

    await manager.setupMCPServers(nl, config, "pr", "review", {});
    expect(nl.calls.map((c) => c.id).sort()).toEqual([
      "bothServer",
      "prServer",
    ]);

    await manager.setupMCPServers(nl, config, "local", "review", {});
    expect(nl.removeExternalMCPServer).toHaveBeenCalledWith("prServer");
    // bothServer stays registered and is not re-added.
    expect(nl.calls.filter((c) => c.id === "bothServer")).toHaveLength(1);
  });

  it("fails closed when allowedTools is set but the server advertises no tools", async () => {
    const nl = makeNeurolinkStub();
    nl.getExternalMCPServerTools.mockReturnValue([]);
    const manager = new MCPServerManager();
    const config = baseConfig({
      transport: "stdio",
      command: "git-mcp",
      allowedTools: ["git_status"],
    });

    await manager.setupMCPServers(nl, config, "pr", "review", {});

    // The unrestricted registration is torn down and reported, not left live.
    expect(nl.removeExternalMCPServer).toHaveBeenCalledWith("srv");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("advertised no tools"),
    );

    // Not marked registered — a later setup call retries.
    await manager.setupMCPServers(nl, config, "pr", "review", {});
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(2);
  });

  it("enforces a fail-closed allowlist by blocking every non-allowed advertised tool", async () => {
    const nl = makeNeurolinkStub();
    nl.getExternalMCPServerTools.mockReturnValue([
      { name: "git_status" },
      { name: "git_log" },
      { name: "git_push" },
      { name: "run_shell" },
    ]);
    const manager = new MCPServerManager();

    await manager.setupMCPServers(
      nl,
      baseConfig({
        transport: "stdio",
        command: "git-mcp",
        allowedTools: ["git_status", "git_log"],
      }),
      "pr",
      "review",
      {},
    );

    // First add, then re-add with the expanded denylist.
    expect(nl.addExternalMCPServer).toHaveBeenCalledTimes(2);
    const reAdd = nl.calls[1].config;
    expect((reAdd.blockedTools as string[]).sort()).toEqual([
      "git_push",
      "run_shell",
    ]);
  });
});
