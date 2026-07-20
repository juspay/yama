# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

Yama (`@juspay/yama`) is an AI-native, autonomous pull-request review guardian. It runs one agentic review loop over [NeuroLink](https://github.com/juspay/neurolink) `generate()` with config-driven MCP tools (Bitbucket, GitHub, Serena, local-git, or any server the user configures), posts inline findings, derives a deterministic verdict, and can enhance PR descriptions. Ships as an SDK, a CLI (`yama review|enhance|learn|init`), and a GitHub composite Action (`action.yml`).

## Critical Rules

These are non-negotiable. They mirror the `@juspay/neurolink` conventions where applicable.

1. **Zero `interface` — always `type`.** Never use `interface`; write `type X = { ... }` and use intersection (`&`) instead of `extends`. Enforced by ESLint (`@typescript-eslint/consistent-type-definitions`).
2. **Types in the canonical location.** All exported type definitions live in `src/v2/types/`. Never create type files (or `types/` folders) inside feature directories, and never export a type from a feature module. Internal, non-exported helper types local to one file are acceptable.
3. **No "types" suffix in type filenames.** The folder IS the types folder — `config.ts`, not `config.types.ts`.
4. **Unique exported type names.** Every exported type name must be globally unique across `src/v2/types/` (the barrel would collide otherwise). Disambiguate with domain prefixes (`McpServerDefinition`, `ExploreRuntimeContext`, `LearnRequest`).
5. **Barrel uses `export *` only.** `src/v2/types/index.ts` contains only `export * from "./file.js"` lines — no selective exports, no aliases. Collisions are fixed at the source per rule 4.
6. **Barrel-only type imports.** Code outside `src/v2/types/` imports internal types from `../types/index.js` only — never from specific type files. Files inside `src/v2/types/` import each other directly. External library types (`zod`, `@juspay/neurolink`) import normally. The public package entry `src/index.ts` is the one sanctioned re-exporter of types.
7. **No tool, server, or provider names in `src/`.** Every MCP server (VCS, code-intelligence, git, custom) is a `mcpServers.servers.*` config entry with `roles`/`modes`/`blockedTools`/`allowedTools`. Prompts describe role and method, never tool vocabularies. If a change needs to know a tool name, the name belongs in config, not code.
8. **The verdict is code-derived, never model-trusted.** The AI's reported decision is advisory; `deriveDecision` (`src/v2/core/reviewDecision.ts`) enforces: any CRITICAL finding → BLOCKED, MAJORs at/above threshold → BLOCKED. A prompt-injected "approve" must never clear blocking findings. Do not weaken or bypass this layer.
9. **Structured output comes only from `structuredData`.** NeuroLink owns JSON extraction/repair/validation (`generate({ schema })`). Never `JSON.parse` model prose in Yama code; read `result.structuredData` and treat non-verdict-shaped objects as absent (`isVerdictShaped`). Vertex+Claude supports schema+tools natively; Gemini/LiteLLM paths fall back to coerced JSON — plan for both, and surface `jsonTruncated`/`jsonRepaired` rather than ignoring them.
10. **Fail closed on tool policy.** `allowedTools` allowlists are enforced by discovering the server's tools and blocking the rest; empty discovery = registration failure, not an unenforced allowlist (`MCPServerManager`). Read-only guarantees (e.g. the git read-only list in `toolPolicy.ts`) treat unknown tools as mutating.
11. **Dry-run must stay side-effect free.** Any new write path (comments, description updates, approvals, state) must check the run mode before executing.
12. **Backward compatibility for config.** Existing user configs keep working: new config keys are optional with behavior-preserving defaults; renames get loud validation errors with copy-paste migration hints (`ConfigLoader.validateConfig`) and an entry in `MIGRATION.md`.

## Architecture

### Review flow (PR mode)

```
CLI/SDK → YamaOrchestrator.startReview[AndEnhance]
  1. ConfigLoader (defaults → file → env → SDK overrides) + validation
  2. NeuroLinkFactory (observability, conversation memory, per-repo memory)
  3. MCPServerManager: register config servers for (mode, role) — fail-closed allowlists
  4. Bootstrap standards (explore_context mines recent merged PRs; per-process cache)
  5. PromptBuilder: base system prompt + project config XML + standards + knowledge base
  6. ONE agentic generate() — schema = review verdict; model reads PR via MCP tools,
     posts comments (live mode), may delegate research to explore_context
  7. ensureStructuredVerdict (same-session, tools-off follow-up if verdict missing)
  8. ReviewResultParser → deriveDecision (deterministic safety layer)
  9. Optional phase 2: description enhancement in the SAME session
```

`explore_context` is a Yama-registered NeuroLink tool backed by `ContextExplorerService` — an isolated research sub-agent with its own NeuroLink instance and `explore`-role MCP servers, returning structured findings/evidence.

`submit_review` is the harness gate (also Yama-registered): the agent MUST submit candidate findings there before posting; deterministic dedup (cross-run state + this run + auto-suppressions) plus a critic pass (`review.verification`: off/basic/strict) decide what may be posted. Cross-run state (`src/v2/state/`) makes run N+1 incremental: previously-reported findings are never re-posted, agent-verified fixes are marked resolved, and findings ignored 3+ consecutive runs are auto-suppressed. Loop guards (`performance.loop`), NeuroLink auto-compaction, and `stopReason` handling make partial reviews explicit — a partial review can never end APPROVED.

### Directory Map

```
src/
├── index.ts                  # Public SDK entry (sanctioned type re-exporter)
├── cli/cli.ts                # commander CLI (review | enhance | learn | init)
└── v2/
    ├── core/                 # YamaOrchestrator, MCPServerManager, McpRegistry,
    │                         # NeuroLinkFactory, SessionManager, ReviewResultParser,
    │                         # reviewDecision, reviewSchema, LocalDiffSource,
    │                         # LearningOrchestrator
    ├── config/               # ConfigLoader (merge + validation), DefaultConfig
    ├── prompts/              # PromptBuilder, Review/Enhancement/Learning system
    │                         # prompts, LangfusePromptManager
    ├── exploration/          # ContextExplorerService, ExplorerPromptBuilder,
    │                         # RulesContextLoader (project docs discovery)
    ├── harness/              # Critic + submit_review gate (verification/dedup
    │                         # between agent findings and the PR)
    ├── rules/                # RuleLoader — .yama/rules/** structured team rules
    ├── state/                # ReviewStateStore — cross-run incremental review
    ├── learning/             # KnowledgeBaseManager (.yama/knowledge-base.md)
    ├── memory/               # MemoryManager (per-repo condensed memory / Hippocampus)
    ├── types/                # ALL type definitions — barrel at index.ts
    └── utils/                # toolPolicy, tokenLimits, ProviderDetector,
                              # ObservabilityConfig, version
```

### Key Files

| File                                 | Purpose                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `src/v2/core/YamaOrchestrator.ts`    | Main flow — init, review, enhance, explore tool registration     |
| `src/v2/core/MCPServerManager.ts`    | Config-driven MCP registration; fail-closed `allowedTools`       |
| `src/v2/core/reviewDecision.ts`      | Deterministic verdict policy (`deriveDecision`) — do not weaken  |
| `src/v2/core/reviewSchema.ts`        | Zod verdict schemas passed to `generate({ schema })`             |
| `src/v2/core/ReviewResultParser.ts`  | Normalizes `structuredData` → `ReviewResult`; severity overrides |
| `src/v2/prompts/PromptBuilder.ts`    | Layered prompt assembly (config XML, standards, knowledge base)  |
| `src/v2/config/ConfigLoader.ts`      | Config merge chain + loud migration validation                   |
| `src/v2/utils/toolPolicy.ts`         | Shared tool-name normalization + git read-only allow-list        |
| `src/v2/harness/submitReviewGate.ts` | Pure gate: dedup precedence + critic verdict application         |
| `src/v2/state/ReviewStateStore.ts`   | State backends + reconcileFindings + auto-suppression            |
| `src/v2/rules/RuleLoader.ts`         | .yama/rules loading, prompt compilation, compliance/blocking     |
| `src/v2/types/index.ts`              | Types barrel — start here for any type lookup                    |
| `.yama/config.yaml`                  | This repo's own self-review config (also the reference example)  |
| `action.yml`                         | GitHub composite Action wrapper                                  |
| `REFACTOR_PLAN.md`                   | Phased roadmap (v3 direction: staged agentic flow, rules, state) |

## Development Commands

```bash
pnpm run build         # rimraf dist && tsc && tsc-alias
pnpm run type-check    # tsc --noEmit --skipLibCheck
pnpm run lint          # eslint .   (lint:fix to autofix)
pnpm run format        # prettier --write .
pnpm test              # jest (unit tests in tests/)
pnpm run dev:run       # tsx src/cli/cli.ts — run the CLI from source
node dist/cli/cli.js doctor --config .yama/config.yaml   # config + capability check
```

**Workflow:** edit → `pnpm run type-check` → `pnpm run lint` → `pnpm test` → `pnpm run build`.

Node: CI tests on 20/22/26; the Action runs on Node 26. `engines` floor stays `>=20.18.1` — raising it is a breaking change reserved for a major release.

## Common Patterns

- **Generate calls:** always pass `context: { sessionId, userId, operation }`, `skipToolPromptInjection: true`, and clamp output tokens via `clampMaxTokens`. Memory flags are per-call (`memory: { read, write }`) — operational calls must not write memory.
- **Retries:** wrap `generate()` in `generateWithRetry` semantics — bounded attempts, transient-only (`isTransientError`), exponential backoff.
- **Silent-catch ban:** failures in optional subsystems (memory, knowledge base, bootstrap) degrade gracefully but must log a warning — never a bare `catch {}` that hides the cause.
- **Tests:** unit tests live under `tests/` mirroring `src/v2/`; pure logic (parser, decision, prompts, config) is tested without network. New modules ship with tests.
