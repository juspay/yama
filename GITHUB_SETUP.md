# Using Yama on GitHub — PR Review Setup Guide

Yama reviews GitHub pull requests the same way it reviews Bitbucket PRs: an AI agent
reads the PR, walks the diff file‑by‑file, posts **inline review comments**, and
**submits a review** (Approve / Request changes). On GitHub this is driven through
GitHub's hosted Model Context Protocol (MCP) server, so no Bitbucket credentials are
needed.

This guide covers the GitHub Action, the local CLI, configuration, authentication, and
troubleshooting.

---

## 0. One-command setup (recommended)

Instead of hand-creating the files in §3, run the interactive setup script from the repo
you want reviewed. It asks for your **AI provider + model + target branch(es)**, then
writes a provider-aware `.github/workflows/yama-review.yml` and a standard, tunable
`.yama/config.yaml`, and prints exactly what to do next (set secrets, optionally make it a
required check, raise a PR — your call). It only makes the code changes; it never touches
your secrets, commits, or opens a PR.

```bash
# From the target repo (no install needed):
curl -fsSL https://raw.githubusercontent.com/juspay/yama/main/scripts/setup-github.sh | bash

# …or from a cloned yama checkout:
bash /path/to/yama/scripts/setup-github.sh

# Non-interactive (CI / scripted):
bash setup-github.sh --provider anthropic --model claude-opus-4-8 --branches main --yes
```

It auto-detects your repo's default branch and a `pnpm` `packageManager` clash (adding the
workaround only when needed), is idempotent (won't clobber existing files without
`--force`), and supports `--dry-run`. Run with `--help` for all flags. The rest of this
guide explains what it generates and why.

---

## 1. What you get

- **Inline, line‑level comments** on the diff (parity with the Bitbucket flow).
- **A submitted review**: `APPROVE` when clean, `REQUEST_CHANGES` when blocking criteria are met.
- **Optional PR description enhancement**.
- **Provider auto‑detection** — no extra flags. In an Action, `GITHUB_*` env vars make Yama
  pick the GitHub provider automatically; which MCP servers start comes entirely from your
  config (`mcpServers.servers.*` — see §8).

---

## 2. Prerequisites

| Requirement                                                               | Why                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| An **AI provider API key** (Anthropic, OpenAI, Google AI, …)              | Yama's reviewer model runs through NeuroLink.                                                                                |
| A **GitHub Personal Access Token (PAT)** with `repo` / pull‑request scope | Bearer token for GitHub's hosted MCP server (`api.githubcopilot.com`) to read the PR and post review comments. See ⚠️ below. |
| Node.js 26 (handled for you in the Action)                                | Runtime.                                                                                                                     |

> ⚠️ **A real PAT is required — not the default Actions `GITHUB_TOKEN`.** The hosted GitHub
> MCP endpoint (`https://api.githubcopilot.com/mcp/`) authenticates with a GitHub **PAT**. This
> is the same pattern Curator uses in production (a dedicated `GITHUB_ACCESS_TOKEN`). The
> ephemeral `secrets.GITHUB_TOKEN` provided by Actions may be rejected by that endpoint, so
> store a PAT as a secret and pass it as `github-token`. Yama recognizes, in order:
> `YAMA_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`,
> `GITHUB_ACCESS_TOKEN`.

---

## 3. Quick start (GitHub Action)

Two files go into the repository you want reviewed (the §0 script writes both).

**1. `.github/workflows/yama-review.yml`:**

```yaml
name: Yama AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: yama-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read # read the repo / diff
  pull-requests: write # post inline comments + submit the review

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Yama Review
        uses: juspay/yama@main # pin a tag/SHA once a v3 tag is published (§9)
        with:
          github-token: ${{ secrets.YAMA_GITHUB_TOKEN }} # a PAT (see §6)
          ai-provider: anthropic
          ai-model: claude-opus-4-8
          # AI keys are action INPUTS, not env: composite-action steps do NOT
          # inherit a caller step's `env:`, so an env block here would be
          # silently ignored. Pass the input matching your provider (see §4):
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # or: openai-api-key / google-ai-api-key / litellm-base-url +
          #     litellm-api-key / google-application-credentials (+ optional
          #     google-vertex-project, google-vertex-location)
          config-path: .yama/config.yaml
          focus-areas: security,performance,codeQuality
```

**2. `.yama/config.yaml`** — required. Yama ships **zero** built-in MCP servers,
so without a config declaring `mcpServers.servers.github` the reviewer has no
tools. Use the example in [§8](#8-configuration-yamaconfigyaml) (or copy
`yama.config.github.example.yaml` from this repo).

Then add the secrets:

```bash
# AI provider key (match ai-provider)
gh secret set ANTHROPIC_API_KEY --body "sk-ant-..."
# or: OPENAI_API_KEY / GOOGLE_AI_API_KEY

# GitHub PAT for the hosted MCP endpoint (repo / pull_requests scope)
gh secret set YAMA_GITHUB_TOKEN --body "github_pat_..."
```

See [§6 Authentication](#6-authentication-deep-dive) for why a PAT (not the default
`secrets.GITHUB_TOKEN`) is used.

---

## 4. Action inputs

All inputs are kebab‑case.

| Input                            | Default               | Description                                                                           |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `github-token`                   | `${{ github.token }}` | Token for the GitHub MCP server (read PR, post comments).                             |
| `ai-provider`                    | from config           | `anthropic` \| `openai` \| `google-ai` \| …                                           |
| `ai-model`                       | from config           | e.g. `claude-opus-4-8`.                                                               |
| `explore-model`                  | `ai-model`            | Smaller/faster model for the explore + verification subagents.                        |
| `anthropic-api-key`              | —                     | Anthropic API key (used when `ai-provider: anthropic`).                               |
| `openai-api-key`                 | —                     | OpenAI API key (used when `ai-provider: openai`).                                     |
| `google-ai-api-key`              | —                     | Google AI Studio API key (used when `ai-provider: google-ai`).                        |
| `google-vertex-project`          | —                     | GCP project ID for Vertex AI (auto‑derived from the credentials JSON if omitted).     |
| `google-vertex-location`         | `us-central1`         | Vertex AI location/region.                                                            |
| `google-application-credentials` | —                     | Vertex service‑account credentials JSON content (written to a temp file).             |
| `litellm-base-url`               | —                     | LiteLLM proxy base URL (used when `ai-provider: litellm`).                            |
| `litellm-api-key`                | —                     | LiteLLM proxy API key (used when `ai-provider: litellm`).                             |
| `config-path`                    | —                     | Path to a Yama config file in your repo (e.g. `.yama/config.yaml`).                   |
| `focus-areas`                    | —                     | Comma list, e.g. `security,performance`.                                              |
| `custom-prompt`                  | —                     | Extra review instructions.                                                            |
| `dry-run`                        | `false`               | Run the review but post nothing.                                                      |
| `skip-description-enhance`       | `false`               | Review only; skip PR‑description enhancement.                                         |
| `verbose`                        | `false`               | Verbose logs.                                                                         |
| `fail-on-blocked`                | `true`                | `false` = advisory mode: BLOCKED posts the verdict comment but keeps the check green. |

### Outputs

`decision` (`APPROVED` / `CHANGES_REQUESTED` / `BLOCKED`), `summary`, `findings`
(markdown list of the findings behind the verdict), `critical-issues`,
`major-issues`, `minor-issues`, `total-comments`.

The job **fails** (`exit 1`) when the decision is `BLOCKED`, so you can make Yama a
required check. Set `fail-on-blocked: "false"` for advisory mode — the check stays
green, but the verdict still lands on the PR. Whenever the review does not approve,
the action also posts one idempotent **verdict summary comment** (updated in place on
re-runs) listing the findings behind the decision — so a block is never invisible,
even if the reviewing model failed to post its inline comments. Infrastructure
failures (crashes, missing credentials) fail the check in both modes.

---

## 5. How it works (internals)

`action.yml` is a **composite action** (not a bundled JS action). On each run it:

1. Sets up Node 26 and builds the Yama CLI from the action checkout (`dist/cli/cli.js`).
2. Resolves the PR number from the event payload and runs:
   `node dist/cli/cli.js review --owner <owner> --repo <repo> --pr <n>`
   against your checked‑out workspace, forwarding `github-token` as
   `YAMA_GITHUB_TOKEN`/`GITHUB_TOKEN` and the AI inputs (`AI_PROVIDER`, `AI_MODEL`,
   provider keys) as env.
3. The CLI auto‑detects the **GitHub** provider (`ProviderDetector`) for credential
   validation, then loads your config. **Every MCP server comes from
   `mcpServers.servers.*` — nothing is hardcoded in the code, including URLs.** Your
   `github` entry's `url` (e.g. the hosted `https://api.githubcopilot.com/mcp/`) and
   `Authorization` header define the connection.
4. One agentic NeuroLink `generate()` loop reviews the PR through the configured
   server's tools. Prompts are provider‑vocabulary‑free — the model discovers the
   server's real tool schemas at runtime, so the same flow works for GitHub,
   Bitbucket, or any MCP server you configure.

> **Why composite, not a bundled `node20` action?** NeuroLink imports `interceptors` from
> `undici`, which `ncc` cannot statically bundle. Running the built CLI via a composite
> action avoids the bundler entirely while preserving full behavior.

### Write‑safety

**There is no built‑in denylist in Yama** — write‑safety is per‑server config. The
`blockedTools` list on your `mcpServers.servers.github` entry is the only thing standing
between the reviewer and a repo‑mutating tool, so keep the recommended list intact:

```yaml
blockedTools:
  - push_files
  - create_or_update_file
  - create_branch
  - delete_file
  - merge_pull_request
```

With that list in place, Yama only **reads** the PR and **posts review comments / submits
a review** — it never writes code to your repo.

---

## 6. Authentication deep-dive

The hosted GitHub MCP server (`https://api.githubcopilot.com/mcp/`) is authenticated with a
**Bearer GitHub PAT**. Yama resolves the token from, in order:
`YAMA_GITHUB_TOKEN` → `GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN` →
`GITHUB_ACCESS_TOKEN`. (`YAMA_GITHUB_TOKEN` is the one the Action forwards from its
`github-token` input — inside a composite action the reserved `GITHUB_TOKEN` name can be
clobbered by the runner, so the non‑reserved name is the reliable one.)

This is the same approach Curator uses in production: a dedicated PAT (`GITHUB_ACCESS_TOKEN`,
sourced from KMS in prod / env in dev) is passed as `Authorization: Bearer <pat>`. The
registration also sets a 30s connect timeout + retry/backoff because the remote endpoint is
slow to handshake (~3–4 s).

- **Use a PAT.** Create a fine‑grained or classic PAT with **`repo`** (or `pull_requests:
read+write`) scope, store it as a secret, and pass it as `github-token`:

  ```yaml
  with:
    github-token: ${{ secrets.YAMA_GITHUB_TOKEN }}
  ```

  ```bash
  gh secret set YAMA_GITHUB_TOKEN --body "github_pat_..."
  ```

- **The default Actions `secrets.GITHUB_TOKEN`** is the ephemeral installation token. It may be
  **rejected** by the hosted Copilot MCP endpoint (you'll see `github registered but advertised
0 tools` — see Troubleshooting). It is also read‑only on **fork** PRs. Prefer a PAT.

> ⚠️ **Fork PRs & `pull_request_target`.** The default token can't post on fork PRs. You can
> trigger on `pull_request_target` to get a write token, but that runs in the **base** repo's
> context — never check out and execute untrusted PR code in that mode. Prefer a PAT with
> `pull_request` triggers, or restrict reviews to internal branches.

---

## 7. Local CLI usage (GitHub)

```bash
# Build once
pnpm install && pnpm run build

# Review a GitHub PR
export GITHUB_TOKEN=ghp_xxx          # or GH_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN
export ANTHROPIC_API_KEY=sk-ant-xxx  # your AI provider key
node dist/cli/cli.js review --owner <owner> --repo <repo> --pr <number>

# Dry run (post nothing)
node dist/cli/cli.js review --owner <owner> --repo <repo> --pr <number> --dry-run --verbose
```

Bitbucket usage is unchanged: `--workspace <ws> --repository <repo> --pr <id>`.
Yama refuses to mix GitHub (`--owner/--repo`) and Bitbucket (`--workspace/--repository`) flags.

---

## 8. Configuration (`.yama/config.yaml`)

**A config is required for a useful GitHub review.** Yama ships **zero** built‑in MCP
servers, so without a `mcpServers.servers.github` entry the run degrades to a toolless
review (you'll see the `No MCP servers enabled` warning). Yama auto‑discovers config at
`.yama/config.yaml` first, then the legacy `yama.config.yaml` and `config/yama.config.yaml`
locations (which print a deprecation warning on every run).

```yaml
version: 2
configType: yama

ai:
  provider: anthropic
  model: claude-opus-4-8

mcpServers:
  servers:
    github:
      enabled: true
      transport: http # GitHub's hosted remote MCP server
      url: https://api.githubcopilot.com/mcp/ # override for GitHub Enterprise / self-host
      headers:
        Authorization: "Bearer ${YAMA_GITHUB_TOKEN}" # forwarded by the action
      roles: [review, explore]
      modes: [pr]
      timeout: 30000 # the hosted endpoint is slow to handshake
      retryConfig:
        maxAttempts: 3
        initialDelay: 1000
        maxDelay: 10000
        backoffMultiplier: 2
      # The ONLY write-safety denylist — nothing is blocked in code (see §5).
      blockedTools:
        - push_files
        - create_or_update_file
        - create_branch
        - delete_file
        - merge_pull_request

review:
  enabled: true
  verification: basic # off | basic | strict — critic pass before posting
  focusAreas: # objects, not plain strings
    - name: "Security"
      priority: "CRITICAL"
      description: "Injection, secret handling, auth flaws, unsafe input."
```

The legacy flat `mcpServers.github` shape is **rejected at startup** with a
`ConfigurationError` and a migration hint (see `MIGRATION.md`).

A self‑hosted / Docker GitHub MCP server can be used by setting `transport: stdio` plus
`command`/`args` on `mcpServers.servers.github`.

---

## 9. Pinning the action ref

The examples in this guide and the workflows generated by `scripts/setup-github.sh`
reference `uses: juspay/yama@main`. That is deliberate for now: the
`mcpServers.servers` config schema used throughout this guide requires a v3 build, and
pre‑v3 tags (e.g. `v2.6.0`) reject it or silently register zero servers. Once a v3 tag
is published, pin it — or, for strict supply‑chain immutability, the commit SHA behind
it (the script's `--ref` flag writes the pin for you):

```yaml
uses: juspay/yama@v3.0.0 # or juspay/yama@<commit-sha>
```

Maintainers: publish a tag with `git tag v3.0.0 && git push origin v3.0.0`. Because the
action is composite and builds from source on each run, any ref containing the source
works — committing `dist/` is optional but speeds up cold starts.

---

## 10. Troubleshooting

| Symptom                                                                        | Cause / Fix                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConfigurationError: Legacy mcpServers config detected (key(s): github)`       | Startup rejection: the config uses the pre‑v3 flat `mcpServers.github` shape. Move the entry under `mcpServers.servers.github` (see §8 and `MIGRATION.md`).                                            |
| `No MCP servers enabled for mode="pr", role="review"` warning; toolless review | No enabled server matched the mode/role. Add a `mcpServers.servers.github` entry with `enabled: true`, `roles: [review, explore]`, `modes: [pr]` (see §8).                                             |
| `GitHub provider selected but no GitHub token found…`                          | No token in env. Pass `github-token` (Action) or export `YAMA_GITHUB_TOKEN` / `GITHUB_TOKEN` (CLI).                                                                                                    |
| `github registered but advertised 0 tools`                                     | Token rejected or lacks scope, or the `url` is wrong. Use a PAT with `repo`/`pull_requests` scope (see §6).                                                                                            |
| `allowedTools is set but the server advertised no tools to enforce it against` | Fail‑closed allowlist: when a server's tools can't be discovered, registration fails instead of running unenforced. Fix connectivity/credentials, or use `blockedTools` instead.                       |
| No comments on a **fork** PR                                                   | Default token is read‑only for forks; use a PAT (see §6).                                                                                                                                              |
| `BITBUCKET_USERNAME … not set` on a GitHub run                                 | Should not happen — validation is provider‑aware. Confirm `--owner/--repo` are set so GitHub is detected.                                                                                              |
| AI key errors                                                                  | Pass the action input matching `ai-provider` (`anthropic-api-key` / `openai-api-key` / `google-ai-api-key`, …) — composite steps do not read a caller step's `env:`. CLI: export the matching env var. |

---

## 11. Beyond the basics

The GitHub integration is fully config‑driven — the same review loop runs against any MCP
server you configure. Two features worth enabling once the basic flow works:

- **Critic verification** (`review.verification: basic | strict`) — a tools‑off critic
  pass vets every candidate finding at the `submit_review` gate before anything is posted.
- **Cross‑run state** (`state: { enabled: true, store: github-artifact, path: .yama/state }`)
  makes re‑reviews incremental: previously posted findings are never duplicated, fixed ones
  are resolved, repeatedly‑ignored ones are auto‑suppressed. Your workflow moves the state
  artifact between runs — see the "Restore review state" / upload steps in this repo's
  `.github/workflows/yama-self-review.yml` for the proven pattern.
- The default Actions token cannot review **fork** PRs (GitHub security) — use a PAT.

---

## 12. Security notes

- No secrets are committed in this repo: `.env` is git‑ignored and `.env.example` contains only
  placeholders.
- Pass all tokens/keys via GitHub **secrets**, never inline in the workflow.
- Yama's GitHub integration is **read + review‑comment only** when the recommended
  `blockedTools` list is in place — write‑safety comes from your per‑server config, not
  from code (see §5).
