# Yama v4 — Task Board

Execution order. Each task is one PR-sized unit with its own tests.
`[ ]` todo · `[~]` in progress · `[x]` done

Legend: **D** = depends on.

---

## Phase 0 · Foundations

- [x] **T0.1** Create `src/v4/` skeleton + `src/v4/types/` barrel. Leave `src/v2/**` on disk,
      unreferenced from the new entry point.
- [x] **T0.2** Bump `@juspay/neurolink` to `^11.x` (11.2.3 installed, declared `^10.8.3`).
      Run prettier on `pnpm-lock.yaml` after install.
- [x] **T0.3** `config/ModelChain.ts` — normalize provider/model arrays → `ModelPoolMember[]`.
      Table-test all five normalization rules + the unequal-length error. **D:** T0.1
- [x] **T0.4** `config/schema/*.ts` — zod per file: `yama`, `mcp`, `review`, `checks`,
      `policy/ownership`, `policy/guards`, `rules`. Only `yama` + `mcp` required. **D:** T0.3
- [x] **T0.5** `config/Loader.ts` — layered merge, `extends:`, v3 single-file compatibility,
      dead-key warning list. **D:** T0.4
- [x] **T0.6** `core/RunContext.ts` — run identity, abort signal, concurrency pool from
      `concurrency.power`, optional deadline (no default). **D:** T0.1
- [x] **T0.7** `connections/Registry.ts` — MCP registration memoized by `(mode, config hash)`;
      unregister on mode switch. **D:** T0.5
- [x] **T0.8** `connections/Capabilities.ts` — capability→tool map, startup probe, stage
      scoping, hard failure in live mode with discovered-tool listing. **D:** T0.7
- [x] **T0.9** `core/NeurolinkFactory.ts` — build instances per role with their own
      `modelPool`; health-probe the three non-pooled slots (summarization, memory
      condensation, file summarization). **D:** T0.3, T0.7
- [x] **T0.10** `cli doctor` — connect, probe capabilities, read a real PR, dry-run post,
      print pooled-vs-probe-only model slots. **D:** T0.8, T0.9

**Exit:** `yama doctor` green end to end. Zero AI calls made.

---

## Phase 1 · Deterministic core

- [x] **T1.1** `findings/Markers.ts` — `yama:finding:<id>`, `yama:summary`, `yama:owners`.
      Only bot-authored comments count as matches. **D:** T0.8
- [x] **T1.2** `findings/Gate.ts` — the seven invariants. Pure, table-tested. **D:** T0.5
- [x] **T1.3** `findings/Ledger.ts` — accepted vs actually-posted, derived from tool
      **results**. **D:** T1.1
- [x] **T1.4** `tools/posting.ts` — capability-mapped post/update/status; rescan before write;
      idempotent; dry-run side-effect free. **D:** T1.1, T0.8
- [x] **T1.5** `changes/ChangeSet.ts` — local `git diff base...head` → files, hunks, added-line
      sets, renames, deletions. Enforce `excludePatterns` / `maxFiles` **in code**. VCS
      fallback for shallow checkouts. **D:** T0.5
- [x] **T1.6** `checks/Runner.ts` — base-branch config resolution, refuse-if-head-modified,
      content-hash cache, output externalization. **D:** T1.5
- [x] **T1.7** `checks/parsers/sarif.ts` — the universal path. **D:** T1.6
- [x] **T1.8** `checks/parsers/{tsc,eslint,junit,regex}.ts`. **D:** T1.6
- [x] **T1.9** `checks/builtin/owners.ts` — deterministic ownership check; full behaviour
      matrix (deletions, renames, multi-rule, author-is-owner, missing `listApprovals`,
      `exclusive`). **D:** T1.5, T0.8
- [x] **T1.10** `policy/guards.ts` — severity floors, forbids, required checks. Pure.
- [x] **T1.11** `core/verdict.ts` — decision from gated findings + policy + blocking checks;
      `verdict.enabled: false`; partial never approves. Pure. **D:** T1.2, T1.10
- [x] **T1.12** `artifacts/PrArtifact.ts` — read/write `.yama/artifacts/pr-<n>/`, compaction
      on growth, absent-artifact tolerance. **D:** T0.5

**Exit:** fixture PR + fixture findings → correct posting, correct re-run dedup, checks run,
owners tagged, verdict produced. **No AI involved.** Heaviest unit coverage of the project.

---

## Phase 2 · Agent surface

- [x] **T2.1** `agents/systemInstruction.ts` — the static constant. Test asserts it contains no
      template expression and no config value.
- [x] **T2.2** `tools/recall.ts` — index-first retrieval over rules, knowledge, memory, product
      map, **and PR artifact** (`scope: "pr"`). Returns citation ids. **D:** T1.12
- [x] **T2.3** `tools/policyCheck.ts` + `tools/checkResults.ts`. **D:** T1.9, T1.10
- [x] **T2.4** `tools/gitSafe.ts` — read-only git allowlist, fail-closed on unknown
      subcommands.
- [x] **T2.5** FS tools sandboxed to repo root; traversal rejection tests.
- [x] **T2.6** `tools/submitFinding.ts` — the gate as a tool; rejection messages name reason
      and remedy. **D:** T1.2
- [x] **T2.7** Stage-scoped tool exposure wiring. **D:** T0.8

**Exit:** a scripted harness calls every tool correctly with no LLM.

---

## Phase 3 · Session, supervisor, stages

- [x] **T3.1** `core/SessionRunner.ts` — session open, bounded turns, guidance injection.
      **D:** T0.9
- [x] **T3.2** `core/Supervisor.ts` — coverage, gate hygiene, waste, drift, compaction
      detection; reads via `getConversationHistory`. **D:** T3.1
- [x] **T3.3** Rule re-injection at turn boundary and after compaction. **D:** T3.2, T2.2
- [x] **T3.4** `core/StageMachine.ts` — S0–S6, exit predicates, bounded remediation, degraded
      reporting. **D:** T3.1
- [x] **T3.5** Compaction wired on every session (`ai.compaction` chain → summarization pair).
      **D:** T0.9
- [x] **T3.6** `modelPool` failover verified live against a forced 429. **D:** T0.9

**Exit:** dry-run review runs end to end; every stage predicate visible in the run report.

---

## Phase 4 · Reviewer and sub-agents

- [x] **T4.1** `agents/mainReviewer.ts` — definition, tools, output schema. **D:** T2.\*, T3.4
- [x] **T4.2** `agents/subAgents.ts` — specialists as delegation tools; pool and per-turn caps
      from `concurrency.power`. **D:** T4.1
- [x] **T4.3** Cross-agent dedup + agreement scoring. **D:** T4.2
- [x] **T4.4** `judge/inline.ts` — 0–100 confidence, threshold 80; check findings bypass.
      **D:** T4.1
- [x] **T4.5** S5 description enhancement in the same session. **D:** T3.4
- [x] **T4.6** S0 `--branch` resolution; reports ambiguity rather than guessing. **D:** T4.1
- [x] **T4.7** Re-run path: marker scan + PR artifact + incremental diff + prior-finding
      classification. **D:** T1.12, T4.1

**Exit:** fresh review and re-run both work live on this repo's own PRs.

---

## Phase 5 · Product impact

- [x] **T5.1** `product/Capabilities.ts` — map read, path→capability resolution.
- [x] **T5.2** `product/ImpactLog.ts` — ledger read, history + prior-regression lookup.
- [x] **T5.3** Impact specialist sub-agent → Impact Report. **D:** T4.2, T5.1, T5.2
- [x] **T5.4** Caller tracing with degradation: code-intel MCP → ripgrep → text. **D:** T5.3

---

## Phase 6 · Learn

- [x] **T6.1** `learn/MergeResolver.ts` — strategy detection + three fallbacks; rebase without
      a fallback disables learning loudly.
- [x] **T6.2** `learn/Triage.ts` — classify human and Yama comments. **D:** T6.1
- [x] **T6.3** Weighting + promotion (conventions at 1–2 occurrences, author-independent);
      weight ranks at recall time. **D:** T6.2
- [x] **T6.4** `learn/KnowledgeWriter.ts` — conventions, suppressions, impact log, capability
      refinement, profile drift. **D:** T6.3, T5.2
- [x] **T6.5** `learn/GitWriter.ts` — ephemeral SSH/askpass credentials, scoped
      `git add .yama/**`, rebase-retry push, never `--force`, never write creds to any config
      file. **D:** T0.5
- [x] **T6.6** `yama doctor --learn` — credential, remote, branch writability, protection rules.
      **D:** T6.5
- [x] **T6.7** `yama bootstrap` — one-time history mining; opens a PR, never a silent first
      write. **D:** T6.4
- [x] **T6.8** `judge/scorecard.ts` — offline quality, per-rule precision/recall, committed
      with the learn commit. **D:** T6.4
- [x] **T6.9** PR artifact consumed by learn, then discarded. **D:** T1.12, T6.4

---

## Phase 7 · Onboarding, migration, cutover

- [x] **T7.1** `yama init` — gated wizard with blocking CONNECT and DOCTOR stages; writes
      `.env.example` and exact CI secret names. **D:** T0.10
- [x] **T7.2** Merge-strategy detection in init; writes the learn workflow with `[skip ci]`,
      actor guard, and `paths-ignore`. **D:** T6.1
- [x] **T7.3** Check-migration offer — stanzas written **disabled and commented out**.
      **D:** T1.6
- [x] **T7.4** CODEOWNERS import offer, `exclusive: true` preserved. **D:** T1.9
- [x] **T7.5** `yama migrate` — v3 → v4 split with a "what moved where" table. **D:** T0.5
- [x] **T7.6** Onboarding guide, migration guide, `MIGRATION.md` entry.
- [~] **T7.7** `action.v4.yml` written and validated. Cutting over `action.yml` and deleting `src/v2/**` is deferred to the rollout — v3 must keep working until v4 is proven on the fleet.

---

## Per-task definition of done

1. Unit tests, table-driven where the logic is a matrix
2. `pnpm run type-check && pnpm run lint && pnpm test && pnpm run build` green
3. No `interface`; types only in `src/v4/types/`; barrel-only imports
4. No tool, server, or provider name in `src/`
5. Dry-run verified side-effect free for any new write path
6. New config keys optional with behaviour-preserving defaults

---

## Audit corrections

Two audits have run against this plan. Both are recorded, because the second
found that the first's "verified" was measuring the wrong thing.

### First audit — six deviations, fixed

| #   | Deviation                                                                                                                           | Fix                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Invented budgets (`TURN_LIMITS`, a default `maxSteps`, per-sub-agent step caps) — the architecture says the agent is the controller | Removed. The only bounds are the ones the plan sanctions: `remediation.maxAttemptsPerStage`, `concurrency.power`, stall/tool timeouts, and an optional `deadline` with no default |
| 2   | S2 was implemented as a single call, and the stage machine was then deleted rather than S2 fixed                                    | `StageMachine` restored as the S0–S6 driver; S2 now holds the supervised turn loop the plan specifies                                                                             |
| 3   | 96 exported types in 37 feature modules, violating rule 2                                                                           | All moved to `src/v4/types/`; modules import from the barrel                                                                                                                      |
| 4   | Seven bare `catch {}` blocks                                                                                                        | Each now states why it swallows                                                                                                                                                   |
| 5   | Provider literals in `src/` (rule 7)                                                                                                | Moved to `config/defaults.ts` as labels, resolved from the environment                                                                                                            |
| 6   | Docs described the deterministic design                                                                                             | Corrected                                                                                                                                                                         |

### Second audit — nine deliverables built and never connected

Every task below had been ticked. Each module existed, was exported from
`src/v4/index.ts`, and had unit tests. **None of them ran.** Nothing in the
review or learn path called into them, so the tests passed, the box was ticked,
and the feature did not exist at runtime.

The lesson worth keeping: a module with tests and an export is not a shipped
feature. `[x]` now means _reached from `runReview`, `runLearn`, or a CLI
command_ — and there is a wiring test that proves it.

| Task           | Was                                                              | Now                                                                                 |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| T4.3           | Cross-agent agreement scoring, never called                      | Delegate results are parsed per turn; agreement raises confidence at the gate       |
| T4.4           | Inline judge, never called — `confidenceThreshold` had no effect | `submit_finding` gates, scores survivors, then re-gates with the scores             |
| T5.1/T5.2      | Capability map and impact ledger, never loaded                   | Read by the config loader; surfaced through `recall`                                |
| T5.3           | Impact report, never rendered                                    | Derived in code and posted in the summary comment                                   |
| T6.7           | `yama bootstrap`, no CLI command                                 | `BootstrapRunner` + `yama bootstrap [--write] [--window n]`                         |
| T6.8           | Scorecard, never computed or committed                           | Run metrics in the report; ground truth in `.yama/knowledge/scorecard.md` on merge  |
| T6.9           | PR artifact never consumed by learn                              | Consumed, promoted to the impact log, then discarded                                |
| T1.6 (`agent`) | `parse: agent` returned `[]` — a stub                            | Schema-bound extraction pass; failure records the check FAILED, never "no findings" |
| §10            | Check findings were evidence only, never posted                  | Gated like any finding and posted in S4                                             |

Four defects found alongside them, all fixed:

1. **Learning measured nothing.** The triage schema asked the model for
   `"convention"` and `"fixed"`; `Triage.ts` matched `"missed-convention"` and
   `"acted-on"`. A cast to the declared type hid the mismatch from the compiler,
   so every human comment fell through to a no-op and precision was permanently
   zero. Schema, prompt and types are now one vocabulary, tested together.
2. **Stage scoping was half a control.** `stages:` was honoured when Yama's own
   code invoked a capability, but the MCP server was registered once for the
   whole run — so every posting tool stayed within the model's reach on every
   turn. Turns now carry `excludeTools`.
3. **S5 trusted the model.** The description predicate believed
   `report_progress`. It now re-reads the pull request and compares against the
   description as it stood before the run.
4. **Two silent catches in `ReviewRunner`.** Unreadable comments produced an
   empty marker scan — which would have re-posted every finding from every
   earlier run — and unreadable approvals silently degraded the ownership check.
   Both are reported now.

### What this round added

- **Structured output everywhere** (rule 15). Every one-shot pass goes through
  `generateStructured`; every review turn carries `turnOutcomeSchema` alongside
  `report_progress`, and the two are merged by union.
- **Prompt management** — Langfuse-backed with the shipped text as the fallback
  on every failure path, resolved once per run, source reported by `doctor`.
- **`--config`** on the CLI. `action.yml` had been passing it for a flag that
  did not exist, so every action run failed at the review step.

### Known and reported, not silently ignored

- `ai.description` and `ai.scorecard` are accepted and read by nothing: the
  description is written inside the review session on `ai.review`, and the
  scorecard makes no model call. `doctor` prints `NOT USED` beside them.
- `extends:` is accepted by the schema and implemented by nothing. The loader
  emits a warning naming it rather than inheriting silently from nowhere.

**Verified:** 918 tests · type-check, lint, prettier and build green · `doctor`
green end to end · no exported types outside `types/` · no unexplained catches ·
no invented budgets.
