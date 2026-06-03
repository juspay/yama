# Using Yama on GitHub — PR Review Setup Guide

Yama reviews GitHub pull requests the same way it reviews Bitbucket PRs: an AI agent
reads the PR, walks the diff file‑by‑file, posts **inline review comments**, and
**submits a review** (Approve / Request changes). On GitHub this is driven through
GitHub's hosted Model Context Protocol (MCP) server, so no Bitbucket credentials are
needed.

This guide covers the GitHub Action, the local CLI, configuration, authentication, and
troubleshooting.

---

## 1. What you get

- **Inline, line‑level comments** on the diff (parity with the Bitbucket flow).
- **A submitted review**: `APPROVE` when clean, `REQUEST_CHANGES` when blocking criteria are met.
- **Optional PR description enhancement**.
- **Provider auto‑detection** — no extra flags. In an Action, `GITHUB_*` env vars make Yama
  pick the GitHub provider automatically; the GitHub MCP server (not Bitbucket) is the only
  one started.

---

## 2. Prerequisites

| Requirement                                                               | Why                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| An **AI provider API key** (Anthropic, OpenAI, Google AI, …)              | Yama's reviewer model runs through NeuroLink.                                                                                |
| A **GitHub Personal Access Token (PAT)** with `repo` / pull‑request scope | Bearer token for GitHub's hosted MCP server (`api.githubcopilot.com`) to read the PR and post review comments. See ⚠️ below. |
| Node.js 20 (handled for you in the Action)                                | Runtime.                                                                                                                     |

> ⚠️ **A real PAT is required — not the default Actions `GITHUB_TOKEN`.** The hosted GitHub
> MCP endpoint (`https://api.githubcopilot.com/mcp/`) authenticates with a GitHub **PAT**. This
> is the same pattern Curator uses in production (a dedicated `GITHUB_ACCESS_TOKEN`). The
> ephemeral `secrets.GITHUB_TOKEN` provided by Actions may be rejected by that endpoint, so
> store a PAT as a secret and pass it as `github-token`. Yama recognizes any of
> `GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, or `GITHUB_ACCESS_TOKEN`.

---

## 3. Quick start (GitHub Action)

Add `.github/workflows/yama-review.yml` to the repository you want reviewed:

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
        uses: juspay/yama@v1
        with:
          github-token: ${{ secrets.YAMA_GITHUB_TOKEN }} # a PAT (see §6)
          ai-provider: anthropic
          ai-model: claude-opus-4-8
          focus-areas: security,performance,codeQuality
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

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

| Input                      | Default               | Description                                               |
| -------------------------- | --------------------- | --------------------------------------------------------- |
| `github-token`             | `${{ github.token }}` | Token for the GitHub MCP server (read PR, post comments). |
| `ai-provider`              | from config           | `anthropic` \| `openai` \| `google-ai` \| …               |
| `ai-model`                 | from config           | e.g. `claude-opus-4-8`.                                   |
| `config-path`              | —                     | Path to a `yama.config.yaml` in your repo.                |
| `focus-areas`              | —                     | Comma list, e.g. `security,performance`.                  |
| `custom-prompt`            | —                     | Extra review instructions.                                |
| `dry-run`                  | `false`               | Run the review but post nothing.                          |
| `skip-description-enhance` | `false`               | Review only; skip PR‑description enhancement.             |
| `verbose`                  | `false`               | Verbose logs.                                             |

### Outputs

`decision` (`APPROVED` / `CHANGES_REQUESTED` / `BLOCKED`), `summary`,
`critical-issues`, `major-issues`, `minor-issues`, `total-comments`.

The job **fails** (`exit 1`) when the decision is `BLOCKED`, so you can make Yama a required check.

---

## 5. How it works (internals)

`action.yml` is a **composite action** (not a bundled JS action). On each run it:

1. Sets up Node 20 and builds the Yama CLI from the action checkout (`dist/cli/cli.js`).
2. Resolves the PR number from the event payload and runs:
   `node dist/cli/cli.js review --owner <owner> --repo <repo> --pr <n>`
   against your checked‑out workspace, with `GITHUB_TOKEN`, `AI_PROVIDER`, `AI_MODEL` in env.
3. The CLI auto‑detects the **GitHub** provider (`ProviderDetector`) and starts **only** the
   GitHub MCP server — the hosted remote server at `https://api.githubcopilot.com/mcp/`
   (Bearer‑authenticated with your token).
4. The AI reviewer (NeuroLink `generate()`) is given a GitHub‑specific prompt and calls the
   GitHub MCP tools to read the PR and post the review.

> **Why composite, not a bundled `node20` action?** NeuroLink imports `interceptors` from
> `undici`, which `ncc` cannot statically bundle under the repo's undici‑5.x pin. Running the
> built CLI via a composite action avoids the bundler entirely while preserving full behavior.

### Write‑safety

Yama blocks GitHub repo‑mutating tools (`push_files`, `create_or_update_file`, `create_branch`,
`delete_file`, `create_pull_request_with_copilot`, `assign_copilot_to_issue`). It only **reads**
the PR and **posts review comments / submits a review** — it never writes code to your repo.

---

## 6. Authentication deep-dive

The hosted GitHub MCP server (`https://api.githubcopilot.com/mcp/`) is authenticated with a
**Bearer GitHub PAT**. Yama resolves the token from, in order:
`GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN` → `GITHUB_ACCESS_TOKEN`.

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
  **rejected** by the hosted Copilot MCP endpoint (you'll see `GitHub MCP server registered but
not connected` — see Troubleshooting). It is also read‑only on **fork** PRs. Prefer a PAT.

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

## 8. Configuration (`yama.config.yaml`)

The GitHub MCP server has sensible defaults, so config is optional. To customize:

```yaml
version: 2
configType: yama

ai:
  provider: anthropic
  model: claude-opus-4-8

mcpServers:
  github:
    enabled: true
    # transport: http                          # default; the hosted remote server
    # url: https://api.githubcopilot.com/mcp/  # override for GitHub Enterprise / self-host
    # blockedTools: [delete_file]              # add to the default write-block list
  jira:
    enabled: false

review:
  focusAreas: [security, performance, codeQuality, testing, documentation]
  maxIssues: 10
```

A self‑hosted / Docker GitHub MCP server can be used by setting `transport: stdio` plus
`command`/`args` on `mcpServers.github`.

---

## 9. Publishing the Action (maintainers)

The example workflow references `juspay/yama@v1`. To make that resolve, tag a major‑version
ref on the `juspay/yama` repo:

```bash
git tag -f v1            # moving major tag
git push -f origin v1
# (or a fixed tag like v2.5.0 and reference uses: juspay/yama@v2.5.0)
```

Until a tag is published, consumers can pin `uses: juspay/yama@main`. Because the action is
composite and builds from source on each run, the action checkout must contain the source
(it does) — committing `dist/` is optional but speeds up cold starts.

---

## 10. Troubleshooting

| Symptom                                                         | Cause / Fix                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GitHub MCP server registered but not connected`                | Token rejected or lacks scope. Use a PAT with `repo`/`pull_requests` scope (see §6).                      |
| `Missing GitHub authentication: set GITHUB_TOKEN…`              | No token in env. Pass `github-token` (Action) or export `GITHUB_TOKEN` (CLI).                             |
| `GitHub provider selected but mcpServers.github is not enabled` | You set `mcpServers.github.enabled: false`. Remove it or set `true`.                                      |
| No comments on a **fork** PR                                    | Default token is read‑only for forks; use a PAT (see §6).                                                 |
| `BITBUCKET_USERNAME … not set` on a GitHub run                  | Should not happen — validation is provider‑aware. Confirm `--owner/--repo` are set so GitHub is detected. |
| AI key errors                                                   | Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_AI_API_KEY` matching `ai-provider`.                  |

---

## 11. Known limitations / verify on first run

- **Transport + auth are confirmed** against Curator's production setup: remote HTTP to
  `api.githubcopilot.com/mcp/` with a Bearer **PAT**, 30s timeout + retry/backoff. ✅
- **Hosted‑MCP tool surface needs a live confirmation.** The GitHub tool names and parameters
  (`pull_request_read`, `pull_request_review_write`, `add_comment_to_pending_review`, …) follow
  the official `github/github-mcp-server` API. Curator exercises the read/PR tools but not the
  review‑comment tools, so the inline‑comment + submit‑review flow is the one part not yet
  exercised in production. NeuroLink injects the server's real tool schemas into the model at
  runtime, so minor naming differences self‑correct, but the **first** run against a real PR is
  the definitive check. Use `--dry-run --verbose` locally first.
- **Langfuse‑managed prompts** (if you configure a remote prompt) are currently provider‑agnostic;
  the provider‑aware GitHub prompt applies on the default/local prompt path.
- The default Actions token cannot review **fork** PRs (GitHub security) — use a PAT.

---

## 12. Security notes

- No secrets are committed in this repo: `.env` is git‑ignored and `.env.example` contains only
  placeholders.
- Pass all tokens/keys via GitHub **secrets**, never inline in the workflow.
- Yama's GitHub integration is **read + review‑comment only**; repo‑content‑mutating tools are
  blocked.
