/**
 * MCP attachment (TASKS:Y1.3). Connecting resolves to the tool names the server actually
 * exposed, which is what the capability probe compares the config against — a capability
 * pointing at a tool nobody serves has to fail loudly, not silently do nothing.
 */
import type { NeuroLink } from "@juspay/neurolink";
import type { EngineMcpServer } from "../types/index.js";

/** Connects one MCP server and returns the tools it exposed. */
export const connectMcpServer = async (
  nl: NeuroLink,
  id: string,
  server: EngineMcpServer,
): Promise<string[]> => {
  const added = await nl.addExternalMCPServer(id, {
    id,
    name: id,
    description: `Yama MCP server: ${id}`,
    transport: server.transport,
    status: "connecting",
    tools: [],
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    timeout: server.timeout,
  });
  if (!added.success) {
    throw new Error(
      `MCP server "${id}" failed to connect: ${added.error ?? "unknown error"}`,
    );
  }
  return nl.getExternalMCPServerTools(id).map((tool) => tool.name);
};
