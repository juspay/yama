# `.yama/` — project-level Yama customization

Everything Yama reads for a project lives here, so customization is config, not code.

| File / dir          | Purpose                                                                                                                                     | Authored by |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `config.yaml`       | Main config (AI provider/model, review focus areas, blocking criteria)                                                                      | you         |
| `mcp.json`          | MCP server definitions (see below); `mcp.d/*.json` are merged in name order                                                                 | you         |
| `prompts/`          | Custom prompt / standards overrides                                                                                                         | you         |
| `standards/`        | Coding-standard docs (`*.md`) used as review context                                                                                        | you         |
| `rules/`            | Structured team rules (YAML/JSON) — id/scope/severity/blocking + examples; violated blocking rules force BLOCKED. Scaffolded by `yama init` | you         |
| `knowledge-base.md` | Learnings accumulated by `yama learn` (committed)                                                                                           | Yama        |
| `memory/`           | Per-repo condensed review memory (committed)                                                                                                | Yama        |
| `state/`            | Cross-run review state (default file-store path) — powers incremental re-review                                                             | Yama        |

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
> reviews untrusted PRs, leave it unset — the `mcpServers.servers` entries from
> the main (trusted) config still run.

- A key with the **same id** as a `mcpServers.servers` entry in the main config
  (e.g. `bitbucket`, `github`) **overrides** that entry — useful to pin/upgrade a
  server: `"args": ["-y", "@nexus2520/bitbucket-mcp-server@2.0.4"]`.
- Any **other** key registers an additional server, exposed to the `review` and/or
  `explore` agents via its optional `roles` field.
- **Tool blocking is per-server config, not a built-in code-level denylist.**
  Restrict each server through its own definition: `blockedTools` (denylist) and
  `allowedTools` (fail-closed allowlist — if the server's tools cannot be
  enumerated, registration fails rather than running unrestricted). Any server
  can expose any tool name it likes, so a server is only as safe as the
  `blockedTools`/`allowedTools` you give it — review what it exposes, restrict
  it, and enable project MCP only for trusted checkouts (see above).

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
