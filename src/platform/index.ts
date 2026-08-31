/**
 * The platform layer (TASKS:Y1.3, Y5.4): connect the MCP servers, probe the capability map
 * against the tools they really expose, and resolve capabilities to tool names.
 *
 * Runtime exports only — the shapes live in `src/types/platform.ts`.
 */
export {
  MCP_CONNECT_TIMEOUT_MS,
  connectMcpServers,
  connectPlatform,
  toEngineMcpServer,
  usesPlatform,
} from "./connect.js";
export { readTargetComments } from "./comments.js";
export { assertProbe, probeCapabilities } from "./probe.js";
export { createCapabilityRegistry } from "./registry.js";
export {
  readComment,
  readComments,
  readDescription,
  unwrapDocuments,
  unwrapRecords,
} from "./results.js";
