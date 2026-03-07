/**
 * MCP Server Manager for Yama V2
 * Manages lifecycle and health of PR/local MCP servers
 */

import { join } from "path";
import { MCPServersConfig } from "../types/config.types.js";
import { MCPServerError } from "../types/v2.types.js";

export class MCPServerManager {
  // MCP servers are managed entirely by NeuroLink
  // No need to track tools locally
  private initialized = false;

  /**
   * Setup all MCP servers in NeuroLink
   * Bitbucket is always enabled, Jira is optional based on config
   */
  async setupMCPServers(
    neurolink: any,
    config: MCPServersConfig,
  ): Promise<void> {
    if (this.initialized) {
      return;
    }

    console.log("🔌 Setting up MCP servers...");

    // Setup Bitbucket MCP (always enabled)
    await this.setupBitbucketMCP(neurolink, config.bitbucket?.blockedTools);

    // Setup Jira MCP (optional)
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
