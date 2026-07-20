# Yama Refactor & Hardening — Implementation Plan

**Status:** Proposed · **Author:** engineering + AI analysis · **Target package:** `@juspay/yama` (currently 2.7.1)
**Scope:** the six requested changes + all security vulnerabilities, bugs, and tech-debt found during the pre-refactor audit.

---

## 0. Goals

1. Upgrade NeuroLink to the latest (**9.95.3**) and leverage its new capabilities for better PR review.
2. Remove native Jira MCP entirely.
3. Move MCP configuration **out of code** into a project-level **`.yama/` directory** of clean, structured files; adding an MCP becomes "drop a JSON entry," not a code change.
4. Give the reviewer **real code knowledge beyond the diff** (call/dependency graph, impact analysis).
5. Update Bitbucket MCP to latest — folded into #3 (it becomes just another config entry).
6. Make the review architecture **robust**: understand existing code, not only the diff.

Plus, carried in as first-class work: the **CRITICAL destructive-tool exposure**, the **GitHub Actions script-injection** issues, the **stray live credential**, and the top tech-debt items.

---

## 1. Target architecture (the shape we are refactoring toward)

| Concern          | Today                                                                              | Target                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP config       | Hardcoded in `MCPServerManager` (per-provider methods, direct `process.env` reads) | Declarative `.yama/mcp.json` (NeuroLink `mcpServers` schema) loaded generically; Yama layers a **fail-closed safety policy** on top                                                                                         |
| Review verdict   | Reverse-engineered by parsing the model's **prose + tool-call trace**              | **Schema-enforced structured output** (`GenerateResult.structuredData`) — typed findings, decision, severities                                                                                                              |
| Code knowledge   | PR **diff only**                                                                   | Diff **+ LSP-backed code-intelligence** via **Serena** MCP (language-agnostic: any language with a Language Server — ReScript/Haskell/PureScript/TS/Python) with a prompt contract for cross-file references / blast radius |
| Tool safety      | Prose in the system prompt + Jira-only exclusion; destructive tools reachable      | NeuroLink native `tools.include`/`exclude` (globs, **fails closed**) + per-server `blockedTools`; approval derived by Yama code, not an AI tool call                                                                        |
| Orchestrator     | 1 class, 1851 lines, ~45 methods                                                   | Orchestrator + extracted `ReviewResultParser`, `NeuroLinkFactory`, `McpRegistry`, `ReviewContextBuilder`                                                                                                                    |
| Config layout    | Sprawled: `yama.config.yaml` (root), `config/prompts/`, `.yama/`, `memory-bank/`   | Consolidated under `.yama/`                                                                                                                                                                                                 |
| Provider baggage | Jira woven through 11 source files                                                 | Removed                                                                                                                                                                                                                     |

### The `.yama/` project directory (satisfies #3, #5)

```
.yama/
  config.yaml          # human-authored: ai, review, focus areas, providers
  mcp.json             # human-authored: MCP server definitions (NeuroLink `mcpServers` schema)
  mcp.d/               # OPTIONAL: split MCP configs, merged in name order (e.g. 10-bitbucket.json, 20-dep-tracer.json)
  prompts/             # human-authored prompt/standard overrides (replaces config/prompts/)
  standards/           # human-authored coding standards (*.md), replaces memory-bank/ as review context
  knowledge-base.md    # machine-written, committed (learn command output)
  memory/              # machine-written, committed (per-repo condensed memory)
```

- **Human-authored** (`config.yaml`, `mcp.json`, `prompts/`, `standards/`) vs **machine-written** (`knowledge-base.md`, `memory/`) — both live here; the machine-written ones stay committed (they already do today under `.yama/`).
- Back-compat: keep resolving the legacy root `yama.config.yaml` and `config/prompts/` for one minor version with a deprecation warning (see Phase 3).

---

## 2. Phased roadmap

| Phase | Theme                                             | Depends on | Risk     | Ships value                                                  |
| ----- | ------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------ |
| **0** | Safety & cleanup (no upgrade needed)              | —          | Low      | Closes CRITICAL/HIGH security holes immediately              |
| **1** | NeuroLink 9.42→9.95.3 upgrade                     | 0          | Med      | Unlocks native tool policy, structured output, MCP auto-load |
| **2** | Remove Jira                                       | 1          | Low      | Simplifies tool-filtering + config surface                   |
| **3** | Externalize MCP config → `.yama/`                 | 1          | Med      | #3, #5 — declarative MCP, Bitbucket update                   |
| **4** | Code intelligence (dep-tracer + Serena)           | 3          | Med      | #4, #6 — review beyond diff                                  |
| **5** | Robust review (structured output + decomposition) | 1, 4       | Med-High | #6 — accuracy + maintainability                              |
| **6** | Quality hardening & tests                         | all        | Low-Med  | Locks behavior, removes debt                                 |

Guiding rule: **write characterization tests before decomposing** (Phase 6 test scaffolding actually starts during Phase 1 so we can refactor safely).

---

## Phase 0 — Safety & cleanup (do first, independent of the upgrade)

**0.1 — Remove the stray live credential (HIGH / H3).**

- Delete the `~/.config/claude-desktop/claude_desktop_config.json` directory that lives _inside the repo_ (a literal `~` dir from a mis-set `$HOME`). It holds a cleartext Bitbucket token for `bitbucket.juspay.net`.
- **Rotate that Bitbucket token** (it's been on disk since July 2025).
- Add an explicit `/~/` line to `.gitignore` (today it's only ignored by the coincidental `*~` editor-backup glob).
- `chmod 600 .env` (currently 664, world-readable).

**0.2 — GitHub Actions script injection (HIGH / H1, H2).**

- `.github/workflows/ci.yml:116-120`: `${{ github.event.pull_request.head.ref }}` / `head.sha` interpolated into a `run:` block. Move into `env:` vars, reference `"$HEAD_REF"` / `"$HEAD_SHA"` quoted.
- `.github/workflows/single-commit-enforcement.yml:55`: same for `${{ github.head_ref }}`.
- (`action.yml` and `setup-github.sh` are already clean — no change.)

**0.3 — Stopgap for the destructive-tool exposure (CRITICAL / C1).**

- Until Phase 1's native policy lands, union the destructive Bitbucket tools into the default denylist in `DefaultConfig.ts` (`mcpServers.bitbucket.blockedTools`): `merge_pull_request`, `decline_pull_request`, `delete_branch`, `delete_comment`, `update_pull_request`, `create_pull_request`.
- Also block GitHub's `merge_pull_request` / `update_pull_request` (the current GitHub denylist blocks file/branch writes but not these).

**0.4 — Cruft removal (low-risk deletes).**

- Delete root `test-complete-ai-review.js`, `test-external-mcp.js`, `test-simple-context.js`, `test-simple-pr.js` (orphaned scratch scripts, not in build/test).
- Delete `PR_REVIEW_ANALYSIS.md` (orphaned).
- Delete `src/v2/learning/FeedbackExtractor.ts` **and** its test (dead runtime code, superseded by agentic extraction in `LearningOrchestrator`). Decide intentionally: it is _not_ wired in; removal is correct.
- **Do NOT delete `memory-bank/`** — it's stale V1 docs _but_ is read at runtime as review context (`RulesContextLoader`). Instead migrate its useful content into `.yama/standards/` in Phase 3, then retire the `memory-bank/` default path.
- Turn ESLint `no-unused-vars` / `@typescript-eslint/no-unused-vars` back **on** (`eslint.config.js:46,84`) so dead code can't silently re-accumulate. Fix the fallout.

**0.5 — Fix stale install.** `node_modules` has NeuroLink 9.42.0 while the lockfile pins 9.70.7 — run `pnpm install` to reconcile before touching anything (Phase 1 then bumps to 9.95.3).

**Acceptance:** no secrets in the tree; Actions workflows pass shellcheck-style review; a malicious PR cannot reach merge/delete tools; repo builds with unused-vars lint on.

---

## Phase 1 — NeuroLink upgrade 9.42/9.70 → 9.95.3

**1.1 — Bump & install.** `package.json` → `@juspay/neurolink@^9.95.3`; `pnpm install`. Confirm `@juspay/hippocampus` peer still satisfied. Node engine already `>=20.18.1` (matches NeuroLink's new floor) — verify CI runners and `action.yml` (Node 24 there is fine).

**1.2 — Breaking-change adaptation** (audit these against current code):

- **Response shape.** `GenerateResult` now exposes `stopReason`, `rawFinishReason`, `stepsUsed`, `structuredData`, `jsonRepaired`, `jsonTruncated`, `reasoning`/`reasoningTokens`. Verify `recordToolCallsFromResponse` / `parseReviewResult` read current field names (`toolCalls: {toolCallId,toolName,args}`, `toolResults`, `toolExecutions`, `toolsUsed`).
- **Vertex/Gemini internals swapped** to native `@google/genai` + `@anthropic-ai/vertex-sdk`. Re-test Vertex + LiteLLM flows (the self-review workflow uses LiteLLM `private-large`). Note: `MALFORMED_FUNCTION_CALL` now maps to `stopReason:"error"` (was `"tool-calls"`) — check any verdict logic that keys off finish reason.
- **Tool-policy semantics changed (9.91).** `enabledToolNames` now filters the _native_ tool set and is ignored when `toolFilter` is set; instance `tools.include: []` / malformed shape **fails closed**. Audit `getPRToolFilteringOptions` / `getLocalToolFilteringOptions`.
- **Removed types.** `InMemoryMCPServerConfig`, `InMemoryToolInfo`, `InMemoryToolResult` → use `MCPServerInfo` / `ToolDefinition` / `ToolResult`.
- **`usage`/`analytics`** may include cached-token fields and (on streams) be a Promise — await defensively.
- **Cloud SDKs moved to `optionalDependencies`** — if we rely on Bedrock/Vertex/SageMaker, ensure the peer SDK is installed.

**1.3 — Adopt Priority-1 features now** (they enable later phases):

- **Native fail-closed tool policy** (replaces the C1 stopgap): construct NeuroLink with `tools: { exclude: ["*merge*","*delete*","decline_*","*create_pull_request*","update_pull_request", ...] }` as a **denylist**, and prefer an **allowlist** (`tools.include`) of the read + comment + approve tools for the review agent. Keep per-server `blockedTools` as defense-in-depth. This is the durable fix for the destructive-tool vulnerability.
- **`skipToolPromptInjection: true`** is already used — keep it (native tool passing, ~30K token saving).

**Acceptance:** existing test suite green on 9.95.3; a live Bitbucket + GitHub review run produces the same decision/counts as 2.7.1 on a known PR; tool policy verified to block a `merge_pull_request` attempt.

---

## Phase 2 — Remove native Jira MCP

**2.1 — Code deletions** (Jira touches 11 source files):

- `MCPServerManager.ts`: delete `setupJiraMCP`, the Jira branch in `setupMCPServers`, Jira env reads.
- `config.types.ts`: delete `JiraConfig`, drop `jira` from `MCPServersConfig`.
- `DefaultConfig.ts`: remove the `jira` block.
- `ConfigLoader.ts`: remove Jira env overrides + validation.
- `YamaV2Orchestrator.ts`: **delete the Jira-only `getPRToolFilteringOptions` logic** — this method exists _solely_ to exclude Jira tools; with Jira gone it collapses to nothing (or to the generic policy from Phase 1). Big simplification.
- `PromptBuilder.ts`, `ExplorerPromptBuilder.ts`, `ContextExplorerService.ts`: strip Jira tool references from prompts.
- `cli.ts`, `v2.types.ts`, `mcp.types.ts`: remove Jira flags/types.

**2.2 — Non-code:** drop `@nexus2520/jira-mcp-server` from `package.json`; remove `jira` from `.mcp-config.example.json`, `yama.config.example.yaml`, `yama.config.github.example.yaml`, README, `GITHUB_SETUP.md`, `.env.example` (JIRA\_\* vars).

**2.3 — Migration note:** if anyone still wants Jira context, it comes back for free in Phase 3 as a _user-added_ `.yama/mcp.json` entry — Yama just won't ship or hardcode it.

**Acceptance:** `grep -ri jira src/` returns nothing; config validates without Jira; review unaffected.

---

## Phase 3 — Externalize MCP configuration (#3, #5)

**3.1 — Generalize the config model.** Replace the hardcoded `MCPServersConfig { bitbucket, github, jira }` with a **generic server map** matching NeuroLink's `mcpServers` schema (`MCPServerInfo`): `{ transport, command, args, env, url, headers, auth, timeout, retryConfig, blockedTools }`, with `${ENV_VAR}` substitution in `env`/`headers`. Support stdio **and** http/sse.

**3.2 — Loader.** Add `McpRegistry` that:

1. Reads `.yama/mcp.json` (and optionally `.yama/mcp.d/*.json`, merged by filename order).
2. Applies Yama's **safety policy**: intersect each server's exposed tools with a Yama-maintained allowlist per role (review agent = read + comment + approve; explorer = read-only), enforced via NeuroLink `tools.include`/`blockedTools`. **This keeps the security guarantee even for user-added servers** — a newly dropped-in MCP cannot expose destructive tools to the reviewer unless explicitly allowlisted.
3. Registers each via `neurolink.addExternalMCPServer(id, config)` (existing verified API) — or lets NeuroLink auto-load if we standardize on the native `.mcp-config.json` name. **Recommendation: Yama-owned `.yama/mcp.json` + explicit register loop**, so Yama controls ordering, the safety-policy layer, and provider detection.

**3.3 — Bitbucket update (#5).** Bitbucket becomes a plain `.yama/mcp.json` entry. Update to the latest server by changing `args` (`npx -y @nexus2520/bitbucket-mcp-server@latest`) or pointing at the local binary; no code change. GitHub likewise. Ship sensible defaults in `.yama/mcp.example.json` so zero-config still works.

**3.4 — Kill direct `process.env` reads in MCP setup.** The 16 direct env reads in `MCPServerManager` move into config `${ENV}` substitution routed through `ConfigLoader` (addresses the "27 stray env reads" debt for the MCP layer).

**3.5 — Config consolidation.** `ConfigLoader.resolveConfigPath` prefers `.yama/config.yaml`, falls back to legacy `yama.config.yaml`/`config/yama.config.yaml` with a deprecation warning. Migrate `config/prompts/` → `.yama/prompts/`, `memory-bank/` → `.yama/standards/`. Provide `scripts/migrate-config.cjs` update to move existing repos.

**Acceptance:** deleting all provider code from `MCPServerManager` and defining servers only in `.yama/mcp.json` yields a working review; adding a new MCP server needs only a JSON edit; user-added servers cannot expose destructive tools to the reviewer.

---

## Phase 4 — Code intelligence: review beyond the diff (#4, #6)

**Decision: Serena (`oraios/serena`) — an LSP-backed MCP server — as the single, language-agnostic code-intelligence layer.** (Replaces the earlier dep-tracer idea, which was rejected for being ReScript/Haskell-specific.)

**Why LSP is the only mechanism that fits this stack.** The target repos are polyglot and functional-heavy: `juspay-portal` and `rescript-euler-dashboard` are thousands of `.res` files; Haskell in `euler-api-*`; PureScript in `hyper-upi`; TypeScript in `curator`; Python scattered. Every non-LSP option **has no ReScript and no PureScript coverage** — SCIP/Sourcegraph indexers, Meta Glean, CodeQL, and every tree-sitter code-graph MCP; `github/stack-graphs` is archived (2025-09). The _one_ thing all these languages share is a mature **Language Server** (`@rescript/language-server`, `haskell-language-server`, `purescript-language-server`, `typescript-language-server`, Pyright). "Any language with an LSP" therefore covers 100% of the stack through one integration. Serena is the mature, MIT-licensed (26.6k★, v1.6.0 · 2026-07-16) MCP server that productizes this, exposing the richest review-relevant toolset.

**Tools it gives the reviewer** (map directly onto "understand the code around the diff"):

- `get_symbols_overview` — definitions/outline of a changed file
- `find_symbol` — locate a symbol's definition anywhere in the project
- `find_referencing_symbols` — **cross-file usages/callers of a changed symbol (blast radius)**
- find implementations, **type hierarchy**, diagnostics; plus persistent project "memories" for cross-PR architectural context.

**Read-only enforcement:** Serena also ships edit/rename/`write_memory` tools. Expose **only** the read subset above to the reviewer; block the rest via the Phase-1/Phase-3 fail-closed tool policy (`tools.include` allowlist). This is why Serena slots cleanly into the security model rather than fighting it.

**4.1 — Phase 4a: wire Serena for the natively-supported languages (ship first, zero adapter code).**

- Add Serena to `.yama/mcp.json` as an MCP server (stdio: `serena start-mcp-server --context ide-assistant --project <repo>`; install via `uv tool install serena-agent`).
- **Haskell, TypeScript, Python work out of the box** (Serena auto-locates HLS via ghcup/stack/PATH; bundles typescript-language-server + Pyright). This immediately covers `curator` (TS), the `euler-api-*` Haskell services, and Python.
- **Prompt contract** in review `workflowInstructions`: after reading a changed file, for each non-trivial changed symbol the model MUST call `find_referencing_symbols` (who uses this — blast radius) and `get_symbols_overview`/`find_symbol` on unfamiliar callees, **before** finalizing findings.
- Curated read-only tool subset (avoid tool overload — Yama already loads ~92 tools): `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `find_implementations`, type-hierarchy, `search_for_pattern`.

**4.2 — Phase 4b: add ReScript + PureScript adapters (worth it — ReScript dominates).**

- ReScript/PureScript are not built into Serena, and its config-only "bring-your-own-LSP" PR (#361) was closed stale — the maintainers prefer a small Python adapter. Per Serena's `adding_new_language_support_guide.md`, each adapter is a few dozen lines: subclass `SolidLanguageServer`, return a `DependencyProvider` (`SinglePath`/`BaseCommand` fits npm-launched servers), register in the `Language` enum + `create()` factory, add a tiny fixture repo + tests. Serena already ships a fully-custom pygls LSP (mIRC "mSL") as proof the path works end to end.
- ReScript: launch `@rescript/language-server --stdio`. **Operational requirement:** cross-file references come from the compiler's `.cmt`/`.cmt`-derived artifacts, so the project **must be built (`rescript build`) before review** or `find_referencing_symbols` is blind.
- PureScript: launch `purescript-language-server --stdio` (spawns `purs ide`); likewise needs the project compiled first.
- Maintain as a fork or upstream (MIT permits either). Given `juspay-portal` alone is 3,200+ `.res` files, this one-time adapter cost is clearly justified.

**4.3 — Phase 4c: harden & fill gaps.**

- **Caller-tree limitation (inherent to the LSPs, not the tool):** HLS / typescript-language-server / Pyright support `callHierarchy` (full incoming/outgoing callers). `@rescript/language-server` and `purescript-language-server` **do not** advertise call hierarchy — for those two the reviewer gets definitions + `find_referencing_symbols` (usages), which covers most blast-radius needs but not a native caller tree. No tool on the market gives a true ReScript/PureScript call graph today, so this is a stack-wide floor, not a Serena weakness.
- Optional complement: **`ast-grep-mcp`** for fast structural pattern search (a ReScript tree-sitter grammar exists and can be dynamically loaded). Adds "find this construct across the repo" — _not_ a reference graph; use alongside Serena, never instead.
- Optional hybrid recall: NeuroLink's `rag:{files}` or a lightweight embeddings tool _only_ for "find prior-art / similar code" — structure stays the source of truth.

**Operational model (important for CI):** Serena builds **no persistent index** — each language server does live, incremental analysis, so there is **no index-build step to schedule/cache**. The real costs are (a) the project must be **built** so HLS/ReScript/PureScript have artifacts, and (b) language-server memory/warm-up (**HLS is memory-heavy and slow to warm on large Haskell repos**). Budget a warm build cache in the review environment. No per-seat fees (unlike CodeQL Code Quality at $10/committer/mo or Sourcegraph Enterprise).

**Fallback (#2): `isaacphi/mcp-language-server`** — a Go MCP server that takes _any_ stdio LSP via CLI args with zero code (`--lsp rescript-language-server -- --stdio`), exposing `definition`, `references`, `hover`, `rename`, `diagnostics`. Choose it only if the Serena adapter work is unwanted: trade-offs are a thinner toolset (no call hierarchy, no symbols-overview), **one LSP process per language**, and beta maturity (v0.1.1). Baseline-only fallback for repos that can't stand up any language server: `repomix` tree-sitter-compressed repo map — no reference graph.

**Acceptance:** on a Haskell/TS PR, the review cites callers/usages the raw diff doesn't show and flags a wide-blast-radius change 2.7.1 missed; ReScript adapter returns cross-file usages on a built `.res` project; only read-only Serena tools are reachable by the reviewer.

---

## Phase 5 — Robust review architecture (#6)

**5.1 — Structured output replaces prose parsing.** Give the review `generate()` call a `schema` (Zod/JSON) for `{ decision, findings[], severities, filesReviewed, summary }`; read `GenerateResult.structuredData` (with `jsonRepaired`/`jsonTruncated` handling). This removes the fragile `extractDecision`/`extractIssueCountsFromComments`/severity-marker parsing (~700 lines of inference) and makes the verdict deterministic. **Approval is then derived by Yama code from counted blocking findings — not by the AI invoking an approve tool** (closes security M2).

**5.2 — Two-stage review.** Stage A: gather context (diff + code-graph impact analysis). Stage B: judge with the gathered context. Keep the single session so the model retains state.

**5.3 — Optional: AgentNetwork multi-agent.** Evaluate NeuroLink `AgentNetwork` to split review into specialist agents (correctness / security / style) with a synthesis pass. Higher cost; gate behind config. Defer unless single-agent accuracy is insufficient after 4–5.

**5.4 — Decompose the orchestrator** (prereq for testability). Extract from `YamaV2Orchestrator` (1851 → target <600):

- `ReviewResultParser` (the `:825–:1526` parsing/normalizing cluster).
- `NeuroLinkFactory` (kills the 3 duplicate `initializeNeurolink` methods across orchestrator/learning/explorer).
- `McpRegistry` (from Phase 3).
- `ReviewContextBuilder` (bootstrap standards + code-graph context + KB).

**Acceptance:** verdict comes from `structuredData`, not regex on prose; orchestrator under ~600 lines; parser unit-tested in isolation.

---

## Phase 6 — Quality hardening & tests

- **Characterization tests first** (started in Phase 1): lock current behavior of `ReviewResultParser`, `ConfigLoader`, `McpRegistry`, `ContextExplorerService` before/while decomposing. Target the 23 of 31 modules with zero coverage, prioritizing the high-churn core.
- **Consolidate duplication:** single `normalizeToolName` (drop the 3 copies), single `extractJsonPayload`, unify tool-name policy into `toolPolicy.ts` (remove the lists scattered across `ProviderToolset`/`MCPServerManager`/`ContextExplorerService`).
- **Collapse ProviderToolset duplication** (~200 near-identical lines between Bitbucket/GitHub) into a shared template + per-provider tool-name table.
- **Route remaining `process.env`** through `ConfigLoader`; document the full env surface in one place.
- **Reduce `any`** on the public surface (`enhanceDescription(): Promise<any>`, `setupMCPServers(neurolink: any)`).
- **Naming cleanup:** rename `YamaV2Orchestrator.ts` → `YamaOrchestrator.ts` (class is already `YamaOrchestrator`); drop `v2.cli.ts` shim; retire `createYamaV2`/`YamaV2Config` aliases; fix `SessionManager.ts:34` hardcoded version `"2.2.1"` → read from package. Decide whether `src/v2/` becomes `src/`.
- **Config hygiene:** type the currently-dropped keys (`nonBlockingGuidance`, `referenceFiles`); reconcile `explore.maxTokens` (16000) vs `MAX_EXTRACTION_TOKENS` (12000); de-dupe hardcoded model/URL/timeout literals.
- **Preserve error context** in the ~7 fully-silent `catch {}` blocks (ContextExplorer/MemoryManager) for debuggability.

---

## Cross-cutting: Security findings (tracked to phases)

| Sev      | ID    | Issue                                                                                       | Fixed in                                                                     |
| -------- | ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| CRITICAL | C1    | Reviewer can call destructive VCS tools (merge/decline/delete); only Jira was ever excluded | 0.3 stopgap → 1.3 native fail-closed policy → 3.2 policy layer               |
| HIGH     | H1/H2 | Actions script injection via `head.ref`/`head_ref` in `run:` blocks                         | 0.2                                                                          |
| HIGH     | H3    | Stray live Bitbucket token in `~/.config/...` inside repo; `.env` world-readable            | 0.1 (+ rotate token)                                                         |
| MEDIUM   | M1    | PR code/diff egress to Langfuse cloud + AI provider                                         | Document; default Langfuse to self-hosted for private repos (Phase 3 config) |
| MEDIUM   | M2    | AI-invoked auto-approval with filtering off                                                 | 5.1 (approval derived by code)                                               |
| MEDIUM   | M3    | `deepMerge` has no `__proto__`/`constructor` guard                                          | 6 (ConfigLoader hardening)                                                   |
| LOW      | L1    | Config-supplied paths not contained to project root                                         | 6 (path containment assert)                                                  |
| LOW      | L2    | `node-cache`, `lodash` declared but unused                                                  | 0.4 / 6 (drop deps)                                                          |

## Cross-cutting: Bugs

| Bug                                                                                          | Location                                                           | Fix phase             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| `learn` always spawns Bitbucket MCP even for GitHub (prompt is GitHub-aware)                 | `LearningOrchestrator.setupMCPServers` (`:92`, no provider passed) | 3 (config-driven MCP) |
| Stale hardcoded version `"2.2.1"`                                                            | `SessionManager.ts:34`                                             | 6                     |
| `explore.maxTokens` 16000 vs `MAX_EXTRACTION_TOKENS` 12000 inconsistency                     | `DefaultConfig.ts:47` / `tokenLimits.ts`                           | 6                     |
| Unknown YAML keys silently kept but ignored (`nonBlockingGuidance`, `referenceFiles`)        | `ConfigLoader.deepMerge`                                           | 6                     |
| Vertex `MALFORMED_FUNCTION_CALL` finish-reason remap (post-upgrade) could skew verdict logic | verdict/parse path                                                 | 1.2                   |

## Cross-cutting: Tech-debt (top targets)

1. Decompose `YamaV2Orchestrator` (1851 LOC) → Phase 5.4.
2. Tests on untested core (23/31 modules) → Phase 6 (start in 1).
3. ProviderToolset Bitbucket/GitHub ~200-line duplication → Phase 6.
4. Fragmented tool-name policy + 3× `normalizeToolName` / `initializeNeurolink` → Phase 6.
5. 27 stray `process.env` reads → Phases 3 & 6.
6. ESLint `no-unused-vars` off → Phase 0.4.
7. Hardcoded model/URL/timeout literals → Phase 6.
8. v1/v2/guardian naming vestiges → Phase 6.

---

## Risks & mitigations

- **Upgrade regressions (Vertex/LiteLLM path rewrite).** Mitigate: characterization tests + a golden-PR smoke run on both providers before/after (Phase 1 acceptance).
- **Structured-output + tools on Gemini** — Gemini can't do schema + tools together (auto-fallback); Vertex-Claude can. Mitigate: use a two-pass (tools pass, then tool-less schema-extraction pass — already the current pattern) or route the extraction to a Claude model.
- **Code-intelligence requires a built project + heavy language servers.** Serena does live LSP analysis, so ReScript/Haskell/PureScript need the project **compiled** before review (else `find_referencing_symbols` is blind), and HLS is memory-heavy/slow to warm. Mitigate: warm build cache in the review env; treat LSP output as strong-but-advisory; ReScript/PureScript adapters are a one-time cost.
- **Tool overload** (~92 tools + new Serena tools). Mitigate: expose only Serena's read-only subset via `tools.include` allowlists per role; NeuroLink `search_tools` discovery deferral.
- **Config migration breaking existing users.** Mitigate: back-compat resolution + deprecation warnings + `migrate-config` script; major-version bump.

## Definition of done

- NeuroLink 9.95.3; suite green; golden-PR parity on Bitbucket + GitHub + LiteLLM.
- No Jira references in `src/`.
- MCP servers defined only in `.yama/mcp.json`; adding one is a JSON edit; Bitbucket on latest.
- Reviewer demonstrably uses cross-file references / callers (Serena) on a Haskell/TS PR; ReScript adapter returns usages on a built project.
- Verdict from `structuredData`; approval derived by Yama code.
- Destructive tools provably unreachable by the review agent (fail-closed).
- No secrets in tree; Actions injection closed; token rotated.
- Orchestrator < ~600 lines; core modules under test; `no-unused-vars` on and clean.

```

```
