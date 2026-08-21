/**
 * The live runtime — where Yama's ports meet the provider SDK.
 *
 * Everything above this file is written against structural types (`GenerateHost`,
 * `McpHost`, `ToolInvoker`, `CommandRunner`), which is what makes the pipeline,
 * the supervisor and the gate testable without a network. This module is the one
 * place that constructs the real thing, and it is deliberately thin: it builds an
 * instance, registers the configured servers, probes what they actually
 * advertise, and hands back the ports.
 *
 * It performs no review logic. If you find yourself adding a decision here, it
 * belongs in a pure module with a test.
 */

import { NeuroLink, buildObservabilityConfigFromEnv } from "@juspay/neurolink";
import { z } from "zod";
import type {
  CreateRuntimeOptions,
  DelegationOptions,
  RegistryLogger,
  RuntimeHost,
  ToolInvoker,
  YamaRuntime,
} from "../types/index.js";
import { ConnectionRegistry } from "../connections/Registry.js";
import { resolveCapabilities } from "../connections/Capabilities.js";
import { buildInstanceConfig } from "./NeurolinkFactory.js";
import { subAgentReportSchema } from "../agents/subAgents.js";

const quiet: RegistryLogger = { info: () => {}, warn: () => {} };

/**
 * Build a runtime: an instance, its connections, and its capability map.
 *
 * Capabilities are resolved against DISCOVERED tools, not against what the
 * config claims. A config naming a tool the server does not advertise produces a
 * `missing` entry with the server's real tool list, which is the difference
 * between "fix this line of yaml" and "the review posted nothing and we do not
 * know why".
 */
export async function createRuntime(
  options: CreateRuntimeOptions,
): Promise<YamaRuntime> {
  const { config, chains, context, role } = options;
  const logger = options.logger ?? quiet;

  // Tracing, when the environment carries credentials for it. Built by the
  // runtime's own helper so no vendor name reaches Yama's code (rule 7), and
  // undefined when the credentials are absent — which is the normal case and
  // costs nothing.
  //
  // Wired here because it was previously not wired anywhere: workflows set the
  // tracing environment variables and no trace was ever exported, so a run that
  // was being observed and a run that was not looked identical.
  const observability = config.observability.enabled
    ? buildObservabilityConfigFromEnv()
    : undefined;

  const instance = new NeuroLink({
    ...buildInstanceConfig({
      chains,
      config,
      slot: role === "sub" ? "subAgent" : "review",
      conversationMemory: true,
    }),
    ...(observability ? { observability } : {}),
  } as ConstructorParameters<typeof NeuroLink>[0]);

  if (config.observability.enabled && !observability) {
    logger.info(
      "Tracing is enabled in config but its credentials are not in the " +
        "environment, so no traces are exported for this run.",
    );
  }

  const host = instance as unknown as RuntimeHost;
  const registry = new ConnectionRegistry(logger);
  const registrations = await registry.register(
    host,
    config,
    role,
    options.env ?? process.env,
  );
  const capabilities = resolveCapabilities(config, registrations);

  return {
    host,
    invoke: buildInvoker(instance, context.mode === "dry-run"),
    capabilities,
    delegates: [],
    shutdown: async () => {
      // Close in order: MCP transports hold sockets, telemetry holds a flush
      // timer. Leaving either open keeps the event loop alive and the CLI never
      // exits — which in CI is a job that hangs until its timeout rather than a
      // review that finished.
      await Promise.resolve(instance.shutdownExternalMCPServers?.()).catch(
        () => undefined,
      );
      await Promise.resolve(instance.shutdown?.()).catch(() => undefined);
    },
  };
}

/**
 * Invoke one MCP tool by name.
 *
 * The dry-run guard is here rather than only in the posting layer because this
 * is the narrowest point every code-driven write passes through. Posting already
 * checks the mode; this is the backstop that makes "dry run wrote nothing" true
 * by construction rather than by everyone remembering.
 */
function buildInvoker(instance: NeuroLink, dryRun: boolean): ToolInvoker {
  return async (toolName, params) => {
    if (dryRun && isWrite(toolName)) {
      return { dryRun: true, skipped: toolName };
    }
    const result = await instance.executeTool(toolName, params);
    return unwrap(result);
  };
}

/**
 * Tool names that write.
 *
 * This is a backstop, not the policy — the policy is stage scoping in
 * `.yama/mcp.yaml`, where a review turn simply cannot see a posting tool. The
 * check is on the VERB rather than a server's vocabulary, so it holds for a
 * VCS Yama has never seen.
 */
const WRITE_VERBS =
  /^(add|create|post|update|edit|delete|remove|set|submit|merge|approve|close|reopen|assign|dismiss|push|write)[_-]?/i;

function isWrite(toolName: string): boolean {
  const bare = toolName
    .replace(/^mcp[_-]/, "")
    .split(/[_-]/)
    .slice(-99)
    .join("_");
  return WRITE_VERBS.test(bare) || WRITE_VERBS.test(toolName);
}

/**
 * Normalise a tool result.
 *
 * MCP results arrive wrapped in a content envelope. The posting layer reads a
 * comment id out of the result to prove a comment exists, so a JSON payload
 * delivered as a text block has to be parsed back — otherwise every post would
 * look unconfirmed and the ledger would report the whole run as failed.
 */
function unwrap(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;

  // An MCP error envelope is a FAILURE, not a payload. Flattening it to its
  // text used to hand the posting layer a string like "API rate limit
  // exceeded", which the ledger's id extraction then accepted as a comment id
  // — a failed post recorded as posted, the exact rule-9 accounting bug the
  // ledger exists to prevent. Throwing here makes the caller's error path
  // handle it like any other failed call.
  if (record.isError === true) {
    const text = Array.isArray(record.content)
      ? record.content
          .map((entry) =>
            entry && typeof entry === "object"
              ? String((entry as Record<string, unknown>).text ?? "")
              : "",
          )
          .join("")
          .trim()
      : "";
    throw new Error(text || "The tool reported an error with no message.");
  }

  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) =>
        entry && typeof entry === "object"
          ? String((entry as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("")
      .trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        // Not JSON: a plain-text result is a legitimate answer. Returned as-is
        // so the caller sees what the server actually said.
        return text;
      }
    }
  }

  if (record.result !== undefined) {
    return record.result;
  }
  if (record.data !== undefined) {
    return record.data;
  }
  return record;
}

/**
 * Register the specialist sub-agents as delegation tools.
 *
 * The main agent decides whether and how to fan out; this only makes fanning out
 * possible. Each specialist runs isolated — its own worker instance, its own
 * context — so a large exploration never lands in the main conversation. That is
 * the point: delegation exists to keep the main window small, and a sub-agent
 * whose whole transcript came home would defeat it.
 *
 * They get read-only tools and no posting capability, and they return findings
 * against a schema. Those findings are CANDIDATES: the main agent still has to
 * put every one through the gate, so a specialist can never post.
 */
export async function registerDelegates(
  options: DelegationOptions,
): Promise<{ registered: string[]; warnings: string[] }> {
  const registered: string[] = [];
  const warnings: string[] = [];

  const instance = options.host as unknown as NeuroLink;
  if (typeof instance.registerAgentTool !== "function") {
    return {
      registered,
      warnings: [
        "This runtime exposes no agent tools, so the review runs single-agent. " +
          "Depth is reduced; correctness is not.",
      ],
    };
  }

  const readOnly = options.tools
    .filter((tool) => tool.roles.includes("sub"))
    .map((tool) => tool.name);

  for (const definition of options.definitions) {
    const member = options.member(definition.tier);
    const name = `delegate_${definition.id}`;
    try {
      await instance.registerAgentTool(
        {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          instructions: definition.instructions,
          ...(member?.provider ? { provider: member.provider } : {}),
          ...(member?.model ? { model: member.model } : {}),
          // Declared tools intersected with what actually exists. A specialist
          // told it has a tool it does not have spends its run looking for it.
          tools: [
            ...definition.tools.filter((tool) => readOnly.includes(tool)),
            ...options.mcpTools,
          ],
          inputSchema: DELEGATION_INPUT,
          // Structured findings, validated. A specialist returning prose gives
          // the main agent nothing it can put through the gate.
          outputSchema: subAgentReportSchema,
          ...(definition.maxSteps !== undefined
            ? { maxSteps: definition.maxSteps }
            : {}),
        },
        {
          name,
          maxDelegationsPerTurn: options.delegationsPerTurn,
          maxConcurrent: options.maxConcurrent,
          // One level. A specialist that could delegate would make the fan-out
          // unbounded, and nothing in a code review needs a sub-sub-agent.
          maxDepth: 1,
        },
      );
      registered.push(name);
    } catch (error) {
      warnings.push(
        `Specialist "${definition.id}" could not be registered: ` +
          `${(error as Error).message}. The review runs without it.`,
      );
    }
  }

  return { registered, warnings };
}

/** What the main agent passes when it delegates. */
const DELEGATION_INPUT = z.object({
  paths: z
    .array(z.string())
    .describe("The files this specialist should look at."),
  focus: z
    .string()
    .optional()
    .describe("The specific question you want it to answer."),
});
