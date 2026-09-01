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

| v5                              | v6                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `yama review --pr N --base ref` | `yama run pr=N branch=x` (params feed prompts)                                  |
| `yama init --platform github`   | `yama init`                                                                     |
| `yama doctor`                   | gone — the startup banner shows every MCP server's connect state and tool count |
| `yama learn`                    | gone — a post-merge memory stage is planned                                     |
| (library import)                | gone — the package is CLI-only                                                  |

## Config map

| v5 (`.yama/`)                       | v6 (repo root)                                           |
| ----------------------------------- | -------------------------------------------------------- |
| `yama.yaml` model chains per role   | `config.json` `provider`/`model` (1:1 arrays)            |
| `mcp.yaml` servers + capability map | `MCP.json` servers only — the model calls tools directly |
| `rulebook/*.md`                     | `skills/<name>/SKILL.md` (loaded on demand)              |
| `checks.yaml`                       | none — CI checks stay CI's job                           |
| `memory/` markdown facts            | `memory/hippocampus.sqlite` (LLM-condensed)              |
| verdict / delivery policy blocks    | your `prompts.json` says what to post and when           |

## Action

Inputs reduced to `pr`, `branch`, `vcs-token`, `yama-version` (default `^6.0.0`),
`node-version`. `dry-run`, `base`, `fail-on-blocked` and the outputs are gone —
the run log artifact is the record, and a failed prompt fails the step.

---

# Migrating to Yama v5

v5 is a rewrite: one autonomous agent working a checklist, deterministic gates around it,
and a capability map instead of platform code. Your v4 configuration does not load in v5 —
but the mapping is mechanical, your CI secrets are unchanged, and nothing here has to be
done under pressure: **a v5 review runs even while parts of the old config are still
unmigrated** (each missing piece is a named degradation in the run report, never a crash).

The fast path:

```bash
pnpm add -D @juspay/yama@^5
pnpm exec yama init --platform github   # scaffolds .yama/ next to your old files; never overwrites
# port your settings using the tables below, then prove it before CI does:
pnpm exec yama doctor                    # exit 2 = something to fix, and it says what
pnpm exec yama review --dry-run          # full review of the local diff, posts nothing
```

The v2 → v4 migration history lives in this file's git history on the pre-v5 mainline.

---

## `.yama/yama.yaml` — `version: 4` → `version: 1`

The `ai:` block is gone. Models are **fallback chains per role**, and the review/verdict
policy that lived in `review.yaml` moves in here.

| v4                                    | v5                                                                 |
| ------------------------------------- | ------------------------------------------------------------------ |
| `ai.provider: [litellm, litellm]`     | `models.main.provider: litellm` (scalar broadcasts over the chain) |
| `ai.model: [private-large, deepseek]` | `models.main.model: [open-fast, deepseek]`                         |
| `ai.subAgent.*`                       | `models.worker.*` (falls back to `main` when unset)                |
| `ai.temperature`                      | not carried — every turn is schema-bound structured output         |
| `ai.maxTokens`                        | not carried — v5 caps generation internally and sizes for input    |
| `ai.timeout`                          | not carried — a 10-minute per-call hang detector is built in       |
| `ai.pool.strategy` / `cooldownMs`     | `pool.tier: low \| medium \| high` (1 / 3 / 6 parallel workers)    |

## `.yama/review.yaml` — folded into `yama.yaml`

| v4                                       | v5                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `concurrency.power`                      | `pool.tier`                                                                    |
| `verdict.enabled` + `blockOn` token list | `verdict.blockOn: [CRITICAL]` / `commentOn: [MAJOR]` (severities)              |
| `verdict.majorThreshold`                 | `verdict.blockAfter` (0 disables)                                              |
| `stages.checks` / `stages.enhance`       | `delivery.*` flags (`inlineComments`, `summaryComment`, `verdict`, `describe`) |
| `remediation.maxAttemptsPerStage`        | built in: schema gate retries once, then a tools-off finalize                  |
| `excludePatterns`                        | not carried in v5 — express file guidance in the rulebook                      |

## `.yama/mcp.yaml` — capabilities move to the top level and get dotted names

v4 mapped camelCase capabilities per server and scoped tools with `stages:`/`roles:`/
`allowedTools:`. v5 has one top-level `capabilities:` map; stage scoping is built in
(posting tools exist only during Delivery; workers never hold them), and only mapped tools
are reachable at all.

| v4 capability               | v5 capability                                                 |
| --------------------------- | ------------------------------------------------------------- |
| `readPullRequest`           | `pr.read`                                                     |
| `listComments`              | `comment.list`                                                |
| `listChangedFiles`          | gone — the diff always comes from git, never the platform     |
| `beginReview`               | `review.begin` (map with `review.submit`, both or neither)    |
| `postInlineComment`         | `comment.inline.create`                                       |
| `submitReview`              | `review.submit`                                               |
| `postSummary`               | `comment.summary.create`                                      |
| `updateDescription`         | `pr.describe`                                                 |
| `stages:` / `roles:`        | built in — phase-scoped exposure, not configuration           |
| `allowedTools/blockedTools` | unmapped = unreachable; opt extra read tools in via `expose:` |
| `timeout`                   | `timeoutMs`                                                   |
| `retryConfig`               | gone — model fallback chains + the schema gate cover it       |

GitHub note: map `comment.list` to `pull_request_read` with
`args: { method: get_review_comments, perPage: 100 }` — the server pages at 30 and a
review-heavy pull request outgrows that.

## `.yama/checks.yaml` — argv arrays, resolved from the base branch

| v4                              | v5                                                                    |
| ------------------------------- | --------------------------------------------------------------------- |
| `enabled` / `allowForks`        | gone — presence of `version: 1` + `checks:` is on                     |
| `run: "pnpm run type-check"`    | `command: ["pnpm", "run", "type-check"]` (argv, never a shell string) |
| `parse: tsc`, `type: builtin.*` | not carried — output is evidence the agent reads                      |
| `blocking: true`                | severity of the resulting finding + `verdict.blockOn`                 |

**Sequencing that matters:** checks are read from the **base branch**. Until your migrated
`checks.yaml` is merged to main, v5 reviews report `checks: off` as a named degradation and
run fine — the first review _after_ the migration merge picks them up.

## Everything else in `.yama/`

| v4                                            | v5                                                               |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `rules/*.yaml`                                | `rulebook/*.md` with an `index.md` — prose rules, read at WarmUp |
| `policy/ownership.yaml`, `policy/guards.yaml` | not carried — fold the intent into the rulebook                  |
| `state/`, `reports/`                          | `artifacts/` — the run store; a CI artifact, never committed     |
| `knowledge/`                                  | `memory/` — written only by `yama learn`, committed              |

## CI, secrets and re-review compatibility

- Replace the v4 workflows with the recipes `yama init` drops in `.yama/ci/`, or use the
  composite action (`action.yml`). Secrets are unchanged: `LITELLM_BASE_URL`,
  `LITELLM_API_KEY`, `YAMA_GITHUB_TOKEN` (plus optional `LANGFUSE_*`).
- Give the review job a 90-minute `timeout-minutes` on self-hosted gateways, restore/save
  `.yama/artifacts/` between runs, and check out with `fetch-depth: 0`.
- **Markers:** v5 recognises v4's `<!-- yama:finding:… -->` markers wherever the forge
  returns raw comment bodies. GitHub's hosted MCP strips HTML comments from its read-back,
  so v5 posts a second, visible `` `yama:finding:<id>` `` token alongside. Practical
  effect: the **first** v5 review of a pull request that only has v4-era comments may
  re-post findings once on that forge; every review after that dedupes.

Exit codes are unchanged as a contract: `0` approve/comment, `1` block, `2` config
(`yama doctor` says how), `3` the run itself failed.
