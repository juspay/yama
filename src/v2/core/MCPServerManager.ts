/**
 * MCP Server Manager for Yama V2
 * Manages lifecycle and health of PR/local MCP servers
 */

import { join } from "path";
import { MCPServersConfig, GitHubConfig } from "../types/config.types.js";
import { MCPServerError } from "../types/v2.types.js";

/**
 * Default remote HTTP endpoint for GitHub's hosted MCP server.
 * Overridable via `mcpServers.github.url`.
 */
const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/**
 * Default write tools blocked on the GitHub MCP server.
 * Mirrors Curator's proven pattern: the AI never mutates the repo directly —
 * the single write path is the review-comment / review-submit tools, which are
 * intentionally NOT blocked here.
 */
const DEFAULT_GITHUB_BLOCKED_TOOLS: string[] = [
  "push_files",
  "create_or_update_file",
  "create_branch",
  "delete_file",
  "create_pull_request_with_copilot",
  "assign_copilot_to_issue",
];

/**
 * Registration shape for the GitHub remote HTTP MCP server.
 * Structural subset of NeuroLink's `MCPServerInfo` (transport/url/headers/
 * blockedTools + optional stdio command/args), typed explicitly to avoid `any`
 * for the new config object.
 */
interface GitHubMCPRegistration {
  transport: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  blockedTools: string[];
  /** Connection timeout (ms). The hosted remote endpoint is slow (~3-4s TLS). */
  timeout?: number;
  /** Retry/backoff for the remote HTTP endpoint (mirrors Curator's setup). */
  retryConfig?: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
  };
}

export class MCPServerManager {
  // MCP servers are managed entirely by NeuroLink
  // No need to track tools locally
  private initialized = false;

  /**
   * Setup MCP servers based on detected provider
   * GitHub MCP OR Bitbucket MCP (not both) - whichever is needed
   * Jira is optional for both
   */
  async setupMCPServers(
    neurolink: any,
    config: MCPServersConfig,
    provider: "github" | "bitbucket" = "bitbucket",
  ): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log("🔌 Setting up MCP servers...");
    console.log(`   📍 Provider: ${provider}`);

    // Setup provider-specific MCP (only one needed)
    if (provider === "github") {
      // Fail fast rather than passing an undefined/disabled config downstream.
      if (!config.github || config.github.enabled === false) {
        throw new MCPServerError(
          "GitHub provider selected but mcpServers.github is not enabled",
        );
      }
      await this.setupGitHubMCP(neurolink, config.github);
    } else {
      await this.setupBitbucketMCP(neurolink, config.bitbucket?.blockedTools);
    }

    // Setup Jira MCP (optional, works with both providers)
    if (config.jira.enabled) {
      await this.setupJiraMCP(neurolink, config.jira.blockedTools);
    } else {
      console.log("   ⏭️  Jira MCP disabled in config");
    }

    this.initialized = true;

    await this.logDiagnostics(neurolink);
    console.log("✅ MCP servers configured\n");
  }

  /**
   * Reset PR-mode MCP setup so {@link setupMCPServers} can re-register for a
   * different provider within the same process (e.g. one orchestrator instance
   * reviewing a Bitbucket PR then a GitHub PR). Removes the previously-registered
   * provider server (Bitbucket or GitHub) so the new provider's server takes its
   * place, and clears the `initialized` guard. The optional Jira server is left
   * in place — it is provider-agnostic and shared. Single-provider runs never
   * call this, so their behaviour is unchanged.
   */
  async resetForProviderSwitch(
    neurolink: any,
    previousProvider: "github" | "bitbucket",
  ): Promise<void> {
    const serverName = previousProvider === "github" ? "github" : "bitbucket";
    try {
      await neurolink.removeExternalMCPServer?.(serverName);
    } catch {
      // Non-fatal: if removal fails the subsequent re-register will surface a
      // clearer error. Proceed to allow re-setup.
    }
    this.initialized = false;
  }

  /**
   * Setup local git MCP server for SDK/local mode.
   * Mandatory in local mode.
   */
  async setupLocalGitMCPServer(neurolink: any): Promise<void> {
    try {
      console.log("🔌 Setting up local Git MCP server...");
      await neurolink.addExternalMCPServer(
        "local-git",
        this.buildLocalGitServerConfig([]),
      );

      const discoveredToolNames = this.getLocalGitToolNames(neurolink);

      // Fail closed: if tool discovery returns nothing we cannot verify read-only
      // safety, so refuse to proceed rather than silently exposing write operations.
      if (discoveredToolNames.length === 0) {
        await neurolink
          .removeExternalMCPServer("local-git")
          .catch(() => undefined);
        throw new MCPServerError(
          "local-git MCP server returned no tools — cannot verify read-only filtering. Aborting local mode setup.",
        );
      }

      const mutatingTools = discoveredToolNames.filter((name) =>
        this.isMutatingGitTool(name),
      );

      // Enforce hard safety at MCP layer: mutating tools are removed from registry.
      if (mutatingTools.length > 0) {
        await neurolink.removeExternalMCPServer("local-git");
        await neurolink.addExternalMCPServer(
          "local-git",
          this.buildLocalGitServerConfig(mutatingTools),
        );

        // Verify the re-registration actually removed all mutating tools.
        const remainingMutating = this.getLocalGitToolNames(neurolink).filter(
          (name) => this.isMutatingGitTool(name),
        );
        if (remainingMutating.length > 0) {
          await neurolink
            .removeExternalMCPServer("local-git")
            .catch(() => undefined);
          throw new MCPServerError(
            `Read-only enforcement failed — mutating tools still present after blocking: ${remainingMutating.join(", ")}`,
          );
        }
      }

      console.log("   ✅ Local Git MCP server registered");
      console.log(
        "   🔒 Local mode enforces regex-derived read-only blocking at MCP layer",
      );
      if (mutatingTools.length > 0) {
        console.log(
          `   🚫 Blocked local-git tools: ${mutatingTools.join(", ")}`,
        );
      }
      try {
        const toolNames = this.getLocalGitToolNames(neurolink);
        if (toolNames.length > 0) {
          console.log(
            `   🧰 local-git tools (available): ${toolNames.join(", ")}`,
          );
        }
      } catch {
        // Optional introspection only
      }
      await this.logDiagnostics(neurolink);
    } catch (error) {
      throw new MCPServerError(
        `Failed to setup local Git MCP server: ${(error as Error).message}`,
      );
    }
  }

  private buildLocalGitServerConfig(blockedTools: string[]) {
    return {
      // Launch via package script: tries uvx first, falls back to npx package.
      command: "npm",
      args: ["run", "-s", "mcp:git:server"],
      transport: "stdio",
      blockedTools,
    };
  }

  private getLocalGitToolNames(neurolink: any): string[] {
    return (neurolink.getExternalMCPServerTools?.("local-git") || [])
      .map((tool: any) => tool?.name)
      .filter((name: unknown): name is string => typeof name === "string");
  }

  private isMutatingGitTool(toolName: string): boolean {
    // Handles plain names (git_commit) and prefixed names (local-git.git_commit).
    const normalized = toolName.split(/[.:/]/).pop() || toolName;
    return /^git_(commit|push|add|checkout|create_branch|merge|rebase|cherry_pick|reset|revert|tag|rm|clean|stash|apply)\b/i.test(
      normalized,
    );
  }

  /**
   * Setup Bitbucket MCP server (hardcoded, always enabled)
   */
  private async setupBitbucketMCP(
    neurolink: any,
    blockedTools?: string[],
  ): Promise<void> {
    try {
      console.log("   🔧 Registering Bitbucket MCP server...");

      // Verify environment variables
      if (
        !process.env.BITBUCKET_USERNAME ||
        !process.env.BITBUCKET_TOKEN ||
        !process.env.BITBUCKET_BASE_URL
      ) {
        throw new MCPServerError(
          "Missing required environment variables: BITBUCKET_USERNAME, BITBUCKET_TOKEN, or BITBUCKET_BASE_URL",
        );
      }

      // Use the locally installed binary instead of `npx @latest`, which forces
      // a registry check + possible download in CI and causes the 30s circuit-breaker
      // to fire intermittently.
      const bitbucketBin = join(
        process.cwd(),
        "node_modules/.bin/bitbucket-mcp-server",
      );

      await neurolink.addExternalMCPServer("bitbucket", {
        command: bitbucketBin,
        args: [],
        transport: "stdio",
        env: {
          BITBUCKET_USERNAME: process.env.BITBUCKET_USERNAME,
          BITBUCKET_TOKEN: process.env.BITBUCKET_TOKEN,
          BITBUCKET_BASE_URL: process.env.BITBUCKET_BASE_URL,
        },
        blockedTools: blockedTools || [],
      });

      // Verify the server actually connected — NeuroLink resolves the promise
      // even on timeout, so we must check the status explicitly.
      const servers = await neurolink.listMCPServers();
      const bbServer = (servers || []).find((s: any) => s.name === "bitbucket");
      if (
        !bbServer ||
        bbServer.status !== "connected" ||
        bbServer.tools?.length === 0
      ) {
        throw new MCPServerError(
          `Bitbucket MCP server registered but not connected (status: ${bbServer?.status ?? "unknown"}, tools: ${bbServer?.tools?.length ?? 0}). Possible startup timeout.`,
        );
      }

      console.log("   ✅ Bitbucket MCP server registered and tools available");
      if (blockedTools && blockedTools.length > 0) {
        console.log(`   🚫 Blocked tools: ${blockedTools.join(", ")}`);
      }
    } catch (error) {
      throw new MCPServerError(
        `Failed to setup Bitbucket MCP server: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Setup GitHub MCP server.
   *
   * Registers GitHub's hosted REMOTE HTTP MCP server via NeuroLink, mirroring
   * Curator's proven pattern (transport: "http" + Bearer auth header). The old
   * `npx @github/github-mcp-server` package does not exist, so stdio is only
   * supported for an explicitly-configured self-hosted / Docker server.
   *
   * URL + transport are config-driven (`mcpServers.github.{url,transport,command,args}`),
   * defaulting to the remote HTTP endpoint.
   */
  private async setupGitHubMCP(
    neurolink: any,
    githubConfig?: GitHubConfig,
  ): Promise<void> {
    try {
      console.log("   🔧 Registering GitHub MCP server...");

      // Be robust to a possibly-undefined config: default URL + transport +
      // blockedTools so registration still works if the caller passes nothing.
      const transport = githubConfig?.transport ?? "http";
      // ADDITIVE, not replacing: always enforce the default write-block denylist
      // and union it with any user-provided entries, so a user-supplied
      // `blockedTools` can only EXTEND the denylist — never un-block write tools
      // like push_files / create_or_update_file.
      const blockedTools = Array.from(
        new Set([
          ...DEFAULT_GITHUB_BLOCKED_TOOLS,
          ...(githubConfig?.blockedTools ?? []),
        ]),
      );

      // An explicit token is REQUIRED. gh CLI auth (hosts.yml) cannot supply a
      // Bearer token for the remote HTTP transport, so we do not accept it as a
      // substitute. The hosted endpoint (api.githubcopilot.com) expects a real
      // GitHub PAT — the ephemeral Actions GITHUB_TOKEN may be rejected. Token
      // resolution order mirrors Curator's proven setup (GITHUB_ACCESS_TOKEN):
      //   GITHUB_TOKEN → GH_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GITHUB_ACCESS_TOKEN.
      const ghToken =
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
        process.env.GITHUB_ACCESS_TOKEN;

      if (!ghToken) {
        throw new MCPServerError(
          "Missing GitHub authentication: set GITHUB_TOKEN (or GH_TOKEN / " +
            "GITHUB_PERSONAL_ACCESS_TOKEN / GITHUB_ACCESS_TOKEN). The remote HTTP " +
            "transport requires an explicit GitHub PAT; 'gh auth login' alone is " +
            "not sufficient.",
        );
      }

      const config: GitHubMCPRegistration =
        transport === "stdio"
          ? this.buildGitHubStdioConfig(githubConfig, ghToken, blockedTools)
          : this.buildGitHubHttpConfig(githubConfig, ghToken, blockedTools);

      await neurolink.addExternalMCPServer("github", config);

      // Verify the server actually connected — NeuroLink resolves the promise
      // even on timeout, so we must check the status explicitly (same pattern
      // as the Bitbucket path).
      const servers = await neurolink.listMCPServers();
      const ghServer = (servers || []).find((s: any) => s.name === "github");
      if (
        !ghServer ||
        ghServer.status !== "connected" ||
        ghServer.tools?.length === 0
      ) {
        throw new MCPServerError(
          `GitHub MCP server registered but not connected (status: ${ghServer?.status ?? "unknown"}, tools: ${ghServer?.tools?.length ?? 0}). Possible startup timeout.`,
        );
      }

      console.log(
        `   ✅ GitHub MCP server registered and tools available (transport: ${transport})`,
      );
      if (transport === "http") {
        console.log(`   🌐 Remote endpoint: ${config.url}`);
      }
      console.log(`   🚫 Blocked write tools: ${blockedTools.join(", ")}`);
    } catch (error) {
      throw new MCPServerError(
        `Failed to setup GitHub MCP server: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Build the remote HTTP GitHub MCP registration (default path).
   * A Bearer token is required for the hosted endpoint.
   */
  private buildGitHubHttpConfig(
    githubConfig: GitHubConfig | undefined,
    ghToken: string | undefined,
    blockedTools: string[],
  ): GitHubMCPRegistration {
    if (!ghToken) {
      throw new MCPServerError(
        "GitHub remote HTTP MCP server requires a token. Set GITHUB_TOKEN " +
          "(or GH_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN / GITHUB_ACCESS_TOKEN); " +
          "'gh auth login' alone is not sufficient for the remote transport.",
      );
    }

    // The hosted endpoint is slow to connect (~3-4s TLS handshake + remote auth);
    // a generous timeout + retry/backoff prevents spurious "not connected"
    // failures. Values mirror Curator's production GitHub MCP registration.
    return {
      transport: "http",
      url: githubConfig?.url ?? DEFAULT_GITHUB_MCP_URL,
      headers: {
        Authorization: `Bearer ${ghToken}`,
      },
      blockedTools,
      timeout: 30000,
      retryConfig: {
        maxAttempts: 3,
        initialDelay: 1000,
        maxDelay: 10000,
        backoffMultiplier: 2,
      },
    };
  }

  /**
   * Build a self-hosted / Docker stdio GitHub MCP registration.
   * Only used when `mcpServers.github.transport === "stdio"`; requires `command`.
   */
  private buildGitHubStdioConfig(
    githubConfig: GitHubConfig | undefined,
    ghToken: string | undefined,
    blockedTools: string[],
  ): GitHubMCPRegistration {
    const command = githubConfig?.command;
    if (!command) {
      throw new MCPServerError(
        "GitHub stdio transport requires 'mcpServers.github.command' " +
          "(e.g. a self-hosted/Docker GitHub MCP server binary).",
      );
    }

    return {
      transport: "stdio",
      command,
      args: githubConfig?.args ?? [],
      env: ghToken
        ? {
            GITHUB_PERSONAL_ACCESS_TOKEN: ghToken,
            GITHUB_TOKEN: ghToken,
          }
        : undefined,
      blockedTools,
    };
  }

  /**
   * Setup Jira MCP server (hardcoded, optionally enabled)
   */
  private async setupJiraMCP(
    neurolink: any,
    blockedTools?: string[],
  ): Promise<void> {
    try {
      console.log("   🔧 Registering Jira MCP server...");

      // Validate required Jira environment variables
      const jiraEmail = process.env.JIRA_EMAIL;
      const jiraToken = process.env.JIRA_API_TOKEN;
      const jiraBaseUrl = process.env.JIRA_BASE_URL;

      if (!jiraEmail || !jiraToken || !jiraBaseUrl) {
        console.warn(
          "   ⚠️  Missing Jira environment variables (JIRA_EMAIL, JIRA_API_TOKEN, or JIRA_BASE_URL)",
        );
        console.warn("   Skipping Jira integration...");
        return;
      }

      // Use the locally installed binary (same reason as Bitbucket above).
      const jiraBin = join(process.cwd(), "node_modules/.bin/jira-mcp-server");

      await neurolink.addExternalMCPServer("jira", {
        command: jiraBin,
        args: [],
        transport: "stdio",
        env: {
          JIRA_EMAIL: process.env.JIRA_EMAIL,
          JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
          JIRA_BASE_URL: process.env.JIRA_BASE_URL,
        },
        blockedTools: blockedTools || [],
      });

      console.log("   ✅ Jira MCP server registered and tools available");
      if (blockedTools && blockedTools.length > 0) {
        console.log(`   🚫 Blocked tools: ${blockedTools.join(", ")}`);
      }
    } catch (error) {
      // Jira is optional, so we warn instead of throwing
      console.warn(
        `   ⚠️  Failed to setup Jira MCP server: ${(error as Error).message}`,
      );
      console.warn("   Continuing without Jira integration...");
    }
  }

  /**
   * MCP preflight diagnostics after registration.
   */
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
