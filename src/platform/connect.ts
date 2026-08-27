/**
 * Attaching the platform (TASKS:Y1.3, Y5.4).
 *
 * Every server `mcp.yaml` declares is connected through the seam, the tools each one
 * advertised are recorded, and the capability map is probed against them. A server that
 * will not connect degrades the capabilities behind it — a local review does not care that
 * the GitHub server is down, and should not be stopped by it — but a run that needs one of
 * those capabilities fails loudly, naming the fix.
 */
import {
  DELIVERY_CAPABILITIES,
  requiredCapabilitiesFor,
} from "../config/capabilities.js";
import { expandServer } from "../config/env.js";
import type {
  ConfigDegradation,
  DeliveryAction,
  Engine,
  EngineMcpServer,
  McpConnection,
  McpServerConfig,
  PlatformSession,
  ResolvedConfig,
  RunTarget,
} from "../types/index.js";
import { createCapabilityRegistry } from "./registry.js";
import { assertProbe, probeCapabilities } from "./probe.js";

/** `mcp.yaml`'s server shape in the seam's own terms. The seam owns the rest. */
export const toEngineMcpServer = (server: McpServerConfig): EngineMcpServer =>
  server.transport === "stdio"
    ? {
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.timeoutMs !== undefined
          ? { timeout: server.timeoutMs }
          : {}),
      }
    : {
        transport: server.transport,
        url: server.url,
        headers: server.headers,
        ...(server.timeoutMs !== undefined
          ? { timeout: server.timeoutMs }
          : {}),
      };

/**
 * Every capability Yama knows is scoped to a pull request, so a local or branch review has
 * nothing to call one for. Connecting the platform anyway would spend a process start and
 * a network round trip on tools the run cannot use.
 */
export const usesPlatform = (target: RunTarget): boolean =>
  target.mode === "pr";

/**
 * How long one server gets to connect before it is treated as unavailable.
 *
 * This is a bound the HOST holds, not one it asks the server for: an `npx`-spawned server
 * that stalls fetching a package will otherwise hang `yama review` and `yama doctor`
 * indefinitely, and a review that never finishes is worse than one that says a server is
 * unreachable. `timeoutMs` on the server declaration raises or lowers it.
 */
export const MCP_CONNECT_TIMEOUT_MS = 60_000;

/** The tools a server exposed, or the reason it exposed none. Never throws. */
const connectOne = async (
  engine: Engine,
  id: string,
  server: McpServerConfig,
  file: string,
): Promise<McpConnection> => {
  const limit = server.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<McpConnection>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id,
          tools: [],
          error: `did not connect within ${limit}ms — raise servers.${id}.timeoutMs, or check the command and credentials it needs`,
        }),
      limit,
    );
    timer.unref();
  });
  try {
    // The secrets this server needs are filled in HERE, so a missing one costs this
    // server rather than the whole run (see `src/config/env.ts`).
    const ready = expandServer(id, server, file);
    return await Promise.race([
      engine
        .connectMcp(id, toEngineMcpServer(ready))
        .then((tools): McpConnection => ({ id, tools })),
      expired,
    ]);
  } catch (error) {
    return {
      id,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Connects every declared server. A failure is recorded, never thrown — the probe judges. */
export const connectMcpServers = async (
  engine: Engine,
  servers: Record<string, McpServerConfig>,
  file = ".yama/mcp.yaml",
): Promise<McpConnection[]> => {
  const connections: McpConnection[] = [];
  for (const [id, server] of Object.entries(servers)) {
    connections.push(await connectOne(engine, id, server, file));
  }
  return connections;
};

/**
 * Connects, probes, and hands back the registry every stage resolves tool names through.
 *
 * `deliveryActions` is narrowed a second time here: the loader decided what config asked
 * for and the capability map could name, this decides what the servers can actually do.
 * Anything dropped is a degradation with the probe's own reason attached.
 */
export const connectPlatform = async (options: {
  engine: Engine;
  config: ResolvedConfig;
  target: RunTarget;
  /** Degradations found here are appended, so one list carries the whole run. */
  degradations?: ConfigDegradation[];
}): Promise<PlatformSession> => {
  const { engine, config, target } = options;
  const declared = Object.keys(config.mcp.servers);
  const connections = usesPlatform(target)
    ? await connectMcpServers(engine, config.mcp.servers, config.paths.mcpFile)
    : [];
  if (!usesPlatform(target)) {
    for (const id of declared) {
      options.degradations?.push({
        what: `mcp.${id}`,
        reason: `not connected — a ${target.mode} run uses no platform capability`,
      });
    }
  }
  const probe = probeCapabilities({
    bindings: config.capabilities,
    connections,
  });
  assertProbe(probe, requiredCapabilitiesFor(target), config.paths.mcpFile);

  const degradations = options.degradations;
  const deliveryActions: DeliveryAction[] = [];
  for (const action of config.deliveryActions) {
    const capability = DELIVERY_CAPABILITIES[action];
    if (probe.live[capability] !== undefined) {
      deliveryActions.push(action);
      continue;
    }
    degradations?.push({
      what: `delivery.${action}`,
      reason:
        probe.entries.find((entry) => entry.capability === capability)
          ?.detail ?? `capability "${capability}" is not available`,
    });
  }

  for (const connection of connections) {
    if (connection.error !== undefined) {
      degradations?.push({
        what: `mcp.${connection.id}`,
        reason: connection.error,
      });
    }
  }

  // Tools config EXPOSED from extra servers (e.g. a code-graph MCP), proved against what
  // each server actually advertised. A name the server does not advertise is a config
  // lie and is named; a server that failed to connect is already named above, and its
  // exposed tools simply do not ride.
  const exposedTools: string[] = [];
  for (const connection of connections) {
    if (connection.error !== undefined) {
      continue;
    }
    for (const name of config.mcp.servers[connection.id]?.expose ?? []) {
      if (connection.tools.includes(name)) {
        exposedTools.push(`${connection.id}.${name}`);
      } else {
        degradations?.push({
          what: `mcp.${connection.id}.expose`,
          reason: `tool "${name}" is not advertised by server "${connection.id}"`,
        });
      }
    }
  }

  return {
    probe,
    registry: createCapabilityRegistry(probe.live),
    deliveryActions,
    exposedTools,
  };
};
