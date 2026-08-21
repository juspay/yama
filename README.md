# ⚔️ Yama — AI-Native Code Review Guardian

Yama reviews a pull request the way a senior engineer on your team would: it
reads the code, proves a problem before claiming it, and tells the author how to
fix it. It posts inline comments with concrete fixes, runs your existing checks,
tags the right owners, and derives a verdict in code.

Ships as a CLI, a GitHub Action, and an SDK.

---

## Quick start

Yama needs the repository checked out and a `.yama/` directory. Four commands
take you from nothing to a reviewed pull request:

```bash
npx @juspay/yama init                    # inspect the repo, print the plan, write nothing
npx @juspay/yama init --write            # apply it
npx @juspay/yama doctor --live --pr 42   # connect for real and prove it works
npx @juspay/yama review --pr 42 --dry-run
```

Then drop the `--dry-run` when you like what it says it would post.

`init` writes `.yama/yama.yaml` (models), `.yama/mcp.yaml` (connections and the
capability map), and — only if it detected lint/test scripts — a **disabled**
`.yama/checks.yaml`. You then fill in two things in `mcp.yaml`: the MCP endpoint
for your VCS, and which tool provides each capability.

Run `doctor --live` before your first review and after any config change. It
connects to every configured server, lists what each one actually advertises,
resolves every capability against that list, and reads a real pull request, so a
wrong tool name or a revoked token fails at setup rather than twenty minutes
into a review.

**Requirements:** Node 20.18.1 or newer, and a full checkout (`fetch-depth: 0`).
Yama computes the change set with `git diff base...head` from disk; a shallow
clone is refused with that message rather than reviewed against the wrong base.

---

## How it works

A single agent session works through seven stages, each with an exit condition
checked in code:

```
S0 RESOLVE   find the pull request and read its metadata
S1 ORIENT    build a review plan; your checks start running in parallel
S2 REVIEW    the agent works its plan, delegating to specialists as it judges
S3 POST      inline comments, opened as a review and submitted after
S4 CHECKS    your linters and tests; owners tagged deterministically
S5 ENHANCE   rewrite the pull request description
S6 VERDICT   summary comment and decision
```

Two things are worth knowing as a user. First, a stage that fails its exit
condition re-prompts the agent in the same session naming exactly what is
missing, up to `review.remediation.maxAttemptsPerStage` times, after which the
stage is recorded `degraded` and the summary says so — **a partial run never
ends APPROVED**. Second, the verdict is computed from what actually posted (a
finding counts only when the posting tool returned a comment id), so a
prompt-injected "approve" inside a diff cannot clear a blocking finding.

The design and the reasoning behind it live in
[docs/v4/01-architecture.md](docs/v4/01-architecture.md).

---

## Commands

| Command          | What it does                                                         |
| ---------------- | -------------------------------------------------------------------- |
| `yama init`      | Inspect the repository and write a starting `.yama/`                 |
| `yama migrate`   | Split an existing v3 `yama.config.yaml` into the v4 file tree        |
| `yama doctor`    | Prove the setup — config, connections, capabilities, credentials     |
| `yama config`    | Print the fully resolved configuration and every notice              |
| `yama review`    | Review a pull request                                                |
| `yama bootstrap` | Mine merged pull requests once and propose a starting knowledge base |
| `yama learn`     | Learn from a merged pull request and commit what it taught           |

Every command accepts `-C, --cwd <path>` to point at a repository root other
than the current directory.

| Command     | Flags                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`      | `--write` · `--provider <name>` · `--token-env <name>` (default `YAMA_VCS_TOKEN`) · `--ai-provider <list>` · `--ai-model <list>` · `--checks <list>` · `--enable-learning` |
| `migrate`   | `--write`                                                                                                                                                                  |
| `doctor`    | `--live` · `--learn` · `--pr <number>`                                                                                                                                     |
| `review`    | `--pr <number>` · `--branch <name>` · `--base <ref>` (default `origin/main`) · `--head <ref>` (default `HEAD`) · `--dry-run`                                               |
| `bootstrap` | `--write` · `--window <count>` (default 15)                                                                                                                                |
| `learn`     | `--pr <number>` (required) · `--dry-run`                                                                                                                                   |
| `config`    | —                                                                                                                                                                          |

`review` needs either `--pr` or `--branch`. With a branch, Yama resolves the
pull request and reports an ambiguity rather than choosing one.

`review` exits non-zero only when a stage **failed** — a BLOCKED verdict is a
successful run that found problems, and is reported through the summary comment
and the run report rather than through the exit code.

---

## Configuration

Two files are required. Every other file is optional, and absent means "that
capability is off", never "broken".

```
.yama/
  yama.yaml        REQUIRED   models, learning, prompts, state
  mcp.yaml         REQUIRED   connections + capability map + stage exposure
  review.yaml      optional   concurrency, verdict policy, thresholds
  checks.yaml      optional   your linters and tests, as review evidence
  policy/
    ownership.yaml optional   path → owners, minApprovals
    guards.yaml    optional   path → severity floors, required checks
  rules/*.yaml     optional   conventions the reviewer enforces
  knowledge/       generated  what merges taught it
  product/         generated  capability map and impact ledger
  state/           generated  per-pull-request artifacts
  reports/         generated  one JSON run report per review
```

Run `yama config` at any point to see exactly what Yama resolved, after
defaults, files, and environment overrides.

### `yama.yaml`

```yaml
version: 4

ai:
  provider: [litellm, litellm]
  model: [qwen3.8-27b-fast, deepseek-v4-flash]
  temperature: 0.1
  maxTokens: 32000
  timeout: 600000 # per model call — a hang detector, not a budget
  pool: { strategy: priority, cooldownMs: 60000 }

  # Cheap slots for work that does not benefit from deliberation.
  judge: { provider: litellm, model: qwen3.8-27b-fast, temperature: 0 }
  subAgent: { provider: litellm, model: qwen3.8-27b-fast }
  extraction: { provider: litellm, model: qwen3.8-27b-fast, temperature: 0 }
```

Every model slot is a **fallback chain**. Lists pair by position; a single
provider broadcasts across many models and vice versa; mismatched lengths are a
loud error naming both counts. The chain advances when a call fails and when it
returns an empty response. Per-slot overrides inherit the base chain for
anything they do not set.

**Model slots**, and what each one pays for:

| Slot         | Used for                                                          |
| ------------ | ----------------------------------------------------------------- |
| `review`     | The main review session, and the `bootstrap` draft                |
| `subAgent`   | The delegated specialists (security, tests, history, conventions) |
| `judge`      | Inline confidence scoring, and merge-time triage in `yama learn`  |
| `extraction` | Turning a `parse: agent` check's raw output into findings         |
| `compaction` | Compacting a long session's context                               |
| `memory`     | Memory condensation                                               |

`compaction` and `memory` take a single provider+model upstream, so Yama picks
the first reachable chain member with a startup probe: they fail over between
runs, not mid-run. `doctor` labels every slot with which kind it is.

`description` and `scorecard` are also accepted as slots and printed by
`doctor`, but no call site reads them today — the description is written by the
main review session and the scorecard is computed without a model. Setting them
changes nothing.

Other `yama.yaml` blocks:

| Key                            | Default               | Effect                                                |
| ------------------------------ | --------------------- | ----------------------------------------------------- |
| `ai.excludeRuntimeTools`       | none                  | Runtime tool names to drop before the agent sees them |
| `state.enabled` / `state.path` | `true`, `.yama/state` | Per-pull-request artifact so re-runs are incremental  |
| `observability.reportPath`     | `.yama/reports`       | Where the JSON run report is written                  |
| `learn.*`                      | disabled              | See [Learning](#learning)                             |
| `prompts.*`                    | disabled              | See [Prompt management](#prompt-management)           |

### `mcp.yaml` — capabilities, not tool names

Yama's code never names a tool. It asks for a **capability**, and `mcp.yaml`
supplies the tool — which is what lets one code path drive GitHub, Bitbucket, or
anything else you configure.

```yaml
servers:
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: "Bearer ${YAMA_GITHUB_TOKEN}"
    capabilities:
      # A bare string is the tool name.
      postSummary: add_issue_comment
      # The object form pins arguments the tool needs on every call — modern VCS
      # servers put many operations behind one tool selected by a parameter.
      readPullRequest: { tool: pull_request_read, args: { method: get } }
      listChangedFiles: { tool: pull_request_read, args: { method: get_files } }
      # Inline comments attach to an open review, so it is opened before they
      # are written and submitted after. Map both or neither.
      beginReview: { tool: pull_request_review_write, args: { method: create } }
      postInlineComment: add_comment_to_pending_review
      submitReview:
        {
          tool: pull_request_review_write,
          args: { method: submit_pending, event: COMMENT },
        }
    # Posting is exposed only in the stages that post. A review turn reading an
    # attacker-controlled diff must not be able to write to the pull request.
    stages: [resolve, orient, post, checks, enhance, verdict]
    blockedTools: [push_files, create_or_update_file, merge_pull_request]
```

Capability names Yama understands: `readPullRequest`, `findPullRequest`,
`listComments`, `listApprovals`, `listChangedFiles`, `beginReview`,
`postInlineComment`, `submitReview`, `updateComment`, `postSummary`,
`resolveComment`, `setStatus`, `updateDescription`, `listMergedPullRequests`,
`codeIntel`, `readTicket`.

Stage names for `stages:`: `resolve`, `orient`, `review`, `post`, `checks`,
`enhance`, `verdict`.

Per-server keys: `enabled`, `transport` (`stdio` | `http` | `sse` |
`websocket`), `command` / `args` / `env` for stdio, `url` / `headers` for
remote, `capabilities`, `stages`, `roles` (`main` | `sub`), `blockedTools`,
`allowedTools`, `timeout`, `retryConfig`. Unrecognised keys pass straight
through to the runtime.

`.yama/` in this repository is a working reference configuration.

### `review.yaml`

| Key                                | Default            | Effect                                                      |
| ---------------------------------- | ------------------ | ----------------------------------------------------------- |
| `concurrency.power`                | `medium`           | `high` \| `medium` \| `low` — ceiling on specialist fan-out |
| `verdict.enabled`                  | `true`             | Set false to review without an approve/block decision       |
| `verdict.majorThreshold`           | `3`                | MAJOR findings at or above this block                       |
| `verdict.blockOn`                  | all five reasons   | Global kill switch per reason, not the enrolment            |
| `stages.checks` / `stages.enhance` | `true`             | Skip S4 or S5 entirely                                      |
| `remediation.maxAttemptsPerStage`  | `2`                | Re-prompts before a stage is recorded degraded              |
| `excludePatterns`                  | lockfiles, `dist`… | Enforced in code before the agent sees a file list          |
| `maxFiles`                         | `300`              | Above this the scope is partial, and the summary says so    |
| `confidenceThreshold`              | `80`               | 0–100; agent findings scoring below it are refused          |
| `changedLinesOnly`                 | `true`             | Comment only on lines this pull request changed             |
| `description.sections`             | none               | Sections the enhanced description must contain              |
| `deadline`                         | none               | Wall-clock ceiling for the run, e.g. `45m`                  |

`blockOn` accepts `CRITICAL`, `MAJOR_THRESHOLD`, `blocking-rule`,
`blocking-check`, `unapproved-ownership`.

**`confidenceThreshold`** is enforced: every agent-sourced finding is scored by
the `judge` slot before it can post, and anything under the bar is refused.
Findings that came from a check are not scored — a compiler error is not a
probabilistic claim. Set `confidenceThreshold: 0` to turn scoring off entirely
and save a model call per submission.

**`description.sections`** names sections the rewritten description must
contain. S5 verifies them by re-reading the pull request, not by believing the
agent said it wrote them:

```yaml
description:
  sections:
    - { title: "Testing", required: true }
    - { title: "Rollback", required: true }
```

### Environment overrides

Deliberately narrow — only what a CI operator legitimately flips per run.
Anything that changes review semantics stays in the repository where it is
reviewable.

| Variable                    | Effect                                   |
| --------------------------- | ---------------------------------------- |
| `YAMA_CONCURRENCY`          | `high` \| `medium` \| `low`              |
| `YAMA_VERDICT=false`        | Review without an approve/block decision |
| `YAMA_CHECKS=false`         | Skip configured checks for one run       |
| `YAMA_CONFIDENCE_THRESHOLD` | Inline judge acceptance bar, 0–100       |

---

## Checks

Your existing CI commands become review evidence: the agent reads them before
commenting, so it never duplicates what a linter already said.

```yaml
enabled: true
allowForks: false

checks:
  - id: owners
    type: builtin.owners # deterministic, no model
    source: .yama/policy/ownership.yaml
  - id: lint
    run: "npx eslint src tests --format json"
    parse: eslint
    scope: changed-lines
    maxFindings: 25
    timeoutMs: 300000
  - id: security
    run: "trivy fs --format sarif ."
    parse: sarif
  - id: audit
    run: "pnpm audit --prod --audit-level high --json"
    parse: agent
    hint: >
      pnpm audit JSON. Each advisory has a module name, severity, and a
      vulnerable version range. Report one finding per HIGH or CRITICAL
      advisory against package.json; ignore anything lower.
```

Per-check keys: `id`, `enabled`, exactly one of `run` or `type`, `source`,
`parse`, `hint`, `when.paths`, `severity` (parser level → Yama severity),
`scope` (`changed-lines` | `changed-files` | `repo`), `maxFindings`, `blocking`,
`timeoutMs`, `workingDirectory`.

Parsers: `sarif` · `eslint` · `tsc` · `junit` · `regex` · `agent`.

**`parse: agent`** is the escape hatch for a script no named parser understands.
The check's raw output goes through one schema-bound pass on the `extraction`
slot with tools off, and `hint:` tells it what shape the output has. If the
extraction fails, the check is reported **FAILED** — never "no findings", which
would read as a pass.

**Two rules are not tunable downward.** `checks.yaml` and every script it names
are read from the **base branch**, and Yama refuses to run checks at all if the
head modified one. Fork pull requests get no checks unless `allowForks` is
explicitly enabled. Running repository commands against code from a pull request
is arbitrary code execution with your CI credentials. Both refusals are loud —
the checks stage is reported failed with the reason.

---

## Ownership and guards

`policy/ownership.yaml` maps paths to owners. Deterministic, no model involved,
one grouped comment updated in place on re-runs so nobody is re-tagged.

```yaml
rules:
  - id: core
    paths: ["src/core/**"]
    owners: ["@alice", "@team/core"]
    minApprovals: 1
  - id: migrations
    paths: ["**/migrations/**"]
    owners: ["@team/data"]
    minApprovals: 2
    blocking: true # unapproved → the pull request is blocked
```

An existing `CODEOWNERS` can be imported by `init`; `exclusive: true` preserves
its last-match-wins semantics, and imported rules are non-blocking so importing
never silently changes what can merge.

`policy/guards.yaml` raises the bar on sensitive paths:

```yaml
guards:
  - id: verdict-path
    paths: ["src/core/verdict.ts"]
    severityFloor: MAJOR
    requireChecks: ["test", "typecheck"]
    reason: "Decides what merges"
```

---

## Prompt management

Yama ships every prompt it uses. Optionally, you can manage that text on
Langfuse and iterate on wording without cutting a release.

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

Create entries on the platform under these ids:

| Prompt id                   | Drives                                             |
| --------------------------- | -------------------------------------------------- |
| `yama-review`               | The main review system instruction                 |
| `yama-judge`                | The inline confidence rubric                       |
| `yama-triage`               | Classifying what a merged pull request taught      |
| `yama-bootstrap`            | The one-time history-mining pass                   |
| `yama-extraction`           | `parse: agent` finding extraction                  |
| `yama-subagent-impact`      | The impact specialist                              |
| `yama-subagent-security`    | The security specialist                            |
| `yama-subagent-history`     | The history specialist                             |
| `yama-subagent-tests`       | The tests specialist                               |
| `yama-subagent-conventions` | The conventions specialist                         |
| `yama-description`          | Reserved — accepted, but no call site reads it yet |

Four things to know:

- It is **off by default**. Nothing changes until you set `enabled: true`.
- **Every** failure path — credentials unset, no network, no such prompt, a
  timeout, the SDK missing — falls back to the text Yama ships, adds a warning,
  and continues the run. A platform outage slows nothing and changes nothing.
- Prompts are fetched **once per run**, before the first turn, so every turn
  sends identical bytes and provider prompt caching still applies.
- `yama doctor` prints a **Prompts:** section naming which prompts came from the
  platform (with version) and which are built in, so you never have to assume
  which text a run used.

---

## Learning

Off by default, because it writes to your repository.

```yaml
learn:
  trigger: merge-event # merge-event | push | disabled
  mergeStrategy: rebase # squash | merge | rebase — detected by `yama init`
  mode: commit # or pull-request, for a protected branch
  botIdentity: yama-bot
  git:
    auth: https # or ssh
    tokenEnv: YAMA_GITHUB_TOKEN # for ssh: sshKeyEnv, the key BODY not a path
    userEnv: YAMA_GIT_USER
    remote: "https://github.com/acme/api.git"
    branch: main
```

```bash
npx @juspay/yama doctor --learn   # proves the write path before you rely on it
npx @juspay/yama learn --pr 42 --dry-run
```

On merge, Yama classifies the review conversation — what a human said that Yama
did not (a convention), what Yama said that the author fixed (a confirmation),
and what Yama said that the author dismissed unchanged (a suppression
candidate) — and writes, in **one commit**:

- `.yama/rules/learned.yaml` — kept separate from your hand-written rules, so a
  learn commit's diff shows only what Yama concluded and you can revert it
  without touching your own policy.
- `.yama/product/impact-log/pr-<n>.yaml` — which product capabilities the change
  touched, promoted out of the per-pull-request artifact, which is then deleted.
- `.yama/knowledge/scorecard.md` — precision and recall measured from what
  humans actually did with the comments.
- `.yama/knowledge/learn-watermark.json` — how far learning has got.

**Rebasing repositories** get a sliding window: rebased commits carry no pull
request number, so learning runs on the merge event and catches up over every
merge since the watermark. A run that fails partway does not advance the
watermark, so the next run retries rather than skipping.

Loop prevention is belt and braces: the commit carries `[skip ci]`, **and** the
workflow guards on the actor, **and** it ignores changes under
`.yama/knowledge/**`.

### Bootstrap

`yama learn` improves the knowledge base one merge at a time. `yama bootstrap`
gives it a starting point by reading merged pull requests once.

```bash
npx @juspay/yama bootstrap                 # print the plan, write nothing
npx @juspay/yama bootstrap --write --window 25
```

It proposes `.yama/rules/*.yaml`, `.yama/product/capabilities.yaml`, and
`.yama/profile.md`. It **never commits** — open the written files as a pull
request and read them, because every rule there shapes future reviews and the
corrections you make reviewing them are the strongest signal the system will
receive. Every mined rule starts as a _candidate_: recorded and retrievable, but
not enforced until a reviewer states it again on a real pull request.

Bootstrap needs `listMergedPullRequests` and `listComments` mapped in
`.yama/mcp.yaml` **and** exposed in the `resolve` stage. If fewer than three
merged pull requests carry human review comments, it says so and tells you to
prune the result hard.

### The product model

`.yama/product/capabilities.yaml` and `.yama/product/impact-log/*.yaml` — both
written by `bootstrap` and `learn` — are loaded at startup, surfaced to the
agent through its `recall` tool, and produce an **Impact** section in the
summary comment naming touched capabilities, blast radius, silent failure modes,
and historical risk. Absent, impact analysis degrades quietly to caller tracing.

---

## GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # required — the diff is computed from disk

- uses: juspay/yama@v4
  id: yama
  with:
    pr: ${{ github.event.pull_request.number }}
    vcs-token: ${{ secrets.YAMA_GITHUB_TOKEN }}
  env:
    LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
    LITELLM_BASE_URL: ${{ secrets.LITELLM_BASE_URL }}

- run: echo "${{ steps.yama.outputs.decision }} — ${{ steps.yama.outputs.posted }} comments"
```

| Input             | Default  | Effect                                                       |
| ----------------- | -------- | ------------------------------------------------------------ |
| `pr`              | —        | Pull request number; defaults to the triggering pull request |
| `branch`          | —        | Review a branch; Yama resolves its pull request              |
| `config`          | `.yama`  | Config directory — see the note below                        |
| `dry-run`         | `false`  | Analyse and report without posting                           |
| `concurrency`     | `medium` | `high` \| `medium` \| `low`                                  |
| `verdict`         | `true`   | Set false to review without a decision                       |
| `checks`          | `true`   | Set false to skip configured checks                          |
| `vcs-token`       | —        | Token for the VCS MCP server                                 |
| `fail-on-blocked` | `true`   | Exit non-zero when the verdict is BLOCKED                    |
| `node-version`    | `22`     | Node version to set up                                       |

| Output     | What it carries                                         |
| ---------- | ------------------------------------------------------- |
| `decision` | `APPROVED` \| `CHANGES_REQUESTED` \| `BLOCKED`          |
| `posted`   | Comments actually posted, counted from the tool results |
| `critical` | Critical findings posted                                |
| `major`    | Major findings posted                                   |
| `partial`  | `true` when a stage did not complete                    |
| `summary`  | The verdict and the reasons behind it                   |

Outputs are read from the JSON run report the CLI writes to
`.yama/reports/<runId>.json`, published even when the review failed part-way, so
a caller gating on `partial` still sees it.

The `config` input points at the config directory (default `.yama`). Set it to
a path outside the checkout when CI reviews untrusted pull requests — a pull
request can edit `.yama/` in its own head, and a trusted config passed from
outside is what stops it choosing its own reviewer settings.

Pass the token through `vcs-token`, not `${{ secrets.GITHUB_TOKEN }}` directly:
reserved env names are not reliably forwarded inside a composite action. The
action exports what you pass as **both** `YAMA_VCS_TOKEN` and
`YAMA_GITHUB_TOKEN`, so either convention works in your `mcp.yaml`.

This repository reviews itself — see `.github/workflows/yama-review.yml` and
`.github/workflows/yama-learn.yml`.

---

## Troubleshooting

| Symptom                                       | What to do                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `No configuration found`                      | Run `yama init`, or point `-C` at the right repository root.                                                   |
| `capability:X — "server" declares "tool" …`   | The tool name moved upstream. `doctor --live` prints what the server actually advertises; fix `mcp.yaml`.      |
| `capability pair: beginReview + submitReview` | Map both. Half the pair writes comments on a review nobody ever submits.                                       |
| The run posted nothing and reported success   | Check the run report's Warnings block and `partial`. A degraded stage is reported, never silently swallowed.   |
| A structured result was truncated             | Raise `ai.maxTokens` for that slot — the warning names it.                                                     |
| Checks all skipped on a fork PR               | Expected. `checks.allowForks` is off by default and this is arbitrary code execution with your CI credentials. |
| Checks refused entirely                       | The head branch modified `checks.yaml` or a script it names. Both are read from the base branch on purpose.    |
| `This is a shallow clone`                     | Use `fetch-depth: 0`. A shallow clone produces a _wrong_ diff, not an absent one.                              |
| Learning committed nothing                    | `yama doctor --learn` proves the credential, the remote, and whether the target branch is protected.           |
| Not sure which config actually applied        | `yama config` prints the resolved result and every notice.                                                     |

---

## Programmatic use

```typescript
import {
  createRunContext,
  loadConfig,
  resolveModelChains,
  runReview,
} from "@juspay/yama";

const config = await loadConfig({ projectRoot: process.cwd() });

const { result, posted, warnings, runtime } = await runReview({
  config,
  context: createRunContext({
    config,
    identity: {
      provider: "github",
      owner: "acme",
      repo: "api",
      pullRequestId: 42,
    },
    mode: "dry-run",
  }),
  chains: resolveModelChains(config),
  git, // (args, { cwd }) => Promise<{ stdout, stderr, exitCode }>
  base: "origin/main",
  head: "HEAD",
});

console.log(result.verdict.decision, posted.length, warnings);
await runtime.shutdown();
```

`runtime.shutdown()` matters: provider SDKs keep telemetry timers and connection
pools alive, and a process that has printed its result but will not exit looks
to CI like a job that hung.

---

## Documentation

| Document                                   | What it covers                            |
| ------------------------------------------ | ----------------------------------------- |
| [Onboarding](docs/v4/04-onboarding.md)     | Step-by-step setup, new project or v3     |
| [MIGRATION.md](MIGRATION.md)               | Upgrading, with what moved where          |
| [Architecture](docs/v4/01-architecture.md) | The design and why each part exists       |
| [CONTRIBUTING.md](CONTRIBUTING.md)         | Development workflow and conventions      |
| [CLAUDE.md](CLAUDE.md)                     | Repository rules for AI coding assistants |

## License

MIT
