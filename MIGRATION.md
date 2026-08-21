# Migration guide

How to move an existing Yama installation to the current version. If you are
setting Yama up for the first time, start at
[docs/v4/04-onboarding.md](docs/v4/04-onboarding.md) instead.

- [v3 → v4](#v3--v4) — current
- [New in v4, optional](#new-in-v4-optional) — nothing breaks if you skip these
- [Older migrations](#older-migrations) — v2 → v3

---

# v3 → v4

Your existing single-file config keeps working the whole time. Migrate when you
are ready.

```bash
npx @juspay/yama migrate           # shows what moves where, writes nothing
npx @juspay/yama migrate --write   # applies it
npx @juspay/yama doctor --live --pr <n>   # proves the result
npx @juspay/yama review --pr <n> --dry-run
```

Delete the old `yama.config.yaml` once you are satisfied. Until you do, Yama
loads it, adapts it, and says so with a notice on every run.

## Requirements

- **Node 20.18.1 or newer.**
- **A full checkout.** v4 reads the diff from the local repository. A shallow
  clone produces a _wrong_ diff, not an absent one — use `fetch-depth: 0`.

## Config becomes a file tree

Only `.yama/yama.yaml` and `.yama/mcp.yaml` are required. Every other file
absent means "that capability is off", never "broken".

| v3                                                 | v4                                                 |
| -------------------------------------------------- | -------------------------------------------------- |
| `ai.*`                                             | `.yama/yama.yaml`                                  |
| `ai.explore.*`                                     | `ai.subAgent`, `ai.judge`, `ai.compaction`         |
| `mcpServers.servers.*`                             | `.yama/mcp.yaml`, plus a capability map            |
| `review.excludePatterns`                           | `.yama/review.yaml` — now enforced in code         |
| `review.blockingCriteria`                          | `.yama/policy/guards.yaml`                         |
| `review.focusAreas`, `review.workflowInstructions` | `.yama/knowledge/**`                               |
| `projectStandards.*`                               | `.yama/rules/*.yaml`                               |
| — (new)                                            | `.yama/checks.yaml`, `.yama/policy/ownership.yaml` |

## Breaking changes

### Model slots take a list

A scalar still works and means a chain of one.

```yaml
ai:
  provider: [litellm, litellm]
  model: [qwen3.8-27b-fast, deepseek-v4-flash]
  timeout: 600000 # per model call — a hang detector, not a budget
```

Arrays pair by position; a single provider broadcasts across many models and
vice versa; mismatched lengths are a loud error naming both counts. The chain
advances when a model errors **and** when it returns an empty response — the
latter is not an error but is not a review either.

Yama walks the chain itself and pins the runtime's own fallback off. Left to
itself the runtime resolves to whichever provider happens to have credentials in
the environment, so a run could succeed on a model nobody configured while the
report said it worked.

### Servers need a capability map

Code no longer knows any tool name — it asks for a capability and
`.yama/mcp.yaml` supplies the name. `migrate` infers the map for well-known
servers and leaves a TODO for anything it cannot. `doctor --live` verifies every
entry against the running server and prints what that server really advertises
when a name is wrong.

A mapping is either a tool name or a tool name plus arguments pinned to every
call. The object form exists because modern VCS servers consolidate many
operations behind one tool selected by a parameter — and that parameter is part
of the mapping, never part of Yama:

```yaml
capabilities:
  postSummary: add_issue_comment # a bare name
  readPullRequest: { tool: pull_request_read, args: { method: get } }
  listChangedFiles: { tool: pull_request_read, args: { method: get_files } }
```

### Inline comments may need a review opened around them

Where a provider only accepts an inline comment attached to an open review, map
`beginReview` **and** `submitReview`; the post stage brackets its comments with
them. Map both or neither — half the pair writes comments on a review that is
never submitted, which are invisible to everyone. `doctor` fails on an unpaired
mapping.

### Prompt text has no v4 home

v3 concatenated `focusAreas` and `workflowInstructions` into every prompt. v4
has no prompt to put them in: the system instruction is a static constant, and
everything else reaches the agent through tools. `migrate` writes them to
`.yama/knowledge/` where they are retrieved on demand. They are neither silently
dropped nor silently injected — but they do reach the model differently, and
that is a real behaviour change.

### `review.verification` becomes `review.confidenceThreshold`

`migrate` translates it: `off` → `0`, `strict` → `90`, anything else → the
default `80`. Unlike v3's critic mode, this one is enforced — every
agent-sourced finding is scored by the `ai.judge` slot and refused below the
bar. Set `0` to turn scoring off entirely and save a model call per submission.

### Dropped keys

Reported by name during migration. None of them were read by v3 either:
`performance.tokenBudget`, `performance.costControls`,
`performance.maxReviewDuration`, `review.toolPreferences`,
`review.workflowInstructions`, `review.contextLines`,
`review.fileAnalysisTimeout`, `descriptionEnhancement.autoFormat`,
`monitoring.exportFormat`.

### Tools were renamed

Only relevant if you wrote rules or knowledge files that name a tool:

| v3                | v4                                              | Why                                                       |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `submit_review`   | `submit_finding`                                | It gates one finding set, not a review                    |
| `explore_context` | `delegate_*`                                    | Specialists are isolated agents, one delegation tool each |
| —                 | `report_progress`                               | How a turn tells the harness its plan and when it is done |
| —                 | `read_file`, `list_files`, `search_code`, `git` | Local reads, sandboxed to the repo                        |

## New, and off by default

- **Checks** — run your linters and report their output as inline findings.
  Config and scripts are read from the base branch, never the pull request, and
  forks are off unless explicitly enabled.
- **Ownership** — deterministic path-to-owner rules, one grouped comment.
- **Learning** — updates `.yama/rules/learned.yaml`, the product impact ledger,
  and a scorecard when a pull request merges. Requires write credentials and is
  off until configured.
- **Bootstrap** — `yama bootstrap` mines merged pull requests once and proposes
  a starting knowledge base. It never commits; you open the files as a pull
  request.

## After you migrate

1. `yama config` — read the resolved result and every notice.
2. `yama doctor --live --pr <n>` — every `✗` carries a remedy line.
3. `yama review --pr <n> --dry-run` — compare against what v3 posted.
4. Delete `yama.config.yaml`.

---

# New in v4, optional

Both keys below are optional, default to off, and preserve existing behaviour if
you leave them out.

## `prompts:` — manage prompt text on Langfuse

Lets you iterate on wording without cutting a release.

```yaml
# .yama/yama.yaml
prompts:
  enabled: true # default false
  provider: langfuse
  label: production # or: version: 3
  timeoutMs: 10000
  publicKeyEnv: LANGFUSE_PUBLIC_KEY # these three are the defaults
  secretKeyEnv: LANGFUSE_SECRET_KEY
  baseUrlEnv: LANGFUSE_BASE_URL
  only: [yama-review] # optional: manage just some prompts
```

Prompt ids: `yama-review`, `yama-judge`, `yama-triage`, `yama-bootstrap`,
`yama-extraction`, `yama-subagent-impact`, `yama-subagent-security`,
`yama-subagent-history`, `yama-subagent-tests`, `yama-subagent-conventions`.
(`yama-description` is accepted but no call site reads it yet.)

Every failure path — credentials unset, no network, no entry for that id, a
timeout, the SDK missing — falls back to the text Yama ships, adds a warning,
and continues the run. Prompts are fetched once per run. `yama doctor` prints a
**Prompts:** section saying which came from the platform and which are built in.

## `review.description.sections` — require sections in the description

```yaml
# .yama/review.yaml
description:
  sections:
    - { title: "Testing", required: true }
    - { title: "Rollback", required: true }
```

S5 verifies these by re-reading the pull request after the agent updates it, not
by believing the agent said it wrote them. A missing required section re-prompts
the stage. With no `sections`, S5 only has to prove the description actually
changed — which is the previous behaviour.

## Behaviour that changed without a config change

None of these need action, but they change what a run does:

- **`parse: agent` checks now work.** They were a stub that returned nothing. A
  check's raw output is now turned into findings by one schema-bound pass on the
  `ai.extraction` slot; `hint:` describes the output shape. If extraction fails,
  the check is reported FAILED rather than "no findings".
- **`review.confidenceThreshold` is enforced.** It previously had no effect.
  Every agent-sourced finding is now scored and refused below the threshold
  (default 80). Set `0` to restore the old no-op behaviour and save a model call
  per submission.
- **The product model is loaded and used.** `.yama/product/capabilities.yaml`
  and `.yama/product/impact-log/*.yaml` are read at startup, surfaced through
  `recall`, and produce an **Impact** section in the summary comment. Absent,
  impact analysis degrades quietly.
- **`yama learn` writes more.** In addition to `.yama/rules/learned.yaml` it now
  writes `.yama/product/impact-log/pr-<n>.yaml` and
  `.yama/knowledge/scorecard.md`, and consumes and deletes the per-pull-request
  artifact. All in one commit.
- **Every model call is schema-bound.** Mostly invisible, with one exception:
  if a run warns that a structured result was truncated, raise `ai.maxTokens`
  for the slot the warning names.
- **GitHub Action outputs work.** `decision`, `posted`, `critical`, `major`,
  `partial` and `summary` are populated from the run report, and
  `fail-on-blocked` actually fires. They were previously always empty.
- **`yama bootstrap` and `yama config` exist.** `bootstrap` was documented but
  missing; `config` prints the fully resolved configuration.

---

# Older migrations

Still accurate for anyone upgrading from v2. If you are already on v3, skip
this and read [v3 → v4](#v3--v4).

## v2 → v3

**Removed API:**

| Removed                        | Replacement                                    |
| ------------------------------ | ---------------------------------------------- |
| `setupV2CLI()`                 | `setupCLI()`                                   |
| `src/cli/v2.cli.ts` entrypoint | `src/cli/cli.ts` (the `yama` bin is unchanged) |
| `GetIssueResponse` (type)      | removed with Jira                              |

`YamaV2Orchestrator`, `createYamaV2()` and `YamaV2Config` remained as deprecated
aliases for `YamaOrchestrator`, `createYama()` and `YamaConfig`.

**Jira removed.** Drop `mcpServers.jira` from your config; `JIRA_EMAIL`,
`JIRA_API_TOKEN` and `JIRA_BASE_URL` are no longer read. Add Jira back as a
user-configured MCP server if you still want that context.

**`mcpServers` restructured (breaking).** Server definitions moved under
`mcpServers.servers.<id>` as full generic definitions. The old flat shape
(`mcpServers.bitbucket: {...}` at the top level) is rejected at startup rather
than silently producing a review with no tools.

**Also removed:** `ai.enableToolFiltering` and `ai.toolFilteringMode`.
Destructive-tool safety moved to each server's `blockedTools` denylist and
fail-closed `allowedTools` allowlist.

**Config precedence:** `.yama/config.yaml` became preferred;
`yama.config.yaml` still loaded with a deprecation warning.

**`ai.temperature` stopped defaulting to `0.2`** (and `ai.explore.temperature`
to `0.1`). Unset means the provider's own default applies — set them explicitly
to keep the old behaviour.

**Project MCP became opt-in.** `.yama/mcp.json` can launch local processes and
lives in the reviewed checkout, so it is not loaded unless
`YAMA_ENABLE_PROJECT_MCP=true` is set from a trusted context. The same caution
applies to the main config in CI that reviews untrusted forks.

**Behaviour changes in v3:**

- The decision policy became code-derived: any CRITICAL finding, or MAJOR
  findings at or above the threshold (default 3), reports `BLOCKED` regardless
  of the model's own approval signal.
- The verdict moved to structured output; Yama stopped hand-parsing JSON out of
  model text, and an unparseable verdict failed safe to `CHANGES_REQUESTED`
  instead of `APPROVED`.
- Partial reviews stopped being able to approve.
- New opt-in keys with behaviour-preserving defaults: `state.*` (cross-run
  review state at `.yama/state`), `review.verification` (the `submit_review`
  gate), `performance.loop.*`, `ai.conversationMemory.contextCompaction`,
  `ai.mcpOutputLimits`, and `.yama/rules/**`.
- One intentional default change: `performance.maxReviewDuration` became unset
  (was `15m`), so reviews were bounded by work rather than wall clock and could
  take longer.
- `yama doctor` was introduced.
