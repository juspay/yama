# Yama v4 — Implementation Plan

Companion to `01-architecture.md`. Written to be executed in order.

**Ground rule carried forward:** existing `src/v2/**` is not authoritative. Phase 0 quarantines
it. Every module listed here is written fresh against the architecture document. Where an old
file is reused it is named explicitly and reviewed line by line first — never assumed correct.

---

## Phase 0 · Foundations

**Goal:** a skeleton that boots, loads config, connects, and proves capabilities — before any
agent logic exists.

| #   | Deliverable                                                                        | Notes                                                                                  |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0.1 | `src/v4/` created; `src/v2/**` kept on disk, unreferenced from the new entry       | no big-bang delete; v3 CLI keeps working until Phase 7                                 |
| 0.2 | Bump `@juspay/neurolink` to `^11.x`                                                | 11.2.3 already installed; declared dep still says `^10.8.3`                            |
| 0.3 | `config/schema/*` — zod schema per config file                                     | `yama` and `mcp` required; every other file resolves to a behaviour-preserving default |
| 0.4 | `config/Loader.ts` — layered load + `extends:` + v3 single-file compatibility      | dead v3 keys accepted, ignored, listed in one warning                                  |
| 0.5 | `connections/Registry.ts` — MCP registration memoized by `(mode, hash(config))`    | one registration per run; unregister on mode switch                                    |
| 0.6 | `connections/Capabilities.ts` — capability → tool name, startup probe              | missing capability in live mode = hard failure with the discovered tool list           |
| 0.7 | `core/RunContext.ts` — identity, abort signal, concurrency pool, optional deadline | no token or time budget by default                                                     |
| 0.8 | `cli doctor` — connect, probe, read a real PR, dry-run post                        | the command support will ask for first                                                 |

**Exit:** `yama doctor --config .yama/` connects every server, probes every capability, reads a
real PR, and prints a green table. No AI call has been made yet.

**Tests:** loader precedence table · degradation matrix (each optional file absent) · v3 config
acceptance · capability probe failure modes · registration memoization.

---

## Phase 1 · Deterministic core

**Goal:** everything that must be reliable, built and tested before an agent touches it.

| #   | Deliverable                                                                                                        | Notes                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1.1 | `findings/Markers.ts` — write and scan `<!-- yama:finding:id -->`, `<!-- yama:summary -->`, `<!-- yama:owners -->` | only bot-authored comments count as marker matches                          |
| 1.2 | `findings/Gate.ts` — the seven invariants (§7 of architecture)                                                     | pure function, table-tested                                                 |
| 1.3 | `findings/Ledger.ts` — accepted vs **actually posted**, derived from tool results                                  | a tool _call_ is not a comment                                              |
| 1.4 | `tools/posting.ts` — capability-mapped post/update/status, idempotent, dry-run safe                                | rescan before write; update newest bot marker, never someone else's comment |
| 1.5 | `checks/Runner.ts` — command execution, base-branch config resolution, content-hash cache, output externalization  | refuses to run if the head modified a declared script                       |
| 1.6 | `checks/parsers/` — `sarif` first, then `tsc`, `eslint`, `junit`, `regex`                                          | sarif is the language-agnostic path                                         |
| 1.7 | `checks/builtin/owners.ts` — ownership check                                                                       | deterministic; behaviour table in architecture §10                          |
| 1.8 | `policy/` — guards evaluation: severity floors, forbids, required checks                                           | pure                                                                        |
| 1.9 | `core/verdict.ts` — decision from gated findings + policy + blocking checks; `verdict.enabled: false` honoured     | partial run never approves                                                  |

**Exit:** given a fixture PR and a fixture finding set, Yama posts correctly, dedupes across
simulated re-runs, runs checks, tags owners, and produces a verdict — with zero AI involvement.

**Tests:** this phase carries the heaviest unit coverage. Marker dedup across runs · gate
invariant table · posted-vs-accepted accounting · ownership matrix (deletions, renames,
multi-rule, author-is-owner, missing `listApprovals`) · guards · verdict policy.

---

## Phase 2 · The agent surface

**Goal:** the tools an agent needs, before any agent exists.

| #   | Deliverable                                                                          | Notes                                                                |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 2.1 | `agents/systemInstruction.ts` — the static constant                                  | no interpolation; a test asserts it contains no template expressions |
| 2.2 | `tools/recall.ts` — index-first retrieval over rules, knowledge, memory, product map | returns entries with citation ids; path-scoped                       |
| 2.3 | `tools/policyCheck.ts`, `tools/checkResults.ts`                                      | evidence surfaces                                                    |
| 2.4 | `tools/gitSafe.ts` — read-only git allowlist via bash                                | fail-closed: unknown git subcommand = mutating                       |
| 2.5 | `tools/submitFinding.ts` — the gate as a tool                                        | rejection messages name the reason and the remedy                    |
| 2.6 | Local FS tools sandboxed to repo root                                                | reject traversal outside root                                        |
| 2.7 | Stage-scoped tool exposure                                                           | review turns cannot post; posting turns cannot review                |

**Exit:** a scripted harness (no LLM) can call every tool and get correct results.

**Tests:** recall ranking and scoping · git allowlist fail-closed cases · sandbox escape
attempts · gate rejection message contents.

---

## Phase 3 · Session, supervisor, stage machine

**Goal:** the agentic loop with its guardrails.

| #   | Deliverable                                                                                                               | Notes                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 3.1 | `core/SessionRunner.ts` — session open, bounded turns, guidance injection                                                 | one session id per run; sub-agents get their own |
| 3.2 | `core/Supervisor.ts` — coverage, gate hygiene, waste, drift, compaction detection                                         | reads the session via `getConversationHistory`   |
| 3.3 | Rule re-injection on turn boundary and after compaction                                                                   | layer 3 of the rules model                       |
| 3.4 | `core/StageMachine.ts` — exit predicates + bounded remediation. It verifies stages; it does not sequence the agent's work | failure names specifics, never counts            |
| 3.5 | Compaction wired on every session with a dedicated cheap model                                                            | main and sub-agents                              |
| 3.6 | `modelPool` wired for provider failover                                                                                   | 429 moves member, does not retry the review      |

**Exit:** a review runs end to end against a real PR in dry-run, and every stage predicate is
observable in the run report.

**Tests:** stage predicate pass/fail/remediate paths with a stubbed agent · supervisor guidance
triggers · degraded-stage reporting.

---

## Phase 4 · Reviewer and sub-agents

| #   | Deliverable                                                                         | Notes                                                 |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 4.1 | `agents/mainReviewer.ts` — definition, tools, output schema                         |                                                       |
| 4.2 | `agents/subAgents.ts` — specialist definitions registered as delegation tools       | pool + per-turn caps from `concurrency.power`         |
| 4.3 | Structured return contract from sub-agents; cross-agent dedup and agreement scoring |                                                       |
| 4.4 | `judge/inline.ts` — 0–100 confidence, threshold 80                                  | check findings bypass                                 |
| 4.5 | S5 description enhancement in the same session                                      | impact, blast radius, test cases, configured sections |
| 4.6 | `--branch` resolution (S0)                                                          | agentic; reports ambiguity instead of guessing        |

**Exit:** fresh review and re-run both work live on this repo's own PRs.

**Tests:** integration against recorded fixtures · re-run dedup with markers only (no state
store) · concurrency tiers produce the expected fan-out.

---

## Phase 5 · Product impact

| #   | Deliverable                                                                 | Notes                           |
| --- | --------------------------------------------------------------------------- | ------------------------------- |
| 5.1 | `product/Capabilities.ts` — capability map read, path→capability resolution |                                 |
| 5.2 | `product/ImpactLog.ts` — ledger read; history and prior-regression lookup   |                                 |
| 5.3 | Impact specialist sub-agent producing the Impact Report                     | feeds severity, summary, and S5 |
| 5.4 | Caller/dependent tracing with graceful degradation                          | code-intel MCP → ripgrep → text |

**Exit:** a PR touching a mapped capability gets blast radius and historical-risk in its summary.

---

## Phase 6 · Learn

| #   | Deliverable                                                                                                             | Notes                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 6.1 | `learn/MergeResolver.ts` — strategy detection and the three fallbacks                                                   | rebase without a fallback = learning disabled and announced     |
| 6.2 | `learn/Triage.ts` — classify human and Yama comments                                                                    | bounded, session-scoped, judged                                 |
| 6.3 | Weighting and promotion; conventions promote at 1–2 occurrences, author-independent                                     | weight ranks at recall time                                     |
| 6.4 | `learn/KnowledgeWriter.ts` — conventions, suppressions, impact log, capability refinement, profile drift                |                                                                 |
| 6.5 | `learn/GitWriter.ts` — ephemeral SSH/askpass credentials, scoped `git add .yama/**`, rebase-retry push, never `--force` | architecture §9.3                                               |
| 6.6 | `yama doctor --learn`                                                                                                   | proves credential, remote, branch writability, protection rules |
| 6.7 | `yama bootstrap` — one-time history mining, opens a PR                                                                  | never a silent direct write on first use                        |
| 6.8 | `judge/scorecard.ts` — offline review quality; per-rule precision and recall                                            | committed with the learn commit                                 |

**Exit:** merging a PR updates `.yama/**` in a reviewable commit, and the next review demonstrably
uses what was learned.

---

## Phase 7 · Onboarding, migration, cutover

| #   | Deliverable                                                             | Notes                                               |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| 7.1 | `yama init` — gated wizard, blocking CONNECT and DOCTOR stages          | writes `.env.example` and the exact CI secret names |
| 7.2 | Merge-strategy detection in init; writes the learn workflow             |                                                     |
| 7.3 | Check migration offer — writes stanzas **disabled and commented out**   | never automatic                                     |
| 7.4 | CODEOWNERS import offer                                                 | `exclusive: true` preserves last-match-wins         |
| 7.5 | `yama migrate` — v3 → v4 file split with a "what moved where" table     | old config keeps working                            |
| 7.6 | Onboarding guide + migration guide + `MIGRATION.md` entry               |                                                     |
| 7.7 | `action.yml` rewritten for v4; v3 CLI path removed; `src/v2/**` deleted |                                                     |

**Exit:** a fresh repo onboards in one command chain; an existing v3 repo migrates without an
outage.

---

## Sequencing notes

- **Phases 0–1 carry the risk reduction.** They are the parts production data proved broken, and
  they are testable without a model. Do not start Phase 3 before Phase 1 is green.
- **Phase 2 before Phase 3** so the agent is never blocked on a missing tool.
- **Phase 5 and 6 can run in parallel** with each other once Phase 4 lands.
- **Phase 7 last**, so migration is written against the finished shape.

## Definition of done, per phase

1. Unit tests for every pure module, table-driven where the logic is a matrix
2. `pnpm run type-check && pnpm run lint && pnpm test && pnpm run build` green
3. No `interface`, types only in `src/v4/types/`, barrel-only imports (repo rules 1–6)
4. No tool, server, or provider name anywhere in `src/` (repo rule 7)
5. Dry-run verified side-effect free for any new write path (repo rule 11)
6. New config keys optional with behaviour-preserving defaults; renames get loud errors plus a
   `MIGRATION.md` entry (repo rule 12)

## Rollout

1. Ship v4 behind `yama review --v4` while v3 remains default
2. Self-review this repo with v4 for two weeks; read the scorecards
3. Flip the default; keep `--v3` for one minor release
4. Delete `src/v2/**` and the v3 flag

## Acceptance targets

Measured against the production baseline in `docs/trace-analysis-fix-plan-2026-07-31.md`:

| Metric                               | Baseline     | Target                      |
| ------------------------------------ | ------------ | --------------------------- |
| runs that never reach the gate       | 36%          | <2%                         |
| summary comment posted               | 0 of 121     | 100% of live completed runs |
| review status recorded               | 31%          | 100% of live completed runs |
| accepted findings with zero posted   | 16 sessions  | 0                           |
| duplicate finding comments on re-run | observed     | 0                           |
| max VCS tool calls in one run        | 420          | <60                         |
| MCP registrations per session        | ~11          | 1                           |
| review wall clock p95                | up to 94 min | <15 min                     |
| findings carrying a concrete fix     | not enforced | 100% of CRITICAL/MAJOR      |
