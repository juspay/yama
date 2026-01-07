/**
 * MCP Server Manager for Yama V2
 * Manages lifecycle and health of Bitbucket and Jira MCP servers
 *
 * Features:
 * - Retry logic with exponential backoff for transient failures
 * - Tool verification to ensure critical tools are available
 * - Fail-fast behavior when Bitbucket MCP cannot be established
 */

import { createRequire } from "module";
import { MCPServersConfig } from "../types/config.types.js";
import { MCPServerError } from "../types/v2.types.js";
import { MCPStatus, MCPServerStatus } from "../types/mcp.types.js";

const require = createRequire(import.meta.url);

interface MCPConnectionResult {
  success: boolean;
  toolsAvailable: string[];
  error?: string;
}

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const REQUIRED_BITBUCKET_TOOLS = [
  "get_pull_request",
  "get_pull_request_diff",
  "add_comment",
];

const REQUIRED_JIRA_TOOLS = ["get_issue"];

export class MCPServerManager {
  // MCP servers are managed entirely by NeuroLink
  // No need to track tools locally
  private initialized = false;

  // Retry configuration with exponential backoff
  private readonly retryConfig: RetryConfig = {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 15000,
  };

  /**
   * Validate timeout value
   * Accepts timeout in milliseconds
   */
  private parseTimeout(timeout?: number): number {
    if (!timeout || timeout <= 0) {
      const defaultTimeout = 120000; // 2 minutes
      if (timeout !== undefined) {
        console.warn(
          `Invalid timeout value: ${timeout}, using default ${defaultTimeout}ms`,
        );
      }
      return defaultTimeout;
    }
    return timeout;
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateRetryDelay(attempt: number): number {
    const exponentialDelay =
      this.retryConfig.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000; // Add up to 1s of jitter
    return Math.min(exponentialDelay + jitter, this.retryConfig.maxDelayMs);
  }

  /**
   * Setup all MCP servers in NeuroLink
   * Bitbucket is always enabled, Jira is optional based on config
   */
  async setupMCPServers(
    neurolink: any,
    config: MCPServersConfig,
  ): Promise<void> {
    const startTime = Date.now();
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[MCP Setup] Starting MCP server initialization...`);
    console.log(`${"═".repeat(60)}`);

    const timeoutMs = 120000; // Hardcoded default as config type update was reverted
    console.log(`   Timeout per server: ${timeoutMs / 1000}s`);
    console.log(
      `   Retry attempts: ${this.retryConfig.maxAttempts} (with exponential backoff)`,
    );
    console.log(`   Transport: stdio via direct node execution\n`);

    // Setup Bitbucket MCP (always enabled, required for reviews)
    console.log(`[Step 1/2] Setting up Bitbucket MCP server...`);
    const bitbucketResult = await this.setupBitbucketMCPWithRetry(
      neurolink,
      timeoutMs,
    );

    if (!bitbucketResult.success) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`\n❌ [MCP Setup Failed] Total time: ${duration}s`);
      throw new MCPServerError(
        `Bitbucket MCP setup failed after ${this.retryConfig.maxAttempts} attempts: ${bitbucketResult.error}. ` +
          `Cannot proceed with review without Bitbucket tools.`,
      );
    }

    let allTools = [...bitbucketResult.toolsAvailable];
    // Setup Jira MCP (optional)
    if (config.jira.enabled) {
      console.log(`\n[Step 2/2] Setting up Jira MCP server...`);
      const jiraResult = await this.setupJiraMCPWithRetry(neurolink, timeoutMs);
      if (jiraResult.success) {
        allTools = [...allTools, ...jiraResult.toolsAvailable];
      }
    } else {
      console.log(`\n[Step 2/2] Jira MCP: Skipped (disabled in config)`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    this.initialized = true;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`✅ [MCP Setup Complete] Total time: ${duration}s`);
    console.log(`   Tools available: ${allTools.join(", ")}`);
    console.log(`${"═".repeat(60)}\n`);
  }

  /**
   * Setup Bitbucket MCP server with retry logic
   * This is critical - review cannot proceed without it
   */
  private async setupBitbucketMCPWithRetry(
    neurolink: any,
    timeoutMs: number,
  ): Promise<MCPConnectionResult> {
    console.log("   Registering Bitbucket MCP server...");

    // Verify environment variables first (no retry needed for this)
    if (
      !process.env.BITBUCKET_USERNAME ||
      !process.env.BITBUCKET_TOKEN ||
      !process.env.BITBUCKET_BASE_URL
    ) {
      return {
        success: false,
        toolsAvailable: [],
        error:
          "Missing required environment variables: BITBUCKET_USERNAME, BITBUCKET_TOKEN, or BITBUCKET_BASE_URL",
      };
    }

    // Resolve the server path directly - this will fail fast if not installed
    let serverPath: string;
    try {
      serverPath = require.resolve("@nexus2520/bitbucket-mcp-server");
    } catch (e) {
      throw new MCPServerError(
        `Bitbucket MCP server package not found. Please run 'npm install' to ensure dependencies are correct. Error: ${(e as Error).message}`,
      );
    }

    let lastError = "";

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        const attemptStart = Date.now();
        console.log(
          `   Attempt ${attempt}/${this.retryConfig.maxAttempts} - Spawning ${serverPath}...`,
        );

        // Attempt to add the MCP server using direct node execution
        const result = await neurolink.addExternalMCPServer("bitbucket", {
          command: process.execPath,
          args: [serverPath],
          transport: "stdio",
          timeout: timeoutMs,
          env: {
            BITBUCKET_USERNAME: process.env.BITBUCKET_USERNAME,
            BITBUCKET_TOKEN: process.env.BITBUCKET_TOKEN,
            BITBUCKET_BASE_URL: process.env.BITBUCKET_BASE_URL,
          },
        });

        const attemptDuration = ((Date.now() - attemptStart) / 1000).toFixed(1);

        // Check if NeuroLink returned a failure result - be defensive
        if (!result || result.success === false || result.error) {
          throw new Error(
            result?.error ||
              `MCP server registration failed after ${attemptDuration}s - no valid result`,
          );
        }

        console.log(
          `   ✓ Server responded in ${attemptDuration}s, verifying tools...`,
        );

        // Verify that required tools are available
        const toolVerification = await this.verifyRequiredTools(
          neurolink,
          "bitbucket",
          REQUIRED_BITBUCKET_TOOLS,
        );

        if (!toolVerification.success) {
          throw new Error(
            `Missing required tools: ${toolVerification.missingTools.join(", ")}`,
          );
        }

        console.log(
          `   ✅ Bitbucket MCP: Connected with ${toolVerification.foundTools.length} tools`,
        );
        console.log(`      Tools: ${toolVerification.foundTools.join(", ")}`);

        return {
          success: true,
          toolsAvailable: toolVerification.foundTools,
        };
      } catch (error) {
        lastError = (error as Error).message;
        console.warn(`   Attempt ${attempt} failed: ${lastError}`);

        // Clean up the server before retrying to avoid "already exists" error
        try {
          await neurolink.removeExternalMCPServer("bitbucket");
          console.log(`   Cleaned up bitbucket server for retry`);
        } catch {
          // Ignore cleanup errors - server might not exist
        }

        if (attempt < this.retryConfig.maxAttempts) {
          const delay = this.calculateRetryDelay(attempt);
          console.log(`   Retrying in ${Math.round(delay)}ms...`);
          await this.sleep(delay);
        }
      }
    }

    console.error(
      `   ❌ Bitbucket MCP setup failed after ${this.retryConfig.maxAttempts} attempts`,
    );
    return {
      success: false,
      toolsAvailable: [],
      error: lastError,
    };
  }

  /**
   * Setup Jira MCP server with retry logic
   * This is optional - review can proceed without it
   */
  private async setupJiraMCPWithRetry(
    neurolink: any,
    timeoutMs: number,
  ): Promise<MCPConnectionResult> {
    console.log("   Registering Jira MCP server...");

    // Validate required Jira environment variables
    const jiraEmail = process.env.JIRA_EMAIL;
    const jiraToken = process.env.JIRA_API_TOKEN;
    const jiraBaseUrl = process.env.JIRA_BASE_URL;

    if (!jiraEmail || !jiraToken || !jiraBaseUrl) {
      console.warn(
        "   Missing Jira environment variables (JIRA_EMAIL, JIRA_API_TOKEN, or JIRA_BASE_URL)",
      );
      console.warn("   Skipping Jira integration...");
      return {
        success: false,
        toolsAvailable: [],
        error: "Missing Jira environment variables",
      };
    }

    // Resolve the server path directly - this will fail fast if not installed
    let serverPath: string;
    try {
      serverPath = require.resolve("@nexus2520/jira-mcp-server");
    } catch (e) {
      console.warn(
        `   Jira MCP server package not found. Skipping integration.`,
      );
      return {
        success: false,
        toolsAvailable: [],
        error: `Jira MCP server package not found: ${(e as Error).message}`,
      };
    }

    let lastError = "";

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        const attemptStart = Date.now();
        console.log(
          `   Attempt ${attempt}/${this.retryConfig.maxAttempts} - Spawning ${serverPath}...`,
        );

        const result = await neurolink.addExternalMCPServer("jira", {
          command: process.execPath,
          args: [serverPath],
          transport: "stdio",
          timeout: timeoutMs,
          env: {
            JIRA_EMAIL: jiraEmail,
            JIRA_API_TOKEN: jiraToken,
            JIRA_BASE_URL: jiraBaseUrl,
          },
        });

        const attemptDuration = ((Date.now() - attemptStart) / 1000).toFixed(1);

        // Check if NeuroLink returned a failure result - be defensive
        if (!result || result.success === false || result.error) {
          throw new Error(
            result?.error ||
              `MCP server registration failed after ${attemptDuration}s - no valid result`,
          );
        }

        console.log(
          `   ✓ Server responded in ${attemptDuration}s, verifying tools...`,
        );

        // Verify that required tools are available
        const toolVerification = await this.verifyRequiredTools(
          neurolink,
          "jira",
          REQUIRED_JIRA_TOOLS,
        );

        if (!toolVerification.success) {
          throw new Error(
            `Missing required tools: ${toolVerification.missingTools.join(", ")}`,
          );
        }

        console.log(
          `   ✅ Jira MCP: Connected with ${toolVerification.foundTools.length} tools`,
        );
        console.log(`      Tools: ${toolVerification.foundTools.join(", ")}`);

        return {
          success: true,
          toolsAvailable: toolVerification.foundTools,
        };
      } catch (error) {
        lastError = (error as Error).message;
        console.warn(`   Jira attempt ${attempt} failed: ${lastError}`);

        // Clean up the server before retrying to avoid "already exists" error
        try {
          await neurolink.removeExternalMCPServer("jira");
          console.log(`   Cleaned up jira server for retry`);
        } catch {
          // Ignore cleanup errors - server might not exist
        }

        if (attempt < this.retryConfig.maxAttempts) {
          const delay = this.calculateRetryDelay(attempt);
          console.log(`   Retrying Jira in ${Math.round(delay)}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // Jira is optional, just warn and continue
    console.warn(
      `   Jira MCP setup failed after ${this.retryConfig.maxAttempts} attempts`,
    );
    console.warn("   Continuing without Jira integration...");

    return {
      success: false,
      toolsAvailable: [],
      error: lastError,
    };
  }

  /**
   * Verify that required tools are available from an MCP server
   */
  private async verifyRequiredTools(
    neurolink: any,
    serverName: string,
    requiredTools: string[],
  ): Promise<{
    success: boolean;
    foundTools: string[];
    missingTools: string[];
  }> {
    try {
      // Get all tools from external MCP servers
      const tools = neurolink.getExternalMCPTools();
      const toolNames = tools.map((t: any) => t.name || t);

      // Check which required tools are present
      const foundTools = requiredTools.filter((t) => toolNames.includes(t));
      const missingTools = requiredTools.filter((t) => !toolNames.includes(t));

      console.log(
        `   ${serverName} tools: ${foundTools.length}/${requiredTools.length} required tools found`,
      );

      if (missingTools.length > 0) {
        console.warn(
          `   Missing ${serverName} tools: ${missingTools.join(", ")}`,
        );
      }

      return {
        success: missingTools.length === 0,
        foundTools,
        missingTools,
      };
    } catch (error) {
      console.warn(
        `   Tool verification failed for ${serverName}: ${(error as Error).message}`,
      );
      return {
        success: false,
        foundTools: [],
        missingTools: requiredTools,
      };
    }
  }
}
