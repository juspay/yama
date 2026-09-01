# Yama

[![npm](https://img.shields.io/npm/v/@juspay/yama.svg)](https://www.npmjs.com/package/@juspay/yama)
[![license](https://img.shields.io/npm/l/@juspay/yama.svg)](./LICENSE)

**Yama is a prompts-driven pull-request review agent**, built on
[NeuroLink](https://www.npmjs.com/package/@juspay/neurolink). ESM, Node >= 22.

Everything is driven by config files in your repository — no code changes to
adopt, tune, or switch providers:

| File           | Purpose                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `config.json`  | Provider/model (string or 1:1 fallback arrays), timeouts, memory, skills |
| `MCP.json`     | MCP servers (stdio / http / sse / websocket), `${VAR}`-expanded from env |
| `prompts.json` | The review flow: ordered prompts run top to bottom in ONE session        |
| `skills/`      | Your rules and conventions — one directory per skill with a `SKILL.md`   |
| `memory/`      | Persisted long-term memory (Hippocampus, SQLite), keyed by `userId`      |

Coming from v5? The engine changed — see **[MIGRATION.md](./MIGRATION.md)** for
the v5 → v6 mapping (your CI secrets are unchanged).

## Quick start

```bash
npm i -D @juspay/yama          # or: pnpm add -D @juspay/yama
npx yama init                  # scaffold the files above; never overwrites
```

Fill in `config.json` (provider + model), put credentials in `.env`
(see `.env.example`), write your rules into `skills/guidelines/SKILL.md`, then:

```bash
npx yama run pr=123 branch=main    # batch: run prompts.json top to bottom
npx yama                           # interactive REPL (same tools and config)
```

Each start is a **new session**; long-term memory persists across sessions in
`memory/hippocampus.sqlite`.

## prompts.json — the review flow

```jsonc
{
  "prompts": [
    // Plain string, or an object carrying per-prompt generate() overrides:
    { "prompt": "Review PR ${pr} on ${branch}…", "maxSteps": 15 },
    "Second step — sees everything the first step did.",
  ],
}
```

- `yama run key=value …` supplies `${key}` substitutions; unmatched references
  fall back to environment variables (with a warning when neither exists).
- All prompts share one session — each sees the full history of the previous
  ones, with automatic context compaction near the model's window.
- A failed prompt aborts the rest and exits non-zero: that is the CI gate.

## config.json

```jsonc
{
  // String OR array. Arrays are a 1:1 fallback chain: pair 0 is primary; on
  // any failure except a caller cancel, the next pair is tried natively.
  "provider": ["litellm", "litellm"],
  "model": ["open-fast", "deepseek"],

  "maxSteps": 60, // tool-execution steps per prompt
  "userId": "my-repo", // long-term memory owner key
  "systemPrompt": "...",

  "timeouts": {
    "requestTimeoutMs": 300000, // one model call
    "turnTimeoutMs": 2400000, // one whole prompt (wall clock)
    "stallTimeoutMs": 180000, // no-progress watchdog
  },

  "compaction": { "enabled": true, "threshold": 0.8 },
  "summarization": { "provider": "litellm", "model": "open-fast" },
  "memory": {
    "path": "memory/hippocampus.sqlite",
    "maxWords": 500,
    "flushWaitMs": 20000,
  },
  "skills": { "path": "skills", "discovery": "tool" },
  "delegation": { "enabled": true, "maxConcurrent": 3 },

  // Escape hatch: merged verbatim into every generate() call — anything
  // NeuroLink supports works here without code changes.
  "generateOptions": {},
}
```

Credentials are env-var names per provider: `litellm` reads
`LITELLM_API_KEY`/`LITELLM_BASE_URL`; `openai` reads `OPENAI_API_KEY`;
`anthropic` reads `ANTHROPIC_API_KEY`; `vertex` reads
`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT_ID` +
`GOOGLE_VERTEX_LOCATION`. Any provider NeuroLink supports works the same way.

## MCP.json

```jsonc
{
  "servers": {
    "github": {
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${YAMA_GITHUB_TOKEN}" }, // ${VAR}
      "timeout": 30000, //                     expands from env — no secrets here
    },
    "code-review-graph": {
      "transport": "stdio",
      "command": "uvx",
      "args": [
        "--from",
        "code-review-graph==2.3.7",
        "code-review-graph",
        "serve",
      ],
      "timeout": 60000,
    },
  },
}
```

Discovered MCP tools merge with NeuroLink's built-ins automatically. The graph
server needs [uv](https://docs.astral.sh/uv/) installed; without it the review
runs without graph context.

## Skills

One directory per skill under `skills/`, each with a `SKILL.md`:

```markdown
---
name: guidelines
description: One line the model uses to decide when to load this skill.
---

The body is the instructions, loaded only when the model activates the skill.
```

Files beside `SKILL.md` (recursively) become on-demand resources — reference
them in the body so the model knows when to fetch them. Only the catalog
(names + descriptions) rides in context; instructions hydrate on activation.

## CI

With the composite action (this repository publishes it):

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: juspay/yama@main
  with:
    vcs-token: ${{ secrets.YAMA_GITHUB_TOKEN }}
  env:
    LITELLM_API_KEY: ${{ secrets.LITELLM_API_KEY }}
    LITELLM_BASE_URL: ${{ secrets.LITELLM_BASE_URL }}
```

Or hand-rolled — this repository reviews itself with
[.github/workflows/yama-review.yml](./.github/workflows/yama-review.yml):
checkout (full history), Node 22 + pnpm, uv, `code-review-graph build`, then
`yama run pr=… branch=…` with the log archived as an artifact.

## Memory

Long-term memory works out of the box with `@juspay/hippocampus@^0.1.8`
(pulled automatically). The SQLite backend needs `better-sqlite3`, shipped as
an optional dependency — on machines without native build tooling it is
skipped and memory disables itself with a warning; everything else works.

## Repository layout

The published package is `reviewer/` (`index.mjs` + `init.mjs`) — the bin,
`yama`, points there. The v5 engine remains in `src/` for reference during the
transition and is no longer published; its removal is tracked separately.

```bash
pnpm install
pnpm run lint         # eslint
pnpm run check        # tsc over src/ and test/
pnpm run build        # v5 engine → dist/ (still exercised by the test suites)
pnpm test             # e2e suites, including suite-reviewer (drives reviewer/)
```
