# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

Yama (`@juspay/yama`) is an AI-native pull-request review guardian. A supervised
agent session works a stage machine (S0–S6) over config-driven MCP tools, posts
inline findings with concrete fixes, runs the project's own checks as evidence,
and derives a verdict in code. Ships as an SDK, a CLI
(`yama review | learn | doctor | init | migrate | bootstrap`), and a GitHub Action.

## Critical Rules

Non-negotiable. They mirror `@juspay/neurolink` conventions where applicable.

1. **Zero `interface` — always `type`.** Use intersection (`&`), never `extends`.
   Enforced by ESLint (`@typescript-eslint/consistent-type-definitions`).
2. **Types in the canonical location.** Every exported type lives in
   `src/v4/types/`. Never create a `types/` folder inside a feature directory and
   never export a type from a feature module. Internal helper types local to one
   file are fine.
3. **No "types" suffix in type filenames.** The folder IS the types folder —
   `config.ts`, not `config.types.ts`.
4. **Unique exported type names** across `src/v4/types/` — the barrel would
   collide. Disambiguate with domain prefixes (`McpServerConfig`,
   `CapabilityBinding`, `LearnRunOptions`).
5. **Barrel uses `export *` only.** `src/v4/types/index.ts` holds only
   `export * from "./file.js"` lines. Collisions are fixed at the source per rule 4.
6. **Barrel-only type imports.** Code outside `src/v4/types/` imports internal
   types from `../types/index.js` only. Files inside `src/v4/types/` import each
   other directly. External library types (`zod`, `@juspay/neurolink`) import
   normally. `src/v4/index.ts` is the one sanctioned re-exporter.
7. **No tool, server, or provider names in `src/`.** Code asks for a CAPABILITY;
   `.yama/mcp.yaml` maps it to a tool name, optionally with pinned arguments. If a
   change needs to know a tool name, the name belongs in config. The one set of
   tool names Yama ships lives in `data/v3-capability-hints.json` — migration
   guesses for v3 configs, which is data, and it is outside `src/` for this rule.
8. **The verdict is code-derived, never model-trusted.** `deriveVerdict`
   (`src/v4/core/verdict.ts`) decides from what actually POSTED. A prompt-injected
   "approve" must never clear a blocking finding. A partial run never approves.
9. **A tool call is not a comment.** A finding counts as posted only when a tool
   RESULT returned a comment id (`FindingLedger`). v3 recorded accepted findings as
   reported without checking, which turned one posting failure into permanent
   silence about a real defect.
10. **Fail closed on tool policy.** `allowedTools` is enforced by discovering the
    server's tools and blocking the rest; empty discovery is a registration
    failure, not an unenforced allowlist. The git allowlist treats unknown
    subcommands as mutating.
11. **Dry-run must stay side-effect free.** Any new write path checks the run mode
    before executing.
12. **Backward compatibility for config.** New keys are optional with
    behaviour-preserving defaults; renames get loud validation errors with
    copy-paste migration hints and an entry in `MIGRATION.md`.
13. **No budgets.** There is no turn count, no step cap and no token budget, and
    adding one is a design change, not a fix. The agent decides when it is done and
    the stage predicates verify it. Timeouts exist only as hang detectors and come
    from config.
14. **No silent catch.** Optional subsystems degrade, but every failure logs or
    surfaces a warning. `catch {}` that hides a cause is a defect — it is how a
    broken run becomes indistinguishable from a clean one.
15. **Every model call is schema-bound.** Anything asked of a model goes through
    `generateStructured` (one-shot passes) or carries a `schema` on the turn
    (the review loop). Never parse JSON out of prose. A response that does not
    validate is a FAILED member — the chain advances — never an empty result.
16. **One vocabulary per contract.** Where a zod schema, a prompt and a `switch`
    describe the same enum, they are tested together. A cast that reconciles a
    schema with a declared type is how learning silently broke once: the schema
    asked for `"convention"` while the code matched `"missed-convention"`, and
    measured precision sat at zero with nothing reporting a fault.

## Architecture

### Review flow

```
CLI/SDK → runReview (core/ReviewRunner.ts)
  0. resolvePrompts — platform (optional) → shipped text; fixed for the run
  1. loadConfig — defaults → .yama/*.yaml → env → SDK overrides, then validation
  2. createRuntime — one NeuroLink instance, MCP servers registered, capabilities
     resolved against DISCOVERED tools (not against what config claims)
  3. assertLiveCapabilities — a live run that cannot post fails here, not later
  4. readLocalChangeSet — git diff from disk; shallow clones refused
  5. assembleRun — markers + artifact + suppressions decide what is already said
  6. tool surface: recall · policy_check · check_results · submit_finding ·
     report_progress · read_file · list_files · search_code · git
     submit_finding gates deterministically, then scores survivors with the
     inline judge, then re-gates with the scores
  7. registerDelegates — specialists as isolated agent tools
  8. runReviewPipeline — S0–S6 on the StageMachine; S2 holds the supervised loop
  9. artifact written so run N+1 is incremental
```

Stage-scoped tool exposure is a **security control**, not bookkeeping: the agent
reviewing a diff is reading attacker-controlled text, so posting tools do not
exist for it during a review turn.

`report_progress` is how a turn tells the harness what it did — plan, completed
groups, done. It is a tool AND the turn carries `turnOutcomeSchema`, and the two
are merged by union. Belt and braces: a tool's input schema is validated natively
by every provider that can call tools at all, while the turn schema catches the
model that narrates its progress in prose instead of reporting it. Where a
provider cannot combine tools and a schema, the runtime coerces the turn's final
text against it — still enforcement, just later.

### Directory Map

```
src/
└── v4/
    ├── index.ts              # Public SDK entry (sanctioned type re-exporter)
    ├── cli/cli.ts            # commander CLI
    ├── core/                 # ReviewRunner, ReviewPipeline, StageMachine,
    │                         # Supervisor, SessionRunner, StructuredCall,
    │                         # RunAssembly, RunContext, Runtime, ToolExposure,
    │                         # NeurolinkFactory, Doctor, DoctorProbe,
    │                         # RunReport, LocalDiff, verdict
    ├── agents/               # systemInstruction (static), subAgents, turnContract
    ├── prompts/              # PromptStore (platform + local fallback), local catalog
    ├── tools/                # registry, recall, posting, progress, workspace,
    │                         # gitSafe, sandbox, commentFormat
    ├── connections/          # Registry (MCP), Capabilities, invoke, Comments
    ├── checks/               # Runner (pure), execute (spawns), extract, parsers, builtin
    ├── findings/             # Gate, Markers, Ledger
    ├── policy/               # guards, paths
    ├── judge/                # inline confidence, scorecard
    ├── learn/                # LearnRunner, Triage, KnowledgeWriter, GitWriter,
    │                         # MergeResolver, Window, WatermarkStore, Bootstrap,
    │                         # BootstrapRunner
    ├── config/               # Loader, schema, defaults, ModelChain, migrate, v3Compat
    ├── artifacts/            # PrArtifact — cross-run memory
    ├── product/              # capability map + impact ledger
    ├── types/                # ALL type definitions — barrel at index.ts
    └── ...
```

### Key Files

| File                                 | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `src/v4/core/ReviewRunner.ts`        | Assembly — builds every port and runs the pipeline           |
| `src/v4/core/ReviewPipeline.ts`      | S0–S6 definitions; S2 holds the supervised turn loop         |
| `src/v4/core/StageMachine.ts`        | Exit predicates + bounded remediation (NOT a sequencer)      |
| `src/v4/core/Runtime.ts`             | The ONLY file importing the provider SDK                     |
| `src/v4/core/SessionRunner.ts`       | One session, many turns; walks the model chain itself        |
| `src/v4/core/verdict.ts`             | Deterministic verdict policy — do not weaken                 |
| `src/v4/findings/Gate.ts`            | Dedup, invariants, fix-required enforcement                  |
| `src/v4/findings/Ledger.ts`          | Accepted vs actually POSTED, from tool results               |
| `src/v4/connections/Capabilities.ts` | capability → tool name (+ pinned args), probed at startup    |
| `src/v4/checks/execute.ts`           | The only place a check process is spawned; security enforced |
| `src/v4/types/index.ts`              | Types barrel — start here for any type lookup                |
| `.yama/`                             | This repo's own config (also the reference example)          |
| `docs/v4/01-architecture.md`         | The authoritative design                                     |

## Development Commands

```bash
pnpm run build         # rimraf dist && tsc && tsc-alias
pnpm run type-check    # tsc --noEmit --skipLibCheck
pnpm run lint          # eslint .   (lint:fix to autofix)
pnpm run format        # prettier --write .
pnpm test              # jest (unit tests in tests/v4/)
pnpm run dev:run       # tsx src/cli/cli.ts

node dist/v4/cli/cli.js doctor --live --pr <n>   # connects for real
```

**Workflow:** edit → `pnpm run type-check` → `pnpm run lint` → `pnpm test` → `pnpm run build`.

Node: CI tests on 20/22/26. `engines` floor stays `>=20.18.1`.

## Common Patterns

- **Ports and adapters.** Modules are written against structural types
  (`GenerateHost`, `McpHost`, `ToolInvoker`, `CommandRunner`), which is what makes
  the pipeline, supervisor and gate testable without a network. `core/Runtime.ts`
  is the single place that constructs the real client — keep it thin, and put any
  decision in a pure module with a test.
- **Generate calls** always pass `context: { sessionId, userId, operation }`,
  `skipToolPromptInjection: true`, a `schema`, and `memory: { read: true, write:
false }` — operational calls must never write memory. Learning happens on merge.
  One-shot passes (judge, extraction, triage, bootstrap) go through
  `generateStructured`, which walks the chain, validates against the schema, and
  surfaces the runtime's `jsonTruncated` / `jsonRepaired` flags rather than
  swallowing them.
- **Prompts** come from `prompts/PromptStore.ts`. Never import a prompt constant
  at a call site: ask the catalog, so a platform override applies. The shipped
  text in `prompts/local.ts` is the fallback and the only thing tests assert on.
- **Empty is not success.** A response with no content and no tool calls means the
  model produced nothing; treat it as a failed chain member, never a finished turn.
- **Tests** live under `tests/v4/` mirroring `src/v4/`. Pure logic (parser,
  verdict, gate, config, chain) is tested without network. New modules ship with
  tests, table-driven where the logic is a matrix.
