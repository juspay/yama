# Migrating to Yama v6

v6 replaces the engine: the checklist/stage machine gave way to a small
prompts-driven reviewer on NeuroLink. Your CI secrets are unchanged; the config
layout and commands are not. The old engine no longer ships in the package.

The fast path:

```bash
npm i -D @juspay/yama@^6
npx yama init            # scaffolds config.json / MCP.json / prompts.json / skills/ — never overwrites
# fill config.json (provider/model) and .env, port your rulebook into skills/, then:
npx yama run pr=123 branch=main
```

## Command map

| v5                              | v6                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yama review --pr N --base ref` | `yama run pr=N branch=x` (params feed prompts)                                                                                                                                                         |
| `yama init --platform github`   | `yama init`                                                                                                                                                                                            |
| `yama doctor`                   | gone — the startup banner shows every MCP server's connect state and tool count                                                                                                                        |
| `yama learn`                    | `yama learn pr=N` — one `learnPrompt` turn distills the merged PR's discussion into the committed `memory/hippocampus.sqlite`, then a deterministic commit+push (`[skip ci]`, gated by `config.learn`) |
| (library import)                | gone — the package is CLI-only                                                                                                                                                                         |

## Config map

| v5 (`.yama/`)                       | v6 (repo root)                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `yama.yaml` model chains per role   | `config.json` `provider`/`model` (1:1 arrays)                                    |
| `mcp.yaml` servers + capability map | `MCP.json` servers only — the model calls tools directly                         |
| `rulebook/*.md`                     | `skills/<name>/SKILL.md` (loaded on demand)                                      |
| `checks.yaml`                       | none — CI checks stay CI's job                                                   |
| `memory/` markdown facts            | `memory/hippocampus.sqlite` (LLM-condensed, committed — updated by `yama learn`) |
| verdict / delivery policy blocks    | your `prompts.json` says what to post and when                                   |

## Action

Inputs reduced to `pr`, `branch`, `vcs-token`, `yama-version` (default `^6.0.0`),
`node-version`. `dry-run`, `base`, `fail-on-blocked` and the outputs are gone —
the run log artifact is the record, and a failed prompt fails the step.

The v4 → v5 migration guide lives in this file's git history.
