/**
 * Shared tool-safety policy helpers.
 *
 * Centralizes git mutation detection so the orchestrator, the explorer, and the
 * MCP server manager all agree on what is read-only. Uses a fail-closed
 * allow-list: any `git_*` tool NOT on the read-only list is treated as mutating.
 * The previous per-file blocklists silently missed mutating tools such as
 * `git_branch`, `git_mv`, `git_pull`, `git_fetch`, `git_restore`, `git_switch`,
 * and `git_remote`, leaving them exposed in "read-only" review modes.
 */

/** Strip server/namespace prefixes, e.g. "local-git:git_status" -> "git_status". */
export function normalizeToolName(name: string): string {
  return name.split(/[.:/]/).pop() || name;
}

/** Git MCP tools that only READ repository state and are always safe to expose. */
export const READ_ONLY_GIT_TOOLS: ReadonlySet<string> = new Set([
  "git_status",
  "git_log",
  "git_show",
  "git_diff",
  "git_diff_staged",
  "git_diff_unstaged",
  "git_blame",
]);

/**
 * Returns true if the given tool is a git tool that can MUTATE repository state.
 *
 * Fail-closed: any `git_*` tool not on the read-only allow-list is treated as
 * mutating. Non-git tools return false — callers handle provider-specific
 * mutation tool lists (e.g. Bitbucket/GitHub write tools) separately.
 */
export function isMutatingGitTool(toolName: string): boolean {
  const name = normalizeToolName(toolName).toLowerCase();
  if (!name.startsWith("git_")) {
    return false;
  }
  return !READ_ONLY_GIT_TOOLS.has(name);
}
