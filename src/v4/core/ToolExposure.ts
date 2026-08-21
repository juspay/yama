/**
 * Stage-scoped tool exposure, and which specialists are in play.
 *
 * Kept out of `Runtime.ts` deliberately: that file imports the provider SDK, and
 * these two decisions are the ones most worth testing. A test that has to
 * construct a real client to check that a review turn cannot see a posting tool
 * is a test nobody runs.
 */

import type {
  McpRole,
  ResolvedCapability,
  RuntimeHost,
  StageName,
  SubAgentDefinition,
  YamaTool,
} from "../types/index.js";

/** Expose the Yama tools a given stage and role may use, and hide the rest. */
export function applyStageTools(
  host: RuntimeHost,
  tools: YamaTool[],
  stage: StageName,
  role: McpRole,
): YamaTool[] {
  const visible = tools.filter(
    (tool) => tool.stages.includes(stage) && tool.roles.includes(role),
  );
  const hidden = tools.filter((tool) => !visible.includes(tool));

  for (const tool of hidden) {
    host.unregisterTool?.(tool.name);
  }
  for (const tool of visible) {
    host.registerTool?.(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: (params: unknown) =>
        tool.execute((params ?? {}) as Record<string, unknown>),
    });
  }
  return visible;
}

/** Sub-agent definitions filtered to those the config enabled. */
export function enabledSubAgents(
  definitions: SubAgentDefinition[],
  enabled: string[] | undefined,
): SubAgentDefinition[] {
  if (!enabled || enabled.length === 0) {
    return definitions;
  }
  const wanted = new Set(enabled);
  return definitions.filter((definition) => wanted.has(definition.id));
}

/**
 * MCP tools to hide from the agent for the duration of one stage.
 *
 * The `stages:` list in the capability map is what makes "a review turn cannot
 * post" true. Until this existed it was only half true: Yama's own code
 * consulted the stage list before invoking a capability, but the MCP server was
 * registered once for the whole run, so every tool it advertised stayed within
 * the model's reach on every turn. An agent reading an attacker-controlled diff
 * could be talked into calling one directly.
 *
 * A tool is hidden only when NO capability it backs is available in this stage.
 * Providers routinely put many operations behind one tool selected by an
 * argument, so excluding on the first non-matching capability would take the
 * read path down with the write path.
 *
 * Deliberately a denylist, not an allowlist: the architecture treats any server
 * a team connects as first-class and leaves tool choice to the agent's
 * judgement. An allowlist would silently amputate every tool the capability map
 * does not happen to name.
 */
export function excludedToolsForStage(
  capabilities: ResolvedCapability[],
  stage: StageName,
  role: McpRole,
  /** Every tool discovered on every registered server, mapped or not. */
  discoveredTools: string[] = [],
): string[] {
  const availableNow = new Set<string>();
  const everAvailable = new Set<string>();

  for (const capability of capabilities) {
    everAvailable.add(capability.toolName);
    if (capability.stages.includes(stage) && capability.roles.includes(role)) {
      availableNow.add(capability.toolName);
    }
  }

  const excluded = new Set(
    [...everAvailable].filter((name) => !availableNow.has(name)),
  );

  // Capability scoping only covers tools the config MAPPED. A server a team
  // connects for reading (a git MCP server, say) can also advertise mutating
  // tools nobody mapped to anything — and unmapped meant unscoped, so
  // git_commit/git_push stayed callable while the agent read an
  // attacker-controlled diff. During any stage where a tool's own capability
  // would not be exposed, an unmapped tool whose name says it writes is
  // excluded too. Verb-based on purpose: it holds for servers Yama has never
  // seen, and a false positive costs a read-only tool one stage of absence
  // while a false negative is a prompt-injection-to-write path.
  for (const name of discoveredTools) {
    if (everAvailable.has(name)) {
      continue; // capability-mapped: its stage list is the authority
    }
    if (looksMutating(name) && !availableNow.has(name)) {
      excluded.add(name);
    }
  }

  return [...excluded];
}

/** Does a tool's name declare a write? Mirrors the dry-run backstop's verbs. */
const MUTATING_VERBS =
  /^(add|create|post|update|edit|delete|remove|set|submit|merge|approve|close|reopen|assign|dismiss|push|write|commit|reset|revert|checkout|rebase|apply|stash|clean|rm|mv|init|clone|fetch|pull)$/i;

export function looksMutating(toolName: string): boolean {
  const segments = toolName
    .replace(/^mcp[_-]/, "")
    .split(/[_-]/)
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  // The verb is positional: tools name themselves verb-first
  // ("create_pull_request") or server-then-verb ("git_commit"). Testing every
  // segment would misread "list_pull_requests" as mutating because of "pull".
  const verbAt = (index: number): boolean => {
    const segment = segments[index];
    if (segment === undefined || !MUTATING_VERBS.test(segment)) {
      return false;
    }
    // "pull" the verb (git pull) is mutating; "pull request" the noun is not.
    if (
      /^pull$/i.test(segment) &&
      /^requests?$/i.test(segments[index + 1] ?? "")
    ) {
      return false;
    }
    return true;
  };
  return verbAt(0) || verbAt(1);
}
