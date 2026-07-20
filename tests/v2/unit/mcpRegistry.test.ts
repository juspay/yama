/**
 * Unit tests for McpRegistry — external `.yama/mcp.json` MCP configuration.
 * Covers the pure/static helpers (env substitution, parsing, role filtering)
 * without touching the filesystem.
 */

import { describe, it, expect } from "@jest/globals";
import { McpRegistry } from "../../../src/v2/core/McpRegistry.js";
import { McpServerDefinition } from "../../../src/v2/types/index.js";

describe("McpRegistry project-MCP trust gate (F21)", () => {
  it("is disabled unless YAMA_ENABLE_PROJECT_MCP is explicitly true/1", () => {
    expect(McpRegistry.isProjectMcpEnabled({})).toBe(false);
    expect(
      McpRegistry.isProjectMcpEnabled({ YAMA_ENABLE_PROJECT_MCP: "false" }),
    ).toBe(false);
    expect(
      McpRegistry.isProjectMcpEnabled({ YAMA_ENABLE_PROJECT_MCP: "yes" }),
    ).toBe(false);
    expect(
      McpRegistry.isProjectMcpEnabled({ YAMA_ENABLE_PROJECT_MCP: "true" }),
    ).toBe(true);
    expect(
      McpRegistry.isProjectMcpEnabled({ YAMA_ENABLE_PROJECT_MCP: "1" }),
    ).toBe(true);
  });

  it("load() returns no servers (never touches the checkout) when disabled", async () => {
    // Even with a projectRoot that would contain config, a disabled gate must
    // short-circuit before reading — so an attacker PR can't launch anything.
    const reg = new McpRegistry("/does/not/matter");
    await expect(reg.load({})).resolves.toEqual({});
  });
});

describe("McpRegistry.findMissingEnvVars (F12)", () => {
  it("reports env vars referenced in the config but absent from the environment", () => {
    const defs = {
      bb: {
        command: "x",
        args: ["--user=${BB_USER}"],
        env: { TOKEN: "${BB_TOKEN}" },
        headers: { Authorization: "Bearer ${BB_TOKEN}" },
        url: "${BB_URL}/mcp",
      },
    };
    const missing = McpRegistry.findMissingEnvVars(defs, { BB_TOKEN: "x" });
    expect(missing.sort()).toEqual(["BB_URL", "BB_USER"]);
  });

  it("returns nothing when all placeholders resolve", () => {
    const defs = { s: { env: { T: "${T}" } } };
    expect(McpRegistry.findMissingEnvVars(defs, { T: "v" })).toEqual([]);
  });

  it("scans nested pass-through options (auth, httpOptions) deeply", () => {
    const defs: Record<string, McpServerDefinition> = {
      s: {
        url: "https://mcp",
        auth: { type: "bearer", bearer: { token: "${API_TOKEN}" } },
        httpOptions: { proxy: "${PROXY_URL}" },
      },
    };
    const missing = McpRegistry.findMissingEnvVars(defs, {});
    expect(missing.sort()).toEqual(["API_TOKEN", "PROXY_URL"]);
  });
});

describe("McpRegistry.validate (F12)", () => {
  it("throws when a stdio server has no command", () => {
    expect(() => McpRegistry.validate({ s: { transport: "stdio" } })).toThrow(
      /requires a non-empty "command"/,
    );
  });

  it("throws when an http server has no url", () => {
    expect(() => McpRegistry.validate({ s: { transport: "http" } })).toThrow(
      /requires a non-empty "url"/,
    );
  });

  it("rejects a command that substitution resolved to an empty string", () => {
    // A `${MISSING_BIN}` command is a non-empty literal pre-substitution but
    // empty after it — validation must run on the substituted values.
    const substituted = McpRegistry.substituteAll(
      { s: { transport: "stdio", command: "${MISSING_BIN}" } },
      {},
    );
    expect(() => McpRegistry.validate(substituted)).toThrow(
      /requires a non-empty "command"/,
    );
  });

  it("accepts valid stdio and http servers, and skips disabled ones", () => {
    expect(() =>
      McpRegistry.validate({
        a: { command: "x" },
        b: { transport: "http", url: "https://mcp" },
        c: { enabled: false },
      }),
    ).not.toThrow();
  });
});

describe("McpRegistry.substituteString", () => {
  const env = { TOKEN: "secret-123", HOST: "bitbucket.example.com" };

  it("replaces a single placeholder", () => {
    expect(McpRegistry.substituteString("${TOKEN}", env)).toBe("secret-123");
  });

  it("replaces multiple placeholders inside a string", () => {
    expect(McpRegistry.substituteString("https://${HOST}/api", env)).toBe(
      "https://bitbucket.example.com/api",
    );
  });

  it("substitutes a missing variable with an empty string", () => {
    expect(McpRegistry.substituteString("x=${MISSING}", env)).toBe("x=");
  });

  it("leaves text without placeholders untouched", () => {
    expect(McpRegistry.substituteString("plain text", env)).toBe("plain text");
  });
});

describe("McpRegistry.substituteDefinition", () => {
  it("substitutes across args, env, headers, and url", () => {
    const env = { BB_TOKEN: "tok", BB_USER: "me", GH_URL: "https://mcp" };
    const def: McpServerDefinition = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "server", "--user=${BB_USER}"],
      env: { BITBUCKET_TOKEN: "${BB_TOKEN}" },
      headers: { Authorization: "Bearer ${BB_TOKEN}" },
      url: "${GH_URL}/mcp/",
    };

    const out = McpRegistry.substituteDefinition(def, env);

    expect(out.args).toEqual(["-y", "server", "--user=me"]);
    expect(out.env).toEqual({ BITBUCKET_TOKEN: "tok" });
    expect(out.headers).toEqual({ Authorization: "Bearer tok" });
    expect(out.url).toBe("https://mcp/mcp/");
    // Non-substituted fields are preserved.
    expect(out.command).toBe("npx");
    expect(out.transport).toBe("stdio");
  });

  it("substitutes deeply inside pass-through options like auth", () => {
    const env = { API_TOKEN: "tok-9" };
    const def: McpServerDefinition = {
      transport: "http",
      url: "https://mcp",
      auth: { type: "bearer", bearer: { token: "${API_TOKEN}" } },
      retryConfig: { maxAttempts: 3 },
    };

    const out = McpRegistry.substituteDefinition(def, env);

    expect(out.auth).toEqual({ type: "bearer", bearer: { token: "tok-9" } });
    // Non-string values survive the deep walk untouched.
    expect(out.retryConfig).toEqual({ maxAttempts: 3 });
  });
});

describe("McpRegistry.parse", () => {
  it("returns the mcpServers map", () => {
    const raw = JSON.stringify({ mcpServers: { foo: { command: "x" } } });
    expect(McpRegistry.parse(raw)).toEqual({ foo: { command: "x" } });
  });

  it("returns an empty map when mcpServers is absent", () => {
    expect(McpRegistry.parse(JSON.stringify({ other: true }))).toEqual({});
  });
});
