# Onboarding Yama

A start-to-finish walkthrough: config, connection, first review, CI, then the
optional pieces in the order most teams add them. Follow it top to bottom the
first time.

Two files are required. Everything else is optional, and absent means "that
capability is off", never "broken".

If you want to know _why_ it works the way it does, read
[01-architecture.md](01-architecture.md). This document is about getting it
running.

---

## Before you start

You need:

- **Node 20.18.1 or newer.**
- **A full checkout** of the repository you want reviewed. Yama computes the
  change set with `git diff base...head` from disk. A shallow clone produces a
  _wrong_ diff, not an absent one, so it is refused.
- **An MCP server for your VCS**, reachable from wherever Yama runs, and a token
  for it.
- **Credentials for a model provider** — whatever your `ai.provider` names.

---

## Step 1 — Write the config

**New repository:**

```bash
npx @juspay/yama init            # inspects the repo, prints the plan, writes nothing
npx @juspay/yama init --write    # applies it
```

`init` reads the git remote, the stack, the package scripts, the CI system, and
`CODEOWNERS`, and writes:

```
.yama/yama.yaml     models and fallback chains, learning settings
.yama/mcp.yaml      connections, and the capability map
.yama/checks.yaml   only when scripts were detected — written DISABLED
```

Useful flags: `--provider <name>`, `--token-env <name>` (default
`YAMA_VCS_TOKEN`), `--ai-provider <list>`, `--ai-model <list>`,
`--checks <list>`, `--enable-learning`. All lists are comma-separated.

**Coming from v3?** Run `yama migrate` instead — see
[MIGRATION.md](../../MIGRATION.md). Your existing single-file config keeps
working the whole time.

---

## Step 2 — Wire the connection

Open `.yama/mcp.yaml` and fill in two things: the endpoint, and which tool
provides each capability.

Yama's code never names a tool. It asks for a **capability**, and this file
supplies the tool name — which is what lets the same code path drive GitHub,
Bitbucket, or anything else you configure.

```yaml
servers:
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers:
      # Reference credentials by env var NAME. Values never live in config.
      Authorization: "Bearer ${YAMA_GITHUB_TOKEN}"
    capabilities:
      readPullRequest: { tool: pull_request_read, args: { method: get } }
      listChangedFiles: { tool: pull_request_read, args: { method: get_files } }
      listComments:
        { tool: pull_request_read, args: { method: get_review_comments } }
      listApprovals: { tool: pull_request_read, args: { method: get_reviews } }
      findPullRequest: list_pull_requests
      listMergedPullRequests: list_pull_requests
      beginReview: { tool: pull_request_review_write, args: { method: create } }
      postInlineComment: add_comment_to_pending_review
      submitReview:
        {
          tool: pull_request_review_write,
          args: { method: submit_pending, event: COMMENT },
        }
      postSummary: add_issue_comment
      updateDescription: update_pull_request
    # Posting tools exist only in the stages that post. A review turn reading an
    # attacker-controlled diff must not be able to write to the pull request.
    stages: [resolve, orient, post, checks, enhance, verdict]
    roles: [main]
    blockedTools: [push_files, create_or_update_file, merge_pull_request]
```

A mapping is either a bare tool name or `{ tool, args }`, where `args` pins
arguments the tool needs on every call. The object form exists because modern
VCS servers put many operations behind one tool selected by a parameter — and
that parameter is part of the mapping, never part of Yama.

Two mappings that must be made **together**: `beginReview` and `submitReview`.
Where a provider only accepts an inline comment attached to an open review, half
the pair writes comments on a review that is never submitted, which are
invisible to everyone. `doctor` fails on an unpaired mapping.

Set the token in your environment (locally, a `.env` file at the repository root
is loaded for you; in CI, use the secret store):

```bash
export YAMA_GITHUB_TOKEN=...
```

---

## Step 3 — Prove it

```bash
npx @juspay/yama doctor                    # config shape only, no network
npx @juspay/yama doctor --live --pr 42     # connect for real
```

Run this before your first review and after any config change. Every check in
`doctor` is one that, if deferred, costs a whole run — a wrong tool name, a
revoked token, an unpaired capability, a model slot that cannot fail over.

**`--live` is the part that matters.** Without it, `doctor` inspects config
shape: it catches typos, not a revoked token, a server that moved, or a tool
renamed upstream. With it, `doctor` connects, lists what each server actually
advertises, resolves every capability against that list, and reads the pull
request you named.

Tool names drift, and it is not hypothetical: GitHub's MCP server consolidated
its per-operation tools (`get_pull_request`, `get_pull_request_files`, …) behind
`pull_request_read` with a `method` argument, and every config written against
the old names broke. `doctor --live` prints the server's real tool list beside
the name your config asked for.

Reading the output:

```
✓ connections: 1 server(s) enabled
✓ capability map: 1 server(s) declare capabilities
✓ server:github: 44 tools
✓ capabilities: 12 resolved
✓ checks: 5 command check(s) configured; forks blocked
! learning: disabled
    → Yama will review but never improve. Set learn.trigger to merge-event…

Model slots:
  review       litellm/qwen3.8-27b-fast → litellm/deepseek-v4-flash  (fails over mid-run)
  compaction   litellm/qwen3.8-27b-fast                              (resolved at startup)

Prompts:
  yama-review                  built in
  yama-judge                   built in
```

`✓` is fine, `!` is usable with a caveat, `✗` means not ready — and `doctor`
exits non-zero on any `✗`. Every failing row carries a `→` remedy line saying
what to do about it.

A capability missing in dry-run mode is a warning; the same gap under `--live`
is a failure, because a live run that cannot post produces silence that reads to
the team as "no issues found".

Add `--learn` once you configure learning (step 8) — it proves the write path
separately, because that is the only path holding write credentials.

If you are ever unsure what config actually applied after defaults, files, and
environment overrides:

```bash
npx @juspay/yama config
```

---

## Step 4 — Your first review

```bash
npx @juspay/yama review --pr 42 --dry-run
```

Read what it _would_ have posted. Nothing is written to the pull request in
dry-run mode — that is enforced at every write path, not requested in a prompt.

The run prints the file list, then a report:

```
Stages
  ✓ resolve   passed
  ✓ orient    passed
  ✓ review    passed
  ✓ post      passed
  ! checks    degraded  (2 attempts)
      missing: check "test" did not run

Findings   4 posted, over 6 turn(s)
  MAJOR      src/api/session.ts:88 — Token compared with ==

Warnings
  ! Model fell back from litellm/qwen3.8-27b-fast to litellm/deepseek-v4-flash: timeout
```

Three things to look at:

- **Stage rows.** `degraded` means a stage failed its exit condition, was
  re-prompted `review.remediation.maxAttemptsPerStage` times, and still did not
  satisfy it. A run with any degraded or failed stage is partial and can never
  end APPROVED.
- **Findings.** These are the comments that were accepted by the gate _and_
  posted. A finding counts as posted only when the posting tool returned a
  comment id.
- **Warnings.** Model failovers, capabilities that could not be read, a
  structured result that hit the token cap. Nothing here is fatal, but nothing
  here is noise either.

The same report is written as JSON to `.yama/reports/<runId>.json`.

When you like what you see, drop `--dry-run`:

```bash
npx @juspay/yama review --pr 42
```

`review` needs either `--pr <number>` or `--branch <name>`. With a branch, Yama
resolves the pull request and reports an ambiguity rather than choosing one. The
diff refs default to `--base origin/main` and `--head HEAD`.

Note that `review` exits non-zero only when a stage **failed**. A BLOCKED
verdict is a successful run that found problems — failing the job there would
make "Yama works" indistinguishable from "Yama found a bug", and teams disable
whichever is noisier.

---

## Step 5 — Put it in CI

```yaml
name: Yama review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: yama-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # required

      - uses: juspay/yama@v4
        id: yama
        with:
          pr: ${{ github.event.pull_request.number }}
          vcs-token: ${{ secrets.YAMA_GITHUB_TOKEN }}
        env:
          LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
          LITELLM_BASE_URL: ${{ secrets.LITELLM_BASE_URL }}
```

Three things that trip people up:

1. **`fetch-depth: 0`.** Without it the base commit is unreachable and the diff
   is wrong. The action warns loudly on a shallow clone.
2. **Pass the token through the `vcs-token` input**, not as
   `${{ secrets.GITHUB_TOKEN }}` in `env`. Reserved env names are not reliably
   forwarded inside a composite action, and the failure surfaces much later as
   an opaque 401. The action exports what you pass as _both_ `YAMA_VCS_TOKEN`
   and `YAMA_GITHUB_TOKEN`, so either name works in your `mcp.yaml`.
3. **Set the job timeout comfortably above `ai.timeout`.** A slow model should
   be cut off by Yama — which reports the stall and still posts a summary —
   rather than by the runner, which kills the job and reports nothing.

4. **Point `config` outside the checkout when you review untrusted pull
   requests.** A pull request can edit `.yama/` in its own head. The `config`
   input (and the CLI's `--config`) takes a directory, so a fork's pull request
   cannot choose the settings it is reviewed under.

The action exposes `decision`, `posted`, `critical`, `major`, `partial` and
`summary` as step outputs, and `fail-on-blocked` (default `true`) exits non-zero
on a BLOCKED verdict. Gate on `steps.yama.outputs.partial` if you want to know
when a review could not vouch for the whole change.

`.github/workflows/yama-review.yml` in this repository is a working example.

---

## Step 6 — Add your checks

Your existing CI commands become review evidence: the agent reads their output
before commenting, so it never duplicates what a linter already said.

```yaml
# .yama/checks.yaml
enabled: true
allowForks: false

checks:
  - id: lint
    run: "npx eslint src tests --format json"
    parse: eslint
    when:
      paths: ["**/*.{ts,tsx,js}"]
    severity: { error: MAJOR, warning: MINOR }
    scope: changed-lines
    maxFindings: 25
    blocking: false
    timeoutMs: 300000

  - id: security
    run: "trivy fs --format sarif ."
    parse: sarif # also covers semgrep, ruff, golangci-lint, clippy, …
    scope: repo
```

Start every check with `blocking: false` and turn blocking on once you have seen
a few runs. `scope` decides which findings survive: `changed-lines` (only lines
this PR touched), `changed-files`, or `repo` (anything, wherever it lives — the
right choice for a test suite).

If no named parser understands your script's output, use `parse: agent` and
describe the shape in `hint:`. One schema-bound pass on the `ai.extraction` slot
turns the raw output into findings, with tools off so it can only read the
output and never the repository. If extraction fails, the check is reported
**FAILED** — never "no findings", which would read as a pass.

**Two security rules are not tunable downward.** `checks.yaml` and every script
it names are read from the **base branch**, and Yama refuses to run checks at
all if the head modified one. Fork pull requests get no checks unless
`allowForks` is explicitly enabled. Running repository commands against code
from a pull request is arbitrary code execution with your CI credentials. Both
refusals are loud: the checks stage is reported failed with the reason.

---

## Step 7 — Ownership and guards

```yaml
# .yama/policy/ownership.yaml
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

Deterministic, no model involved. One grouped comment, updated in place on
re-runs, and nobody is re-tagged. Add `type: builtin.owners` to `checks.yaml`
pointing at this file to have it posted.

An existing `CODEOWNERS` can be imported by `init` — `exclusive: true` preserves
its last-match-wins semantics, and rules import as non-blocking so importing
never silently changes what can merge.

Guards raise the bar on paths where a quiet regression is expensive:

```yaml
# .yama/policy/guards.yaml
guards:
  - id: auth
    paths: ["src/auth/**"]
    severityFloor: MAJOR
    requireChecks: ["test"]
    reason: "A quiet regression here is a security incident"
```

Guards produce findings always, but block only when
`review.verdict.blockOn` lists their reason — which it does by default, so
promote a guard to blocking deliberately.

---

## Step 8 — Give it a knowledge base

A fresh Yama knows nothing about your conventions. `bootstrap` reads your merged
pull requests once and proposes a starting point:

```bash
npx @juspay/yama bootstrap                  # print the plan, write nothing
npx @juspay/yama bootstrap --write --window 25
```

It writes `.yama/rules/*.yaml`, `.yama/product/capabilities.yaml`, and
`.yama/profile.md`, and **never commits**. Open the files as a pull request and
read them: every rule there shapes future reviews, and the corrections you make
reviewing them are the strongest signal the system will ever receive. Every
mined rule starts as a _candidate_ — recorded and retrievable, but not enforced
until a reviewer states it again on a real pull request.

Requirements: `listMergedPullRequests` and `listComments` mapped in
`.yama/mcp.yaml` and exposed in the `resolve` stage. `--window` defaults to 15
merged pull requests. If fewer than three of them carry human review comments,
bootstrap says so — there is not enough history to tell a convention from a
one-off, so prune the result hard.

The product model it writes (`.yama/product/capabilities.yaml`, plus
`impact-log/` entries that `learn` adds later) is loaded at startup, surfaced to
the agent through its `recall` tool, and produces an **Impact** section in the
summary comment: which capabilities the change touches, blast radius, silent
failure modes, historical risk. Absent, impact analysis degrades quietly.

---

## Step 9 — Turn on learning

Learning is **off by default** and must be configured deliberately, because it
writes to your repository.

```yaml
# .yama/yama.yaml
learn:
  trigger: merge-event # the only trigger that reliably identifies the PR
  mergeStrategy: squash # squash | merge | rebase — detected by `yama init`
  mode: commit # or pull-request, for a protected branch
  botIdentity: yama-bot
  git:
    auth: ssh # or https
    sshKeyEnv: YAMA_SSH_KEY # the key BODY, not a path
    remote: "git@host:org/repo.git"
    branch: main
```

```bash
npx @juspay/yama doctor --learn        # proves the write path before you rely on it
npx @juspay/yama learn --pr 42 --dry-run
```

On merge, Yama classifies the review conversation — what a human said that Yama
did not (a convention), what Yama said that the author fixed (a confirmation),
what Yama said that the author dismissed unchanged (a suppression candidate) —
and writes, in one commit:

| File                                   | What it holds                                                |
| -------------------------------------- | ------------------------------------------------------------ |
| `.yama/rules/learned.yaml`             | What Yama concluded, kept apart from your hand-written rules |
| `.yama/product/impact-log/pr-<n>.yaml` | Which capabilities that change touched                       |
| `.yama/knowledge/scorecard.md`         | Precision and recall, measured from what humans actually did |
| `.yama/knowledge/learn-watermark.json` | How far learning has got                                     |

Learned rules stay in their own file so a learn commit's diff shows only what
Yama concluded, and you can revert it without touching your own policy. The
per-pull-request artifact is consumed and deleted at the same time — what was
worth keeping is now in the impact log.

**If your repository rebases on merge:** rebased commits carry no pull request
number, and it cannot be recovered from git history. Learning must run on the
**merge event** so CI supplies the number. `yama init --enable-learning` detects
this and writes the workflow accordingly. If no resolution path is available,
learning is disabled and announced — never silently degraded, because feedback
attributed to the wrong pull request teaches the knowledge base a lie.

Learning also catches up: it runs over every merge since the watermark, not just
the one that triggered it, so a CI outage does not lose a week of feedback. A
run that fails partway does not advance the watermark.

**Loop prevention** is belt and braces: the commit carries `[skip ci]`, **and**
the workflow guards on the actor, **and** it ignores changes under
`.yama/knowledge/**`. `[skip ci]` alone is honoured inconsistently across GitHub
Actions, Bitbucket Pipelines and Jenkins.

---

## Optional — Manage prompts on Langfuse

Yama ships every prompt it uses. If you want to iterate on wording without
cutting a release, point it at Langfuse:

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
  only: [yama-review, yama-judge] # optional: manage just some prompts
```

Create entries on the platform under the ids Yama asks for: `yama-review`,
`yama-judge`, `yama-triage`, `yama-bootstrap`, `yama-extraction`,
`yama-subagent-impact`, `yama-subagent-security`, `yama-subagent-history`,
`yama-subagent-tests`, `yama-subagent-conventions`. (`yama-description` is
accepted in `only:` but no call site reads it yet.) Ids in `only:` are validated
against that list, so a typo is an error rather than a prompt that silently goes
unmanaged.

What this changes operationally:

- Nothing, until you set `enabled: true`.
- **Every** failure path — credentials unset, no network, no entry for that id,
  a timeout, the SDK missing — falls back to the text Yama ships, adds a
  warning, and continues. A platform outage slows nothing and changes nothing.
- Prompts are fetched **once per run**, before the first turn, so every turn
  sends identical bytes and provider prompt caching still applies.
- `yama doctor` prints a **Prompts:** section naming which prompts came from the
  platform (with version) and which are built in. Check it after your first
  enabled run rather than assuming the platform answered.

---

## Optional — Tuning

### Model chains

Every slot takes a list. The next entry is tried when one fails — including when
a model returns an empty response, which is not an error but is not a review
either.

```yaml
ai:
  provider: [vertex, vertex, litellm]
  model: [claude-sonnet-4-6, gemini-2.5-pro, glm-4.6]
  pool: { strategy: priority, cooldownMs: 60000 }
  maxTokens: 32000
  # Per model call. A hang detector, not a budget — a self-hosted model that is
  # merely slow must be allowed to finish rather than be cut off mid-answer.
  timeout: 600000

  # Per-slot overrides inherit the base chain for anything they do not set.
  judge: { provider: vertex, model: gemini-2.5-flash, temperature: 0 }
  subAgent: { provider: vertex, model: gemini-2.5-flash }
  extraction: { provider: vertex, model: gemini-2.5-flash, temperature: 0 }
```

Lists pair by position, so repeating a provider with a different model works. A
single provider broadcasts across many models and vice versa. Mismatched list
lengths are a loud config error naming both counts.

Yama walks this chain itself and pins the runtime's own fallback off — otherwise
a failed call can resolve to whichever provider happens to have credentials in
the environment, and the run succeeds on a model nobody chose while the report
says it worked.

**One honest limitation.** The `compaction` and `memory` slots take a single
provider+model upstream, so Yama health-probes their chain at startup and uses
the first reachable member: failover _between_ runs, not mid-run. `doctor`
labels every slot as `fails over mid-run` or `resolved at startup` so this is
visible rather than implied.

Every model call outside the review conversation is schema-bound. If a run
warns that a structured result was truncated, raise `ai.maxTokens` for the slot
the warning names.

### Review behaviour

```yaml
# .yama/review.yaml
concurrency:
  power: high # ceiling on specialist fan-out; the agent still decides
confidenceThreshold: 80 # 0-100; 0 turns scoring off and saves a call per submission
changedLinesOnly: true
maxFiles: 200
excludePatterns: ["dist/**", "coverage/**", "**/*.snap"]
remediation:
  maxAttemptsPerStage: 2
description:
  sections:
    - { title: "Testing", required: true }
```

`confidenceThreshold` is a real gate: every agent-sourced finding is scored by
the `ai.judge` slot before it can post, and anything under the bar is refused.
Findings that came from a check are not scored — a compiler error is not a
probabilistic claim.

`description.sections` names sections the rewritten description must contain.
S5 verifies them by re-reading the pull request, not by believing the agent said
it wrote them; a missing required section re-prompts the stage.

### Per-run overrides

For CI operators, without editing config:

| Variable                    | Effect                                   |
| --------------------------- | ---------------------------------------- |
| `YAMA_CONCURRENCY`          | `high` \| `medium` \| `low`              |
| `YAMA_VERDICT=false`        | Review without an approve/block decision |
| `YAMA_CHECKS=false`         | Skip configured checks for one run       |
| `YAMA_CONFIDENCE_THRESHOLD` | Inline judge acceptance bar, 0–100       |

Deliberately narrow. Anything that changes review semantics — rules, ownership,
guards — stays in the repository where it is reviewable.

---

## What to expect on day one

1. **Nothing blocks.** No check, rule or ownership rule is blocking out of the
   box. Turn them on after reading a few scorecards.
2. **Run `--dry-run` first** and read what it _would_ have posted, for at least
   a couple of pull requests.
3. **It starts cold.** Run `bootstrap` to give it a starting knowledge base, and
   turn on learning so it improves. The expensive work happens on merge, where
   nobody is waiting, so reviews improve without ever getting slower.
4. **Re-runs are incremental.** Comment markers on the pull request are the
   authority on what has already been said, so pushing again does not duplicate
   comments — even on a fresh runner with no artifact.

---

## Troubleshooting

| Symptom                                       | What to do                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `No configuration found`                      | Run `yama init`, or point `-C, --cwd` at the right repository root.                                          |
| `No connections configured`                   | `.yama/mcp.yaml` is missing. Yama cannot read a pull request without at least one server.                    |
| `capability:X — "server" declares "tool" …`   | The tool name moved upstream. `doctor --live` prints what the server really advertises; fix `mcp.yaml`.      |
| `capability pair: beginReview + submitReview` | Map both, or remove the one you mapped. Half the pair posts comments nobody can see.                         |
| `server registered but advertised no tools`   | Usually a credential or scope problem — the server connected but exposed nothing.                            |
| The review posted nothing but "succeeded"     | Read the Warnings block and the stage rows in the run report. A degraded stage is always reported.           |
| A structured result was truncated             | Raise `ai.maxTokens` for the slot the warning names.                                                         |
| Checks all skipped                            | Fork pull request (expected — `allowForks` is off), or the head modified `checks.yaml` or a script it names. |
| Reviews are slower than expected              | Lower `concurrency.power`, narrow `excludePatterns`, or set `confidenceThreshold: 0` to skip inline scoring. |
| `This is a shallow clone`                     | Use `fetch-depth: 0`. A shallow clone produces a _wrong_ diff, not an absent one.                            |
| `yama learn` committed nothing                | `yama doctor --learn` proves the credential, the remote, and whether the target branch is protected.         |
| Learning attributes feedback oddly            | Rebase repositories must use `trigger: merge-event`. `doctor` fails this combination on purpose.             |
| Not sure which config applied                 | `yama config` prints the resolved result and every notice.                                                   |
