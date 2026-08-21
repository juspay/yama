/**
 * Capability resolution — the join between what Yama's code needs and what a
 * given project's servers actually provide.
 *
 * Code asks for a capability ("postInlineComment"); config supplies the tool
 * name. That indirection is what lets deterministic posting work against any
 * VCS without a single provider name in `src/`.
 *
 * The probe runs at startup, against LIVE servers. A capability whose declared
 * tool does not exist is reported with the tool list the server really
 * advertises, so the fix is a copy-paste rather than a guess. Discovering this
 * at startup instead of at posting time is the entire point: a run that cannot
 * post should never get as far as computing findings it will then drop.
 */

import type {
  CapabilityName,
  CapabilityReport,
  McpRole,
  MissingCapability,
  ResolvedConfig,
  ResolvedCapability,
  RunMode,
  ServerRegistration,
  StageName,
} from "../types/index.js";
import { REQUIRED_LIVE_CAPABILITIES } from "../types/index.js";
import { normalizeToolName } from "./Registry.js";
import { STAGE_ORDER } from "../config/defaults.js";

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly missing: MissingCapability[],
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Match a declared tool name against what a server advertises.
 *
 * Compared on the normalized (unprefixed) name because servers vary in whether
 * they namespace their tools, and a config author should not have to know which.
 */
function advertises(tools: string[], declared: string): boolean {
  const target = normalizeToolName(declared);
  return tools.some((tool) => normalizeToolName(tool) === target);
}

/**
 * Resolve every declared capability against the live registrations.
 *
 * Later servers do not silently override earlier ones: the first server that
 * genuinely provides a capability wins, and a duplicate declaration on a server
 * that also provides it is simply unused. Silent override would make which
 * server posts your comments depend on object key order.
 */
export function resolveCapabilities(
  config: ResolvedConfig,
  registrations: ServerRegistration[],
): CapabilityReport {
  const byId = new Map(registrations.map((entry) => [entry.id, entry]));
  const resolved: ResolvedCapability[] = [];
  const missing: MissingCapability[] = [];
  const claimed = new Set<CapabilityName>();

  for (const [serverId, definition] of Object.entries(config.mcp.servers)) {
    if (definition.enabled === false || !definition.capabilities) {
      continue;
    }
    const registration = byId.get(serverId);

    for (const [capability, binding] of Object.entries(
      definition.capabilities,
    )) {
      if (!binding) {
        continue;
      }
      const name = capability as CapabilityName;
      const toolName = typeof binding === "string" ? binding : binding.tool;
      const args = typeof binding === "string" ? undefined : binding.args;
      if (!toolName) {
        continue;
      }

      if (!registration || !registration.ok) {
        missing.push({
          capability: name,
          serverId,
          declared: toolName,
          available: [],
        });
        continue;
      }

      if (!advertises(registration.tools, toolName)) {
        missing.push({
          capability: name,
          serverId,
          declared: toolName,
          available: registration.tools,
        });
        continue;
      }

      if (claimed.has(name)) {
        continue;
      }
      claimed.add(name);
      resolved.push({
        capability: name,
        serverId,
        toolName,
        ...(args ? { args } : {}),
        stages: definition.stages ?? STAGE_ORDER,
        roles: definition.roles ?? ["main", "sub"],
      });
    }
  }

  return { resolved, missing, registrations };
}

/**
 * Fail a live run that cannot do the job it claims to do.
 *
 * Dry runs are allowed to proceed without posting capabilities — that is exactly
 * what a dry run is for — but a live run without them would review a PR and then
 * throw the findings away, which reads to the team as "Yama found nothing".
 */
export function assertLiveCapabilities(
  report: CapabilityReport,
  mode: RunMode,
  config: ResolvedConfig,
): void {
  if (mode !== "live") {
    return;
  }

  const problems: string[] = [];

  if (report.missing.length > 0) {
    for (const entry of report.missing) {
      const detail =
        entry.available.length > 0
          ? `it advertises: ${entry.available.slice(0, 25).join(", ")}`
          : `that server registered no tools at all`;
      problems.push(
        `  ${entry.capability}: "${entry.serverId}" declares tool "${entry.declared}" but ${detail}`,
      );
    }
  }

  const have = new Set(report.resolved.map((entry) => entry.capability));
  const required = new Set<CapabilityName>(REQUIRED_LIVE_CAPABILITIES);

  // Ownership and status blocking are only required when the project asked for
  // them — enforcing what cannot be read is worse than not enforcing at all.
  if (
    config.ownership.some((rule) => rule.blocking) ||
    config.checks.checks.some(
      (check) => check.type === "builtin.owners" && check.blocking,
    )
  ) {
    required.add("listApprovals");
  }

  for (const capability of required) {
    if (!have.has(capability)) {
      problems.push(
        `  ${capability}: not provided by any configured server. Add it to a server's ` +
          `\`capabilities:\` block in .yama/mcp.yaml.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new CapabilityError(
      `This live run cannot complete — required capabilities are unavailable:\n` +
        `${problems.join("\n")}\n` +
        `Run \`yama doctor\` to list every tool each server advertises.`,
      report.missing,
    );
  }
}

/**
 * A lookup for one stage and role.
 *
 * Stage scoping is a security control, not bookkeeping: review turns must not be
 * able to post, and posting turns must not be able to review. Handing the wrong
 * stage's tools to an agent reviewing attacker-controlled code is how a prompt
 * injection turns into a write.
 */
export class CapabilityResolver {
  constructor(private readonly report: CapabilityReport) {}

  /** Every capability available in a stage for a role. */
  available(stage: StageName, role: McpRole = "main"): ResolvedCapability[] {
    return this.report.resolved.filter(
      (entry) => entry.stages.includes(stage) && entry.roles.includes(role),
    );
  }

  /** Look up one capability, or undefined when it is unavailable here. */
  find(
    capability: CapabilityName,
    stage: StageName,
    role: McpRole = "main",
  ): ResolvedCapability | undefined {
    return this.available(stage, role).find(
      (entry) => entry.capability === capability,
    );
  }

  /**
   * Look up one capability, or throw naming the stage.
   *
   * Used by deterministic code paths, where a missing capability is a bug in the
   * config rather than something to route around.
   */
  require(
    capability: CapabilityName,
    stage: StageName,
    role: McpRole = "main",
  ): ResolvedCapability {
    const found = this.find(capability, stage, role);
    if (!found) {
      const elsewhere = this.report.resolved.find(
        (entry) => entry.capability === capability,
      );
      throw new CapabilityError(
        elsewhere
          ? `Capability "${capability}" exists on "${elsewhere.serverId}" but is not ` +
            `exposed during the "${stage}" stage. Add "${stage}" to that server's ` +
            `\`stages:\` list in .yama/mcp.yaml.`
          : `Capability "${capability}" is not provided by any configured server.`,
        [],
      );
    }
    return found;
  }

  /** Tool names exposed in a stage — what the agent is allowed to see. */
  toolNames(stage: StageName, role: McpRole = "main"): string[] {
    return [
      ...new Set(this.available(stage, role).map((entry) => entry.toolName)),
    ];
  }

  get missing(): MissingCapability[] {
    return this.report.missing;
  }

  get all(): ResolvedCapability[] {
    return this.report.resolved;
  }
}
