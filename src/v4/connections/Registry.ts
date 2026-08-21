/**
 * MCP server registration.
 *
 * Two invariants this module exists to hold:
 *
 *  1. **Register once per run.** Registration is memoized on a hash of the
 *     effective server set. v3 re-registered on every explore call, spawning
 *     stdio processes ~11 times per session; that cost is structural, not
 *     incidental, so the fix is structural too.
 *  2. **Allowlists fail closed.** An `allowedTools` list can only be enforced
 *     against what the server actually advertises. If discovery comes back
 *     empty we cannot tell "no tools" from "not discovered yet", so the server
 *     is removed rather than left running unrestricted.
 *
 * No server, tool, or provider name appears here. Everything comes from config.
 */

import { createHash } from "node:crypto";
import type {
  McpHost,
  McpRole,
  McpServerConfig,
  RegistryLogger,
  ResolvedConfig,
  ServerRegistration,
} from "../types/index.js";
import { substituteEnv } from "../config/Loader.js";

/** Keys Yama consumes; everything else is forwarded to NeuroLink verbatim. */
const YAMA_ONLY_KEYS = new Set([
  "enabled",
  "roles",
  "stages",
  "capabilities",
  "allowedTools",
  "transport",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "blockedTools",
]);

/** Strip server/namespace prefixes: "github:get_pr" and "github.get_pr" → "get_pr". */
export function normalizeToolName(name: string): string {
  return name.split(/[.:/]/).pop() ?? name;
}

/**
 * Shape a server definition for NeuroLink.
 *
 * Transport-aware on purpose: a remote server carries only url/headers and a
 * stdio server only command/args/env. Passing a stray `command` to an HTTP
 * transport has been observed to confuse transport selection, so irrelevant
 * keys are omitted entirely rather than passed as undefined.
 */
export function toHostConfig(
  definition: McpServerConfig,
): Record<string, unknown> {
  const transport = definition.transport ?? (definition.url ? "http" : "stdio");

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(definition)) {
    if (!YAMA_ONLY_KEYS.has(key)) {
      passthrough[key] = value;
    }
  }

  const common: Record<string, unknown> = {
    ...passthrough,
    transport,
    blockedTools: definition.blockedTools ?? [],
  };

  if (transport === "stdio") {
    return {
      ...common,
      command: definition.command,
      args: definition.args ?? [],
      ...(definition.env ? { env: definition.env } : {}),
    };
  }
  return {
    ...common,
    url: definition.url,
    ...(definition.headers ? { headers: definition.headers } : {}),
  };
}

/** Servers enabled for a role, with `${VAR}` placeholders substituted. */
export function selectServers(
  config: ResolvedConfig,
  role: McpRole,
  env: NodeJS.ProcessEnv,
): Array<{ id: string; definition: McpServerConfig }> {
  return Object.entries(config.mcp.servers)
    .filter(([, definition]) => definition.enabled !== false)
    .filter(
      ([, definition]) => !definition.roles || definition.roles.includes(role),
    )
    .map(([id, definition]) => ({
      id,
      definition: substituteEnv(definition, env),
    }));
}

/** Deterministic hash of the effective server set — the memoization key. */
export function serverSetHash(
  servers: Array<{ id: string; definition: McpServerConfig }>,
): string {
  const stable = servers
    .map(({ id, definition }) => `${id}:${stableStringify(definition)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Flag credentials that resolved to nothing.
 *
 * By this point `${VAR}` substitution has run, so an unresolved placeholder or a
 * bare scheme means the secret never arrived. Without this the failure surfaces
 * much later as an opaque remote 401.
 */
export function findEmptyCredentials(definition: McpServerConfig): string[] {
  const looksEmpty = (value: string): boolean => {
    const trimmed = value.trim();
    return (
      trimmed.length === 0 ||
      /^(bearer|token|basic)\s*$/i.test(trimmed) ||
      /\$\{[^}]+\}/.test(trimmed)
    );
  };
  return [
    ...Object.entries(definition.headers ?? {}),
    ...Object.entries(definition.env ?? {}),
  ]
    .filter(
      ([key, value]) =>
        typeof value === "string" &&
        /^(authorization|.*token.*|.*api[_-]?key.*|.*secret.*)$/i.test(key) &&
        looksEmpty(value),
    )
    .map(([key]) => key);
}

const silentLogger: RegistryLogger = { info: () => {}, warn: () => {} };

/**
 * Registers servers on a host, memoized per (role, server-set hash).
 *
 * One instance per NeuroLink host. Calling `register` again with an unchanged
 * config is a no-op that returns the previous result.
 */
export class ConnectionRegistry {
  private lastKey: string | null = null;
  private lastResult: ServerRegistration[] = [];
  private readonly registered = new Set<string>();

  constructor(private readonly logger: RegistryLogger = silentLogger) {}

  /** Registrations produced by the most recent call. */
  get registrations(): ServerRegistration[] {
    return this.lastResult;
  }

  async register(
    host: McpHost,
    config: ResolvedConfig,
    role: McpRole,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ServerRegistration[]> {
    const servers = selectServers(config, role, env);
    const key = `${role}:${serverSetHash(servers)}`;

    if (this.lastKey === key) {
      return this.lastResult;
    }

    // The set changed: drop everything registered under the old key so a
    // narrowed config never leaves a previously-allowed server live.
    for (const id of this.registered) {
      await host.removeExternalMCPServer(id).catch(() => undefined);
    }
    this.registered.clear();

    const results: ServerRegistration[] = [];
    for (const { id, definition } of servers) {
      results.push(await this.registerOne(host, id, definition));
    }

    this.lastKey = key;
    this.lastResult = results;
    return results;
  }

  private async registerOne(
    host: McpHost,
    id: string,
    definition: McpServerConfig,
  ): Promise<ServerRegistration> {
    for (const key of findEmptyCredentials(definition)) {
      this.logger.warn(
        `MCP server "${id}": "${key}" resolved to an empty value — its environment ` +
          `variable is unset or misnamed. Set the secret before this run.`,
      );
    }

    try {
      const result = await host.addExternalMCPServer(
        id,
        toHostConfig(definition),
      );
      if (result?.success === false) {
        return {
          id,
          ok: false,
          tools: [],
          error: result.error ?? "unknown error",
        };
      }

      const tools = await this.discover(host, id);

      if (definition.allowedTools && definition.allowedTools.length > 0) {
        return await this.enforceAllowlist(host, id, definition, tools);
      }

      this.registered.add(id);
      if (tools.length === 0) {
        this.logger.warn(
          `MCP server "${id}" registered but advertised no tools — check its ` +
            `credentials, scopes, and url/command.`,
        );
      } else {
        this.logger.info(`${id} registered (${tools.length} tools)`);
      }
      return { id, ok: true, tools };
    } catch (error) {
      return { id, ok: false, tools: [], error: (error as Error).message };
    }
  }

  private async discover(host: McpHost, id: string): Promise<string[]> {
    // Await regardless: today's API is synchronous, but mapping over a bare
    // promise would silently yield [] and trip the fail-closed branch below.
    const raw = await Promise.resolve(host.getExternalMCPServerTools(id));
    return (Array.isArray(raw) ? raw : [])
      .map((tool) => tool?.name)
      .filter((name): name is string => typeof name === "string");
  }

  /**
   * Enforce an allowlist by re-registering with everything else denied.
   *
   * Empty discovery is fatal for this server: we cannot distinguish "advertises
   * nothing" from "not discovered yet", and an unenforced allowlist would expose
   * whatever appears later.
   */
  private async enforceAllowlist(
    host: McpHost,
    id: string,
    definition: McpServerConfig,
    discovered: string[],
  ): Promise<ServerRegistration> {
    if (discovered.length === 0) {
      await host.removeExternalMCPServer(id).catch(() => undefined);
      return {
        id,
        ok: false,
        tools: [],
        error:
          "allowedTools is set but the server advertised no tools to enforce it against",
      };
    }

    const allowed = new Set(
      (definition.allowedTools ?? []).map((name) => normalizeToolName(name)),
    );
    const toBlock = discovered.filter(
      (name) => !allowed.has(normalizeToolName(name)),
    );

    if (toBlock.length === 0) {
      this.registered.add(id);
      return { id, ok: true, tools: discovered, allowlistEnforced: true };
    }

    await host.removeExternalMCPServer(id).catch(() => undefined);
    const result = await host.addExternalMCPServer(id, {
      ...toHostConfig(definition),
      blockedTools: [
        ...new Set([...(definition.blockedTools ?? []), ...toBlock]),
      ],
    });

    if (result?.success === false) {
      return {
        id,
        ok: false,
        tools: [],
        error: `re-registration with enforced allowlist failed: ${result.error ?? "unknown error"}`,
      };
    }

    this.registered.add(id);
    this.logger.info(
      `${id}: allowlist enforced (${allowed.size} allowed, ${toBlock.length} blocked)`,
    );
    return {
      id,
      ok: true,
      tools: discovered.filter((name) => allowed.has(normalizeToolName(name))),
      allowlistEnforced: true,
    };
  }
}
