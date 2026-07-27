# Migration guide — the next release (v3 line)

This release contains **breaking changes** (release with a `BREAKING CHANGE:`
footer / `feat!:` so semantic-release bumps accordingly). The breaking item is
the **legacy flat `mcpServers` config shape being rejected at startup** — see
"Config changes" below. The v3-foundations features further down ship in the
same release and are all backward compatible. Summary of what changed and how
to migrate.

## Public API: removed and deprecated

Removed:

| Removed                        | Replacement                                    |
| ------------------------------ | ---------------------------------------------- |
| `setupV2CLI()`                 | `setupCLI()`                                   |
| `src/cli/v2.cli.ts` entrypoint | `src/cli/cli.ts` (the `yama` bin is unchanged) |
| `GetIssueResponse` (type)      | removed with Jira                              |

Deprecated — still exported as back-compat aliases, will be removed in the
next major:

| Deprecated alias              | Use instead        |
| ----------------------------- | ------------------ |
| `YamaV2Orchestrator` (export) | `YamaOrchestrator` |
| `createYamaV2()`              | `createYama()`     |
| `YamaV2Config` (type)         | `YamaConfig`       |

The runtime class was already named `YamaOrchestrator`; the `V2` names are thin
`@deprecated` aliases kept so existing consumers keep working. Update imports
from `YamaV2Orchestrator` → `YamaOrchestrator` before the next major.

## Jira removed

Native Jira MCP integration is removed end-to-end:

- Config key `mcpServers.jira` is gone; remove it from your config.
- Env vars `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_BASE_URL` are no longer read.
- The `@nexus2520/jira-mcp-server` dependency is dropped.

If you still want Jira context, add it as a **user-configured MCP server** in
`.yama/mcp.json` (see `.yama/README.md`) — but note project MCP is opt-in (below).

## Config changes

- **`mcpServers` is restructured (breaking).** Server definitions now live under
  `mcpServers.servers.<id>` as full generic definitions (transport, command/args/env
  or url/headers, roles, modes, blockedTools/allowedTools) — nothing is hardcoded
  in code anymore. The old flat shape (`mcpServers.bitbucket: {...}` at the top
  level) is **rejected at startup with a clear error** so it cannot silently
  produce a review with no tools. Copy the `mcpServers.servers` block from
  `yama.config.example.yaml` and move your per-server settings into it.
- Removed `ai.enableToolFiltering` and `ai.toolFilteringMode` (the query-level
  Jira-only filter they drove is gone; destructive-tool safety is now enforced
  per server via each definition's `blockedTools` denylist and fail-closed
  `allowedTools` allowlist). Remove these keys.
- **Config precedence:** `.yama/config.yaml` is now preferred. The legacy
  `yama.config.yaml` / `config/yama.config.yaml` still load but emit a deprecation
  warning — move your config to `.yama/config.yaml`.
- **`ai.temperature` no longer defaults to `0.2`** (and `ai.explore.temperature`
  no longer defaults to `0.1`). When unset, the field is omitted from NeuroLink
  `generate()` calls entirely and the provider's own default applies. Set
  `ai.temperature: 0.2` (and `ai.explore.temperature: 0.1`) explicitly to keep
  the previous behavior. Internal deterministic passes (critic, verdict
  follow-up, extraction, learning, memory condensation) keep their fixed low
  temperatures.

## Project MCP is opt-in (security)

`.yama/mcp.json` can launch local processes and lives in the reviewed checkout, so
it is **not loaded unless `YAMA_ENABLE_PROJECT_MCP=true`** is set from a trusted
context (outside the checkout). Set it only where the checkout is trusted; leave it
unset in CI that reviews untrusted PRs. See `.yama/README.md`.

> **Same caution applies to the main config.** `.yama/config.yaml` is auto-loaded
> from the working directory and its `mcpServers.servers` can define stdio servers
> (local commands) and remote URLs/headers with `${ENV}` substitution. If your CI
> checks out untrusted code (e.g. fork PRs) with secrets in the environment, do not
> rely on the checkout's config: pass a trusted config explicitly via `--config` /
> the action's `config-path` input, or restrict the workflow to same-repo PRs (as
> Yama's own self-review workflow does).

## Behavior changes

- **Decision policy is code-derived:** a PR with any CRITICAL finding — or MAJOR
  findings at/above the block threshold (default 3) — is reported `BLOCKED`
  regardless of the AI's own approval signal.
- `--dry-run` (PR mode) is enforced via the review prompt; state-changing tools are
  restricted per server through config (`blockedTools`/`allowedTools`), not by a
  dry-run-specific tool filter. In local mode the reviewer runs against read-only
  git tools regardless.
- The review verdict is produced through NeuroLink's native structured output: a
  zod schema is passed to `generate()`, enforced at the wire where the provider
  supports tools+schema and coerced/repaired by NeuroLink otherwise. Yama no
  longer hand-parses JSON out of model text.
- An unparseable final verdict (prose or truncated output instead of the structured
  JSON) now fails safe to `CHANGES_REQUESTED` instead of defaulting to `APPROVED`.

## NeuroLink

Upgraded to `@juspay/neurolink@^10.4.1` (Node `>=20.18.1`). If you consume Yama as a
library, ensure your runtime meets that floor.

## v3 foundations (same release)

**No additional breaking changes.** All new capabilities are opt-out/opt-in
config keys with behavior-preserving defaults:

| New key                                   | Default                                  | Effect                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.{enabled,store,path}`              | `file` store at `.yama/state`            | Cross-run review state: incremental re-review, no duplicate comments, agent-verified fixes resolved, findings ignored 3+ runs auto-suppressed. Disable with `state.enabled: false`. |
| `review.verification`                     | `basic`                                  | The `submit_review` gate: the agent must submit candidate findings before posting; a critic pass rejects incoherent/inflated/evidence-free ones. `off` restores dedup-only.         |
| `performance.loop.*`                      | `maxSteps: 100`, `toolTimeoutMs: 300000` | Loop guards actually enforced on generate() calls; `turnTimeoutMs` falls back to `performance.maxReviewDuration`.                                                                   |
| `ai.conversationMemory.contextCompaction` | enabled, threshold 0.8                   | NeuroLink auto-compaction for long reviews.                                                                                                                                         |
| `ai.mcpOutputLimits`                      | `externalize` at 100 KB                  | Oversized MCP tool outputs are paged on demand instead of flooding context.                                                                                                         |
| `.yama/rules/**`                          | none                                     | Structured team rules (id/scope/severity/blocking + examples). Violated blocking rules force BLOCKED deterministically.                                                             |

Behavioral notes:

- **Partial reviews can no longer approve.** A review that hits a step cap,
  context cap, timeout, or truncated JSON is marked partial
  (`result.completion`) and an AI "APPROVED" is downgraded to
  CHANGES_REQUESTED.
- Project docs (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.clinerules`,
  `CONTRIBUTING.md`) are now injected into the main review prompt as team
  conventions (previously explorer-only).
- New CLI command: `yama doctor` — static config validation + capability
  profile + degradation notes.
