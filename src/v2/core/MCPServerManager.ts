/**
 * MCPServerManager — generic, config-driven MCP registrar.
 *
 * Yama does not special-case any MCP server. Every server — bitbucket, github,
 * serena, local-git, or any custom one — is just a config-defined
 * `McpServerDefinition`. This manager substitutes `${ENV}` placeholders, selects
 * the servers enabled for the current review mode + agent role, registers each
 * with NeuroLink, and applies that server's config-driven tool filtering:
 * `blockedTools` (denylist) and `allowedTools` (fail-closed allowlist). No
 * server commands, URLs, tokens, or tool names are hardcoded here.
 */

import {
  MCPServersConfig,
  McpServerDefinition,
  McpServerMode,
  McpServerRole,
} from "../types/index.js";
import { normalizeToolName } from "../utils/toolPolicy.js";
import { McpRegistry } from "./McpRegistry.js";

/**
 * Minimal shape of the result returned by NeuroLink's `addExternalMCPServer()`.
 * Registration is synchronous: NeuroLink connects and discovers tools before
 * resolving, and reports the outcome here — `success: false` (with `error`)
 * instead of throwing. This result is the authoritative registration status;
 * `listMCPServers()` entries carry no server name/id, so they cannot be used
 * to verify a specific server.
 */
type AddServerResult = {
  success?: boolean;
  error?: string;
  metadata?: { toolsDiscovered?: number };
};

export class MCPServerManager {
  /**
   * Servers this manager has registered on the given NeuroLink instance,
   * with the definition they were registered from (needed to evict them on a
   * mode switch).
   */
  private readonly registered = new Map<string, McpServerDefinition>();

  /**
   * Register every configured server that is enabled for (mode, role). Env
   * placeholders are substituted, per-server tool filtering applied, and each
   * registration is non-fatal so one broken server cannot abort the review.
   *
   * Safe to call again: registration is RECONCILED against the current config
   * on every call. A server that is no longer selected (removed from config,
   * `enabled: false`, or outside the new mode/role) is unregistered — a
   * pr→local switch must not leave PR write tools live — and a server whose
   * definition materially changed (blockedTools, url, command, headers, …) is
   * re-registered so a long-lived SDK instance tracks config, not its first
   * snapshot. Unchanged servers are left untouched.
   */
  async setupMCPServers(
    neurolink: any,
    config: MCPServersConfig,
    mode: McpServerMode,
    role: McpServerRole,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<void> {
    const servers = this.selectServers(config, mode, role, env);
    await this.reconcileRegistered(neurolink, servers, mode, role);

    if (servers.length === 0) {
      console.warn(
        `   ⚠️  No MCP servers enabled for mode="${mode}", role="${role}". Configure mcpServers in your config.`,
      );
      return;
    }

    console.log(
      `🔌 Registering ${servers.length} MCP server(s) [mode=${mode}, role=${role}]...`,
    );
    for (const { id, definition } of servers) {
      if (this.registered.has(id)) {
        continue; // still selected and unchanged (reconciled above)
      }
      await this.registerOne(neurolink, id, definition);
    }
    await this.logDiagnostics(neurolink);
    console.log("✅ MCP servers configured\n");
  }

  /**
   * Unregister every previously-registered server that is no longer in the
   * selected set, or whose (substituted) definition differs from the one it
   * was registered with. Changed servers are re-added by the caller's
   * registration loop because they are removed from `registered` here.
   */
  private async reconcileRegistered(
    neurolink: any,
    selected: Array<{ id: string; definition: McpServerDefinition }>,
    mode: McpServerMode,
    role: McpServerRole,
  ): Promise<void> {
    const desired = new Map(selected.map((s) => [s.id, s.definition]));
    for (const [id, current] of Array.from(this.registered)) {
      const next = desired.get(id);
      if (
        next &&
        MCPServerManager.stableStringify(next) ===
          MCPServerManager.stableStringify(current)
      ) {
        continue;
      }
      await neurolink.removeExternalMCPServer?.(id)?.catch?.(() => undefined);
      this.registered.delete(id);
      console.log(
        next
          ? `   🔄 ${id}: definition changed — re-registering`
          : `   🔌 ${id} unregistered (no longer enabled for mode="${mode}", role="${role}")`,
      );
    }
  }

  /** Deterministic serialization (sorted keys) for definition comparison. */
  private static stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((v) => MCPServerManager.stableStringify(v)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (k) =>
            `${JSON.stringify(k)}:${MCPServerManager.stableStringify((value as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  }

  /** Servers from config that are enabled and match the mode + role. */
  private selectServers(
    config: MCPServersConfig,
    mode: McpServerMode,
    role: McpServerRole,
    env: NodeJS.ProcessEnv,
  ): Array<{ id: string; definition: McpServerDefinition }> {
    const substituted = McpRegistry.substituteAll(config.servers ?? {}, env);
    return Object.entries(substituted)
      .filter(([, def]) => def.enabled !== false)
      .filter(([, def]) => !def.modes || def.modes.includes(mode))
      .filter(([, def]) => !def.roles || def.roles.includes(role))
      .map(([id, definition]) => ({ id, definition }));
  }

  private async registerOne(
    neurolink: any,
    id: string,
    definition: McpServerDefinition,
  ): Promise<void> {
    try {
      this.warnOnUnresolvedAuth(id, definition);
      const result: AddServerResult | undefined =
        await neurolink.addExternalMCPServer(
          id,
          this.toNeuroLinkServerConfig(definition),
        );

      // addExternalMCPServer reports failure via the result instead of
      // throwing. Not marking the server registered lets a later setup call
      // retry it.
      if (result?.success === false) {
        console.warn(
          `   ⚠️  Failed to register MCP server "${id}": ${result.error ?? "unknown error"}`,
        );
        return;
      }

      if (definition.allowedTools && definition.allowedTools.length > 0) {
        await this.enforceAllowlist(neurolink, id, definition);
      }
      this.registered.set(id, definition);

      const toolsDiscovered = result?.metadata?.toolsDiscovered;
      if (toolsDiscovered === undefined) {
        console.log(`   ✅ ${id} registered`);
      } else if (toolsDiscovered > 0) {
        console.log(`   ✅ ${id} registered (${toolsDiscovered} tools)`);
      } else {
        console.warn(
          `   ⚠️  ${id} registered but advertised 0 tools — ` +
            `check the server's credentials/scopes and its url/command.`,
        );
      }
    } catch (error) {
      console.warn(
        `   ⚠️  Failed to register MCP server "${id}": ${(error as Error).message}`,
      );
    }
  }

  /**
   * Enforce a per-server fail-closed allowlist from config: discover the tools
   * the server actually advertises and re-register it with everything NOT on
   * `allowedTools` added to its denylist. Tool names come from the server +
   * config only — nothing is hardcoded.
   */
  private async enforceAllowlist(
    neurolink: any,
    id: string,
    def: McpServerDefinition,
  ): Promise<void> {
    const allowed = new Set(
      (def.allowedTools ?? []).map((n) => normalizeToolName(n)),
    );
    // Fail closed: the allowlist can only be enforced by discovering what the
    // server advertises. A NeuroLink without that API must not silently expose
    // every tool — remove the unrestricted registration before bailing.
    if (typeof neurolink.getExternalMCPServerTools !== "function") {
      await neurolink.removeExternalMCPServer?.(id)?.catch?.(() => undefined);
      throw new Error(
        `allowedTools is set but this NeuroLink version cannot enumerate server tools`,
      );
    }
    // Await the discovery result: the current NeuroLink API is synchronous
    // (`getExternalMCPServerTools(serverId): ExternalMCPToolInfo[]`), but if a
    // future version makes it async, mapping over a bare Promise would yield an
    // empty list and the fail-closed branch below would silently remove every
    // allowlisted server. Promise.resolve() is a no-op for the sync case.
    const discoveredRaw = await Promise.resolve(
      neurolink.getExternalMCPServerTools(id) || [],
    );
    const discovered: string[] = (
      Array.isArray(discoveredRaw) ? discoveredRaw : []
    )
      .map((tool: any) => tool?.name)
      .filter((name: unknown): name is string => typeof name === "string");
    // Fail closed when discovery came back empty: we cannot distinguish "server
    // has no tools" from "tools not discovered yet", and an unenforced
    // allowlist would expose whatever appears later. Remove the registration
    // and surface the error instead of continuing unrestricted.
    if (discovered.length === 0) {
      await neurolink.removeExternalMCPServer(id).catch(() => undefined);
      throw new Error(
        `allowedTools is set but the server advertised no tools to enforce it against`,
      );
    }
    const toBlock = discovered.filter(
      (name) => !allowed.has(normalizeToolName(name)),
    );
    if (toBlock.length === 0) {
      return;
    }
    const blockedTools = Array.from(
      new Set([...(def.blockedTools ?? []), ...toBlock]),
    );
    await neurolink.removeExternalMCPServer(id).catch(() => undefined);
    const result: AddServerResult | undefined =
      await neurolink.addExternalMCPServer(id, {
        ...this.toNeuroLinkServerConfig(def),
        blockedTools,
      });
    if (result?.success === false) {
      throw new Error(
        `re-registration with enforced allowlist failed: ${result.error ?? "unknown error"}`,
      );
    }
    console.log(
      `   🔒 ${id}: allowlist enforced (${allowed.size} allowed, ${toBlock.length} blocked)`,
    );
  }

  /**
   * Loudly flag a server whose auth header/env resolved to an EMPTY value — the
   * usual cause is an unset/misnamed token env var (e.g. `${GITHUB_TOKEN}` in a
   * composite action where the reserved name did not carry the secret). By this
   * point `${VAR}` placeholders are already substituted, so an empty/`Bearer `-only
   * value means the secret never arrived. Without this the failure is a cryptic
   * remote "missing required Authorization header" much later.
   */
  private warnOnUnresolvedAuth(id: string, def: McpServerDefinition): void {
    const looksEmpty = (v: string): boolean => {
      const t = v.trim();
      return (
        t.length === 0 ||
        /^(bearer|token|basic)$/i.test(t) ||
        // "Bearer" / "token" with an empty value after the scheme
        /^(bearer|token|basic)\s*$/i.test(t) ||
        t.endsWith("${") ||
        /\$\{[^}]+\}/.test(t) // an unresolved ${VAR} placeholder survived
      );
    };
    const suspect = [
      ...Object.entries(def.headers ?? {}),
      ...Object.entries(def.env ?? {}),
    ].filter(
      ([k, v]) =>
        typeof v === "string" &&
        /^(authorization|.*token.*|.*api[_-]?key.*)$/i.test(k) &&
        looksEmpty(v),
    );
    for (const [k] of suspect) {
      console.warn(
        `   ⚠️  MCP server "${id}": "${k}" resolved to an EMPTY/unresolved value — ` +
          `the token env var is unset or misnamed. Set the secret and reference it ` +
          `via a NON-reserved env name (avoid \${GITHUB_TOKEN} inside composite actions).`,
      );
    }
  }

  /**
   * Map a declarative {@link McpServerDefinition} to NeuroLink's
   * `addExternalMCPServer` config. Transport defaults to stdio unless a `url`
   * is present (then http), matching NeuroLink's own inference.
   *
   * Pass-through by default: every key except the Yama-routing ones
   * (`enabled`, `roles`, `modes`, `allowedTools`) is forwarded to NeuroLink
   * verbatim — `timeout`, `retryConfig`, `auth`, `httpOptions`,
   * `rateLimiting`, and any option a future NeuroLink adds — so any MCP
   * server NeuroLink supports is configurable without a Yama code change.
   *
   * Transport-aware: an http/sse/ws server carries ONLY url/headers, and a
   * stdio server ONLY command/args/env — irrelevant keys are omitted entirely
   * (not passed as `undefined`), so a remote server is never handed stray
   * process-launch fields that can confuse the transport. Mirrors the proven
   * hosted-GitHub registration shape.
   */
  private toNeuroLinkServerConfig(
    def: McpServerDefinition,
  ): Record<string, unknown> {
    const transport = def.transport ?? (def.url ? "http" : "stdio");
    const {
      enabled: _enabled,
      roles: _roles,
      modes: _modes,
      allowedTools: _allowedTools,
      transport: _transport,
      command,
      args,
      env,
      url,
      headers,
      blockedTools,
      ...passthrough
    } = def;

    const common: Record<string, unknown> = {
      ...passthrough,
      transport,
      blockedTools: blockedTools ?? [],
    };

    if (transport === "stdio") {
      return {
        ...common,
        command,
        args: args ?? [],
        ...(env ? { env } : {}),
      };
    }

    // Remote transports (http/sse/websocket): url + optional headers only.
    return {
      ...common,
      url,
      ...(headers ? { headers } : {}),
    };
  }

  /** MCP preflight diagnostics after registration. */
  private async logDiagnostics(neurolink: any): Promise<void> {
    try {
      const status = await neurolink.getMCPStatus();
      const servers = await neurolink.listMCPServers();
      console.log("   📊 MCP diagnostics:");
      console.log(`      Servers: ${status.totalServers}`);
      console.log(`      Tools: ${status.totalTools}`);
      console.log(
        `      Connected: ${(servers || []).filter((server: any) => server?.status === "connected").length}`,
      );
    } catch (error) {
      console.warn(
        `   ⚠️  MCP diagnostics unavailable: ${(error as Error).message}`,
      );
    }
  }
}
