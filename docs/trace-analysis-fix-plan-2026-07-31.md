# Langfuse Trace Analysis & Finalized Fix Plan — 2026-08-03

Source: the production Langfuse project (base URL and keys via
`LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`; not
reproduced here).
Windows analyzed: **W1** = Jul 27 → Jul 31 10:45 (~9,600 traces, 648 Yama
sessions) and **W2** = Jul 31 10:45 → Aug 3 (~3,900 traces, 181 sessions).
Fleet versions in traffic: v2.2.1 (legacy, no gate), v3.0.1, v3.0.2
(dominant in W2: 121 of 181 sessions).

All `file:line` references in this document are pinned to **v3.0.2**
(commit `087e7c6`); re-resolve them against that tag if the files have since
moved.

---

## 1. Headline numbers

| Metric                                         | W1 (Jul 27–31)                      | W2 (Jul 31–Aug 3)           |
| ---------------------------------------------- | ----------------------------------- | --------------------------- |
| Provider generation error rate                 | **16%** (583× gemini-3.5-flash 429) | **0–1%** (storm over)       |
| v3.0.x runs that never call `submit_review`    | 39% (63/162)                        | **still 36%** (44/121)      |
| Sessions with accepted findings, zero comments | 16                                  | 3                           |
| **Summary comments posted**                    | rare                                | **0 / 121 v3.0.2 sessions** |
| Review status recorded (`set_review_status`)   | ~18%                                | **31%** (56/181)            |
| Max `explore_context` calls in one run         | 34                                  | **45** (94-minute review)   |
| Max VCS tool calls in one run                  | ~250                                | **420** (25-minute review)  |
| MCP re-registration (`guest`) traces           | 7,115/4d (~11/session)              | unchanged pattern           |
| Redis conversation-memory init                 | 100% failure                        | unchanged                   |

Metric definitions (for reproducing the baseline and the acceptance
comparison): all rates are over **Yama review sessions** (`sessionId` prefix
`yama-`) in the stated window unless noted. Version cohorts come from the
`yamaVersion` attribute on `neurolink.tool.execute` spans. Error rate =
ERROR-level / all `neurolink.provider.generate` GENERATION observations
(W1 sample n=3,940; W2 n≈3,250). Gate calls = `tool.execute` spans with
`tool.name=submit_review`; posted comments = `add_comment` TOOL observations;
status = `set_review_status` TOOL observations (denominator: all sessions,
181 in W2). Summary comments = `add_comment` payloads carrying a summary
heading (denominator: v3.0.2 sessions, 121 in W2). MCP registrations =
session-less `guest` traces with `neurolink.mcp` scope. All queries are plain
`/api/public/traces` + `/api/public/observations` name/time filters.

**Key W2 insight:** the 429 storm ended, but the no-comment/no-summary rates
barely moved. Provider overload was an _amplifier_, not the root cause. The
remaining failure modes are structural.

## 2. Root causes — final

### 2.1 "No summary / no review post" — a v3 regression (CONFIRMED)

Commit `53b4a55` (v3 refactor) deleted from the system prompt, with no code
replacement:

- the `<summary-format>` block ("## 🤖 Yama Review Summary", severity counts,
  statistics) and the step "Post summary comment with statistics and next steps";
- the explicit decision-workflow steps `set_review_status(request_changes)` /
  `set_pr_approval(approved)` (v3 keeps only a vague "record your review
  decision" phrase).

The Langfuse-managed prompt `yama-review` v3 (production since Jul 28) matches
the repo prompt — both lack any summary instruction. Result measured in W2:
**zero summary comments in 121 v3.0.2 sessions**; review status set in only
31% of runs. Meanwhile repo-level `workflow-instructions` in fleet configs
("Phase C — IN the final summary comment: include an Impact section") still
_assume_ a summary comment exists — a broken contract. The only compensating
control is `action.yml`'s GitHub-only, blocked-only verdict comment; the
Bitbucket fleet has nothing.

### 2.2 "Findings accepted but never posted"

Four verified mechanisms (deep-dived sessions incl. `yama-ms8sr8bb`,
`yama-msb1k5oz`, `yama-ms76n3i8`, `yama-ms7hn9n5`, `yama-mscohod4`):

1. **Run ends before the gate.** In W2 the dominant shape: the loop burns its
   entire step budget on research (420 VCS tool calls, 45 explores, 10-minute
   explore timeouts returning `"findings": []`), then stops without calling
   `submit_review` — no posting, no model verdict; the tools-off recovery still
   emits a verdict artifact. The prompt's "gate per file" rule is not followed
   (observed: ≤2 submits/run, always at the end) and nothing in the harness
   reserves steps for gate→post→verdict.
2. **Gate skipped by completed runs.** Verdicts as strong as CHANGES_REQUESTED
   with `gate.invoked=false`; parser falls back silently
   (`ReviewResultParser.ts:79-82`), nothing warns, Action output
   `total-comments` fabricates the count from gate-accepted findings
   (`ReviewResultParser.ts:166-168`).
3. **Cross-run state broken on the Bitbucket fleet.** The gate re-accepts
   findings already posted in earlier runs; the finalization model correctly
   refuses to duplicate → "accepted 1, posted 0" (verified on a fleet PR: the
   finding's comment existed from a prior run, and in `yama-msb1k5oz` the
   finalization cites the pre-existing comment id). Same root cause also
   produced _duplicate_ comments (same fleet PR carries one MINOR twice). Unposted
   findings are then persisted as reported and auto-suppressed after 3 runs
   (`YamaOrchestrator.ts:1258-1273` + `submitReviewGate.ts:45-51`) — failures
   become permanent and self-silencing.
4. **Critic refutations (working as designed, but invisible).** e.g. the
   "CRITICAL deleteShopIntegration" finding was refuted as self-contradicting —
   correctly. Reports show _submitted_ findings, so refusals read as losses.

Ruled out: the finalization turn is NOT structurally unable to post — it posts
missing comments in healthy sessions (verified in 3 sessions). Its defects are
softer: success is checked by verdict-shape only (`YamaOrchestrator.ts:906`),
the prompt passes only the accepted _count_ (`:873-880`), no retry, and the
fallback turn disables tools (`:983`).

### 2.3 Explore/provider load

Per-session concurrency is ~2, but: up to **45 explores/run × 2 generate()
loops each**, research pass has **no maxSteps** (NeuroLink default 200), no
stall/tool guards (`ContextExplorerService.ts:115-140`); whole-review retry ×3
fires on 429/timeout (`YamaOrchestrator.ts:1012-1076`) re-running the entire
fan-out during incidents; ~11 MCP register/discover cycles per session
(`initialize()` TOCTOU, `ContextExplorerService.ts:59-68`) spawning stdio
servers; three NeuroLink instances (main/explorer/critic) share no budget; and
a correctness race: concurrent explores overwrite the shared instance's tool
context (`ContextExplorerService.ts:111`). Reviews run 17–94 minutes; at least
one PR merged before its review finished. claude-sonnet-5 peaked at 3.67B
input tokens/day (~$597 peak day).

---

## 3. Finalized fix plan

### WS-A — Deterministic posting: summary, status, findings (P0 — the critical fix)

The lesson of 2.1/2.2: anything that MUST appear on the PR cannot depend on
the model choosing to call a tool. Post it from code.

- **A1. Code-posted review summary comment.** After `deriveDecision`, compose
  the summary from the derived decision + gate snapshot + actually-posted
  comments + `verdict.summary` (which already carries the custom-instruction
  "Impact" content), and post it via `NeuroLink.executeTool()`
  (`neurolink.d.ts:1486`) — restoring what `53b4a55` removed, but code-driven.
  Per CLAUDE.md rule 7, tool names come from config: add
  `mcpServers.servers.<id>.postingTools: { addComment, setReviewStatus, approve }`.
  **Live-mode reviews require this mapping**: `ConfigLoader.validateConfig`
  fails loudly with a copy-paste migration hint (plus a `MIGRATION.md` entry)
  when it is missing or names tools the server does not expose — never a
  silent self-disable that would reintroduce the summary gap. Dry-run and
  local mode may omit it.
  Idempotency via a `<!-- yama:summary -->` marker, with trust rules: only
  comments authored by the configured bot identity (the credential Yama posts
  with) count as marker matches — a marker pasted by another user is ignored,
  so Yama never edits or replaces someone else's comment. If several
  bot-authored marker comments exist (races from older runs), update the
  newest and leave the rest untouched; concurrent runs converge because each
  run rescans before writing (last-writer-wins on one designated comment).
  The posting outcome feeds back into the result: the composed summary,
  a `summaryPosted` flag, and the actual posted-comment counts are written
  into `ReviewResult` _before_ the CLI emits Action outputs
  (`writeGitHubOutputs` in `src/cli/cli.ts`), so `summary`/`total-comments`
  reflect what really landed on the PR.
  Dry-run guarded (rule 11). Ship for Bitbucket + GitHub. The `action.yml`
  blocked-verdict fallback comment stays temporarily as GitHub-only
  redundancy and is removed once A1 has been verified in production (E3
  summary-posted alert green for one full release); A1 is the canonical
  mechanism for every VCS from day one.
- **A2. Code-set review status.** Same mechanism: after the verdict,
  `set_review_status`/approve per config mapping, live mode only (same
  loud-validation requirement as A1). Today only 31% of runs record a status.
- **A3. Forced gate remediation.** If the main loop returns a verdict with
  issues (or non-APPROVED) while `gate.invoked === false`, run ONE bounded
  remediation turn ("submit these findings via submit_review; post accepted;
  return verdict"). If it still skips, mark the run report `gate-skipped`,
  treat the verdict as partial (never APPROVED), and say so in the A1 summary.
- **A4. Step-budget reserve / wrap-up nudge.** Reserve the tail of
  `loop.maxSteps` for gate→post→verdict: when steps-used crosses
  `maxSteps − reserve` (default reserve ~15), inject a wrap-up instruction
  (NeuroLink per-step loop-guard hook; if unavailable, A3 is the backstop).
  This kills the W2-dominant failure (research eats the whole run).
- **A5. Finalization hardening** (`ensureVerdictAndPosting`,
  `YamaOrchestrator.ts:852-942`): include accepted findings (id/title/file/
  line) in the prompt, not just the count; verify success by scanning
  `finalization.toolCalls` for the config-declared posting tool (or an explicit
  already-posted attestation with a comment id). Retries are **idempotent per
  finding**: successful posts are tracked per finding id (comment id from the
  tool result, plus a `<!-- yama:finding:<id> -->` marker rescan before each
  retry), and the single retry prompt lists only the findings still missing —
  never "post all N again" after a partial success. Record
  `outcome: "post-missing"` for whatever remains and surface it in the A1
  summary + CLI output. Fix the `maxSteps` clamp (`Math.min` discards the
  20-step floor when `loop.maxSteps < 20`).

### WS-B — Explore & provider load (P0/P1)

- **B1. Semaphore + budget** (`ContextExplorerService.ts`): a semaphore
  **scoped per review run** (per explorer instance) serializes that review's
  explores — this is what fixes the `setToolContext` race and the
  `initialize()` TOCTOU without cross-serializing unrelated reviews for SDK
  embedders that run several reviews in one process. A separate,
  process-wide cap (`ai.explore.concurrency`, default **2**) bounds total
  concurrent explore traffic to the provider; the per-review semaphore
  default is 1. `ai.explore.maxCallsPerRun` default ~8 (observed 45) — over
  budget, the tool returns a structured "budget exhausted — proceed with
  available evidence" result, never an error.
- **B2. Loop guards on the research pass**: `maxSteps` (~20), stall/tool
  timeouts, and drop the per-explore timeout back to ≤5m (fleet configs run
  10m; a timed-out explore returns empty findings after blocking the run for
  10 minutes). On top of the per-call timeout, an **aggregate exploration
  deadline per review** (`ai.explore.maxTotalTime`, default ~15m): before
  each explore, compute remaining budget, pass it as that call's timeout, and
  stop launching new explores when it is exhausted — 8 calls × 5m can no
  longer stack to 40 minutes. Both timeout paths return structured partial
  results immediately.
- **B3. Retry hygiene** (`YamaOrchestrator.ts:1012-1076`): 429/overloaded must
  NOT re-run the whole review turn; bounded jittered backoff inside the
  explorer (honoring Retry-After) behind the semaphore; whole-turn retry only
  for connection-level failures. Wrap `startReviewAndEnhance`'s main generate
  in `generateWithRetry` for those (today only `startReview` has it —
  `:307` vs `:548`).
- **B4. In-flight dedup**: promise-map keyed by the full review identity —
  workspace/repository/PR/head commit + mode + provider/model + normalized
  task — never by task text alone, so two reviews of different PRs (or the
  same PR at different commits) can't share stale evidence. Entries are
  evicted on rejection as well as resolution, so a failed explore doesn't
  poison later identical requests (cache today is write-after-complete
  only).
- **B5. MCP registration reuse**: initialization memoized by
  `(mode, hash(effective merged server config))` — re-registration happens
  only when the mode or effective config actually changes, and a rejected
  init clears its cached promise so the next attempt can recover. Never
  re-register per explore call (kills the ~11×/session stdio churn / 7,115
  `guest` traces).
- **B6. Bootstrap standards**: persist per-repo standards across runs (state
  dir / `.yama/`), tight `maxSteps` (one bootstrap burned 14 consecutive
  `get_pull_request` steps).
- **B7. Review-scoped shared budget**: main loop, explorer, and critic run on
  three NeuroLink instances with no common ceiling today. Introduce one
  budget object per review (max provider requests, max total tokens, and the
  run deadline from D3) shared by all three instances and consulted inside
  every retry path (`generateWithRetry`, explorer backoff) — no agent can
  spend what another already consumed, and retries can't exceed the run's
  remaining budget.

### WS-C — Dedup & state truthfulness (P1)

- **C1. PR-anchored finding markers**: embed `<!-- yama:finding:<id> -->` in
  every posted comment; at run start scan PR comments for markers and merge
  into `previousOpenIds`. Same trust rule as A1: only markers in comments
  authored by the configured bot identity are honored — a marker echoed by
  another user (e.g. quoted in a reply) never suppresses or claims a finding.
  Cross-run dedup then works with **no state store** — fixes both duplicate
  posts and the re-accept/refuse-to-post loop. State backends become an
  optimization.
- **C2. Persist only posted findings** (`YamaOrchestrator.ts:1258-1273`):
  findings without a posted comment (or marker match) must not become
  `open`/reported — today one posting failure is auto-suppressed into
  permanent silence after 3 runs.
- **C3. Truthful metrics** (`ReviewResultParser.ts:166-168`): a tool _call_
  is not a comment — derive `commentsCreated` / `commentsUpdated` /
  `commentsFailed` / `commentsAttempted` from the posting tools' **results**
  (success payloads), and report `totalComments` as successful
  creations+updates only; keep the gate-accepted count as a separate field
  (fixes the Action's `total-comments` output, which today is fabricated
  from the gate count).
- **C4. Attestation contract**: on re-review, the agent must still gate
  every candidate; already-posted findings are submitted with an
  `alreadyReported` reference so the gate — not the model's memory — decides.

### WS-D — Prompt & config sync (P1)

- **D1. Langfuse prompt sync discipline**: repo `ReviewSystemPrompt.ts` is the
  source of truth; add a CI check (or release step) diffing it against the
  `yama-review` `production` label so prompt v4 ships with the code that
  expects it (v3 went live Jul 28 while parts of the fleet ran older code).
- **D2. Prompt additions**: anti-parallel explore rule in the PR prompt (only
  the local prompt has one); explicit per-file `submit_review` cadence with a
  hard rule ("submit before opening the next file"); wrap-up rule matching A4.
- **D3. Config cleanups + explicit run deadline**: remove
  `performance.maxReviewDuration: "15m"` from `yama.config.yaml` / example
  (re-arms the mid-loop wall clock the code warns about,
  `DefaultConfig.ts:217-222`) — but do NOT leave runs unbounded: replace it
  with an explicit, opt-in `performance.deadline` (run-level, **no default**)
  whose expiry triggers graceful cancellation — the A4 wrap-up nudge, then
  finalization of a _partial_ verdict — instead of a mid-loop kill. It covers
  the whole run (main loop, explores, critic, retries) via the shared B7
  budget; per-turn `performance.loop.turnTimeoutMs` and step caps stay as-is.
  Also: wire or delete the dead `review.toolPreferences.parallelToolCalls`
  knob; fix repo-level workflow-instructions that reference a "final summary
  comment" to reference the A1 deterministic summary.
- **D4. Redis conversation memory**: 111/111 init failures in CI — fix
  `REDIS_URL` reachability or disable in CI config; today it is startup
  latency + noise on every run.

### WS-E — Observability & validation (P1, cheap)

- **E1.** Stamp `sessionId`/`yamaVersion` on MCP-registration traces and all
  custom-tool spans (7,115 anonymous `guest` traces today).
- **E2.** Run report + Langfuse metadata: accepted vs **posted** counts,
  `gate.invoked`, finalization outcome, summary-posted flag, review-status
  flag, explore calls/budget, 429 count, steps used vs reserve.
- **E3.** Alerts: summary-posted < 95% of live completed runs; gate-skip > 5%;
  any session with `accepted_count > 0 AND posted_count = 0 AND
attestation_count = 0`; 429 rate > 2%; explore calls/run p95 > budget.

### Rollout order

1. **P0 (one release):** A1, A2, A3, B1, B2, B3 — these alone fix the summary
   regression, the review-status gap, most gate-skips, and the load pattern.
   A1/A2 ship with the loud `postingTools` config validation and its
   `MIGRATION.md` entry, so existing deployments fail fast with a
   copy-paste fix rather than silently reviewing without summaries.
2. **P1:** A4, A5, B7, C1–C4, D1–D3, E1–E3.
3. **P2:** B4–B6, D4.

### Acceptance criteria (re-run this analysis over a 4-day window)

- 100% of live completed reviews have exactly one up-to-date Yama summary
  comment and a recorded review status (was 0% / 31%).
- Gate-skip rate < 5% (was 36–39%); zero unwarned `gate.invoked=false`
  verdicts.
- Zero sessions with accepted findings, zero posted comments, and no
  already-posted attestation; zero duplicate finding comments on re-runs.
- Explore calls/run p95 ≤ budget; review wall-clock p95 < 15 min (was up to
  94); MCP `guest` registrations ≈ 1–2/session (was ~11).
- 429 rate stays < 2% under full fleet load (structural fix, not just the
  provider recovering).
