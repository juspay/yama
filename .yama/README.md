# `.yama/` — project-level Yama customization

Everything Yama reads for a project lives here, so customization is config, not code.

| File / dir          | Purpose                                                                     | Authored by |
| ------------------- | --------------------------------------------------------------------------- | ----------- |
| `config.yaml`       | Main config (AI provider/model, review focus areas, blocking criteria)      | you         |
| `mcp.json`          | MCP server definitions (see below); `mcp.d/*.json` are merged in name order | you         |
| `prompts/`          | Custom prompt / standards overrides                                         | you         |
| `standards/`        | Coding-standard docs (`*.md`) used as review context                        | you         |
| `knowledge-base.md` | Learnings accumulated by `yama learn` (committed)                           | Yama        |
| `memory/`           | Per-repo condensed review memory (committed)                                | Yama        |

## MCP servers (`mcp.json`)

Uses NeuroLink's `mcpServers` schema. Adding a server is a JSON edit — no code change.
`${ENV_VAR}` placeholders in `args`/`env`/`headers`/`url` are substituted from the
environment at load time, so secrets stay out of the committed file. See
[`mcp.example.json`](./mcp.example.json).

> **⚠️ Trust boundary — off by default.** `.yama/mcp.json` can launch arbitrary
> local commands. Because this file lives in the **checked-out repository being
> reviewed** (attacker-controlled on a PR), Yama does **not** load it unless the
> environment variable **`YAMA_ENABLE_PROJECT_MCP=true`** is set. Set that flag
> only from a **trusted** context (e.g. your own repo, not an untrusted fork/PR):
> it must be set outside the checkout so a PR cannot enable itself. In CI that
> reviews untrusted PRs, leave it unset — the built-in provider servers still run.

- A **`bitbucket`** / **`github`** key overrides the built-in VCS-provider defaults
  (e.g. pin/upgrade the Bitbucket server: `"args": ["-y", "@nexus2520/bitbucket-mcp-server@2.0.4"]`).
- Any **other** key registers an additional server, exposed to the `review` and/or
  `explore` agents via its optional `roles` field.
- **On the built-in provider servers**, Yama's fail-closed denylist blocks the known
  destructive VCS tools (merge/decline/delete/push/etc.) instance-wide. A **custom**
  server can expose any tool name it likes, so those are only as safe as the server
  you configure — review what a custom server exposes, restrict it with its own
  `blockedTools`, and enable project MCP only for trusted checkouts (see above).

## Code intelligence — reviewing beyond the diff

Yama's review prompt instructs the agent to establish a changed symbol's **blast
radius** (cross-file references/callers) before finalizing findings, using
code-intelligence tools **when they are registered**. To enable them, add an
LSP-backed MCP server such as [Serena](https://github.com/oraios/serena) to `mcp.json`
(the example includes a `serena` entry, exposing only its read-only navigation tools).

- **Works out of the box** for languages Serena supports natively — Haskell (HLS),
  TypeScript, Python, OCaml. Ensure the language server is on `PATH` and the project
  is **built** first (HLS/most LSPs resolve cross-file references from build artifacts).
- **ReScript / PureScript** are not built into Serena and need a small `SolidLanguageServer`
  adapter each (a few dozen lines, in a Serena fork) launching `@rescript/language-server`
  / `purescript-language-server`; the project must be compiled (`rescript build`) before
  review. This is the one piece that lives outside this repo.
- **Fallback:** [`isaacphi/mcp-language-server`](https://github.com/isaacphi/mcp-language-server)
  accepts any LSP binary with zero code but exposes a thinner toolset (definition/references
  only) and one process per language.

If no code-intelligence server is configured, the reviewer falls back to
`search_code` / `get_file_content` for the same purpose — nothing breaks.
