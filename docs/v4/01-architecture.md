# Yama v4 — Architecture

Status: **design, finalized for implementation**. Supersedes everything in `REFACTOR_PLAN.md`
and `docs/trace-analysis-fix-plan-2026-07-31.md`.

## Ground rules

1. **Existing v3 code is not authoritative.** It is a source of _requirements_ and _known
   failure modes_, not a design to preserve. Nothing here is written to match what exists.
   Where v3 is cited it is cited as evidence of a problem, never as a pattern to follow.
2. **No prompt assembly, anywhere.** Yama never concatenates config, rules, standards, or
   docs into a prompt string. The system instruction is one static constant. Everything
   else the agent fetches through tools.
3. **The agent controls the flow.** Yama supplies tools, guardrails, and stage verification.
   It does not script the agent's moves.
4. **Every optional config is optional.** Two files are required. Everything else absent
   means the corresponding capability is off, never broken.
5. **Anything that must land on the PR is verified by code.** LLM instruction-following is
   probabilistic; stage exit predicates are not.

---

## 1 · Principles

### 1.1 Rules reach the agent in four layers

Empirical basis: developer-written context files yield ~+4% task success for ~+19%
inference cost, and LLM-generated `AGENTS.md` files _reduced_ success in 5 of 8 settings
while adding 2.5–3.9 steps per task ([arXiv 2602.11988]). Verbose loses to minimal.
The operative rule is **write only what the agent cannot infer**.

| Layer               | Contents                                                                           | Mechanism                                                         |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1 · always-on, thin | non-inferrable only: no-go zones, architectural boundaries, always/ask-first/never | static system constant, ~1.5 KB, byte-identical every run         |
| 2 · just-in-time    | subsystem conventions, path-scoped rules                                           | `recall(paths, query)` tool, index-first                          |
| 3 · re-injection    | binding rules for _this_ turn's files                                              | supervisor guidance at turn boundaries and after every compaction |
| 4 · deterministic   | anything mechanically checkable                                                    | submit gate, checks stage, ownership check                        |

Layer 3 exists because in long sessions the system prompt is pushed out of view and models
drift. Layer 4 exists because prose alone is eventually violated.

Rule authoring format follows the same evidence: imperative voice, one code example per
convention, no style rules a linter already enforces (those move to `checks.yaml`).

### 1.2 Expensive work happens on merge, never during review

| Work                                      | Where it runs                 |
| ----------------------------------------- | ----------------------------- |
| Mining PR history for conventions         | `yama bootstrap`, once        |
| Deriving conventions from review feedback | `yama learn`, on merge        |
| Building the product capability map       | `bootstrap`, refined on merge |
| Impact history for a code area            | free lookup at review time    |

The review path is retrieval plus judgement. The reviewer improves with every merge without
any review becoming slower.

### 1.3 Every model slot is a fallback chain

Config surface — arrays everywhere, positional pairing, repeats allowed:

```yaml
ai:
  provider: [vertex, vertex, litellm]
  model: [claude-sonnet-4-6, gemini-2.5-pro, glm-4.6]
  pool: { strategy: priority, cooldownMs: 60000, maxAttempts: 3 }

  # or the explicit form when region/weight matter
  fallback:
    - { provider: vertex, model: claude-sonnet-4-6 }
    - { provider: litellm, model: glm-4.6, region: asia-south1, weight: 2 }
```

Normalization rules (`config/ModelChain.ts`):

| Input                          | Result                                                |
| ------------------------------ | ----------------------------------------------------- |
| scalar provider + scalar model | one member — v3 configs unchanged                     |
| arrays of equal length         | positional zip                                        |
| array provider + scalar model  | model broadcast across providers                      |
| scalar provider + array model  | provider broadcast — same provider, different models  |
| arrays of unequal length       | **loud config error** naming both lengths and the fix |

The same block is accepted for every role, each inheriting `ai.*` when absent:
`ai.review` · `ai.subAgent` · `ai.judge` · `ai.scorecard` · `ai.description` ·
`ai.extraction` · `ai.compaction` · `ai.memory`.

**How each slot is wired — verified against NeuroLink 11.2.3:**

| Slot                                                                  | NeuroLink surface                                                 | Fallback                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| main generate (reviewer, sub-agents, judges, description, extraction) | instance `modelPool`                                              | **native** — error-class aware, per-member cooldown |
| per-call narrowing                                                    | `modelChain` / `providerFallback`                                 | native, per call                                    |
| summarization + compaction                                            | `conversationMemory.summarizationProvider` / `summarizationModel` | **single value, no native fallback**                |
| memory condensation                                                   | `conversationMemory.memory.neurolink.{provider,model}`            | **single value, no native fallback**                |
| file summarization                                                    | `conversationMemory.fileSummarization.{provider,model}`           | **single value, no native fallback**                |

`contextCompaction` has no model field of its own; it uses the summarization pair.

For the three slots without native fallback, Yama health-probes the chain at startup and
passes the first reachable member. That gives failover at run start, not mid-run. This is a
stated limitation, not a silent one — `yama doctor` prints which slots are pooled and which
are probe-only, and an upstream request is filed to accept a pool for these slots.

Each agent gets its own NeuroLink instance, so each can carry its own pool.
`createWorkerInstance({ config: { modelPool } })` is documented to accept it.

### 1.4 Three tiers of memory

| Tier     | Scope                       | Lives in                                            | Written by             |
| -------- | --------------------------- | --------------------------------------------------- | ---------------------- |
| **turn** | one session                 | conversation memory, compacted                      | the runtime            |
| **PR**   | one pull request while open | `.yama/artifacts/pr-<n>/`, carried by CI artifact   | every review run       |
| **repo** | permanent                   | `.yama/knowledge/`, `.yama/product/`, git-committed | `yama learn`, on merge |

The **PR tier** is what makes a second run cheap and a fifth run smart. It accumulates the
understanding built during a PR's life so later runs never re-derive it:

```
.yama/artifacts/pr-<n>/
  context.md        accumulated understanding of THIS PR — append-only, compacted on growth
  findings.json     full ledger: accepted, rejected, reasons, posted comment ids
  impact.json       the impact report, refined per run
  runs/<sha>.json   per-run report and scorecard
```

Carried between runs by the CI's own artifact mechanism (`actions/upload-artifact` named
`yama-pr-<n>`, Jenkins `archiveArtifacts`, Bitbucket `artifacts:`). Read at preflight, exposed
to the agent as `recall(scope: "pr")`. Absent artifact is not an error — PR-comment markers
still carry dedup, and the run rebuilds what it needs.

On merge the PR artifact becomes an **input to `yama learn`** and is then discarded. Nothing
PR-scoped leaks into repo knowledge except what learn deliberately promotes.

### 1.5 Budgets

No token budget. No wall-clock budget. The main agent is the controller. The only throttle
is a concurrency tier in config. Hang protection (`stallTimeoutMs`, `toolTimeoutMs`, waste
signals) remains, because those catch wedged tools rather than slow thinking. An optional
hard `deadline` exists for teams whose CI demands one; there is no default.

---

## 2 · Component map

```
src/
  cli/                      review · enhance · learn · bootstrap · init · migrate · doctor
  core/
    RunContext.ts           run identity, abort signal, concurrency pool, optional deadline
    SessionRunner.ts        opens the session, drives turns, applies supervisor guidance
    Supervisor.ts           between-turn inspection, guidance, rule re-injection
    StageMachine.ts         exit predicates + bounded remediation (NOT a sequencer)
    ReviewPipeline.ts       S0–S6 definitions; S2 holds the supervised turn loop
    ReviewContract          the review-stage exit predicate
  agents/
    systemInstruction.ts    THE static constant. No interpolation. No config.
    mainReviewer.ts         agent definition (tools, schema, model)
    subAgents.ts            delegated specialist definitions
  tools/
    recall.ts               the single context door — rules, knowledge, memory, product
    policyCheck.ts          ownership + guards for given paths
    checkResults.ts         check output as evidence
    submitFinding.ts        the gate
    posting.ts              capability-mapped comment/summary/status
    gitSafe.ts              read-only git allowlist
  connections/
    Registry.ts             MCP servers from config, memoized by (mode, config hash)
    Capabilities.ts         capability -> tool name, probed at startup
  checks/
    Runner.ts               command execution, content-hash cache, output externalization
    parsers/                sarif · eslint · tsc · junit · regex · agent
    builtin/owners.ts       ownership check (deterministic)
  findings/
    Gate.ts                 dedup, invariants, fix-required enforcement
    Markers.ts              PR-comment marker scan + write
    Ledger.ts               what was accepted, what was actually posted (from tool results)
  judge/
    inline.ts               0-100 confidence per finding
    scorecard.ts            offline review-quality scoring
  learn/
    MergeResolver.ts        which PR did this commit merge?
    Triage.ts               classify human + Yama comments
    KnowledgeWriter.ts      knowledge + suppression + product ledger updates
    GitWriter.ts            ephemeral credentials, scoped add, rebase-retry push
  config/
    Loader.ts               layered load, v3 compatibility, optionality defaults
    schema/                 zod schemas per config file
  product/
    Capabilities.ts         capability map read/refine
    ImpactLog.ts            per-merge ledger
```

---

## 3 · Config surface

```
.yama/
  yama.yaml          REQUIRED   models, providers, modelPool, learn settings
  mcp.yaml           REQUIRED   connections + capability map + stage exposure
  review.yaml        optional   concurrency, verdict, stages, remediation
  checks.yaml        optional   commands + builtin checks
  policy/
    ownership.yaml   optional   path -> owners, minApprovals
    guards.yaml      optional   path -> severity floors, required checks, forbids
  rules/*.yaml       optional   path-scoped, imperative, one example each
  knowledge/         generated  conventions/ · suppressions/
  product/           generated  capabilities.yaml · impact-log/
  profile.md         generated  repo fingerprint
```

Loader precedence: `defaults < .yama/*.yaml < extends: < env < SDK overrides`.
`extends: "github:org/yama-config@v2"` pulls an org baseline.

### Degradation matrix

| Absent                  | Behaviour                                                           |
| ----------------------- | ------------------------------------------------------------------- |
| `review.yaml`           | concurrency `medium`, verdict on, enhance/checks on if configured   |
| `checks.yaml`           | checks stage skipped entirely                                       |
| `policy/ownership.yaml` | ownership check is a no-op                                          |
| `policy/guards.yaml`    | no severity floors, no forbids                                      |
| `rules/`                | conventions come from `AGENTS.md`/`CLAUDE.md` if present, else none |
| `knowledge/`            | agent reviews cold; still learns on merge                           |
| `product/`              | impact analysis degrades to caller-tracing                          |
| code-intel MCP          | ripgrep symbol search, then plain text                              |
| state store             | dedup via PR comment markers alone                                  |
| Redis                   | session does not span runs; markers + state carry continuity        |
| `learn.git` credentials | learn disabled and said out loud, never silently skipped            |

### v3 compatibility

The loader accepts a single-file `yama.config.yaml` / `.yama/config.yaml` indefinitely,
emitting one notice per run pointing at `yama migrate`. Dead v3 keys
(`performance.tokenBudget`, `costControls`, `review.toolPreferences.*`) are accepted and
ignored with a warning listing them.

---

## 4 · Connections and capabilities

Code never names a tool. It asks for a capability; config supplies the name.

```yaml
# .yama/mcp.yaml
servers:
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers: { Authorization: "Bearer ${YAMA_GITHUB_TOKEN}" }
    capabilities:
      # A bare string is the tool name. The object form pins arguments the tool
      # needs on every call: servers consolidate many operations behind one tool
      # selected by a parameter, and that parameter is part of the MAPPING.
      readPullRequest: { tool: pull_request_read, args: { method: get } }
      listComments:
        { tool: pull_request_read, args: { method: get_review_comments } }
      listApprovals: { tool: pull_request_read, args: { method: get_reviews } }
      listChangedFiles: { tool: pull_request_read, args: { method: get_files } }
      findPullRequest: list_pull_requests
      # Inline comments attach to an open review, so it is opened before they are
      # written and submitted after. Map both or neither: half the pair writes
      # comments on a review nobody submits, invisible to everyone.
      beginReview: { tool: pull_request_review_write, args: { method: create } }
      postInlineComment: add_comment_to_pending_review
      submitReview:
        {
          tool: pull_request_review_write,
          args: { method: submit_pending, event: COMMENT },
        }
      postSummary: add_issue_comment
    stages: [resolve, orient, post, checks, enhance, verdict]
    roles: [main]
  serena:
    transport: stdio
    command: uvx
    args:
      [
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
      ]
    capabilities: { codeIntel: find_referencing_symbols }
    roles: [main, sub]
  jira:
    transport: stdio
    command: uvx
    args: ["mcp-atlassian"]
    capabilities: { readTicket: jira_get_issue }
    roles: [main, sub]
```

- **Startup probe**: every declared capability's tool must exist on the connected server.
  Missing in live mode → hard failure with the discovered tool list printed. Resolution is
  against DISCOVERED tools, never against what config claims — this is what turns "the
  review posted nothing and we do not know why" into "fix this line of yaml".
- **Paired capabilities** (`beginReview`/`submitReview`) are checked together at setup:
  mapping one without the other is a silent, total failure and `doctor` refuses it.
- **Stage scoping**: posting capabilities are only exposed during the posting stages.
  Review turns cannot post; posting turns cannot review.
- **Registration memoized** by `(mode, hash(effective config))`. One registration per run.
- **Unknown servers are first-class.** Any MCP server the team connects is available to the
  agent; which ones it uses is the agent's judgement.

### Local tool policy

| Tool                      | Availability                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `read_file`, `list_files` | on, sandboxed to repo root (realpath, so a symlink cannot escape)         |
| `search_code`             | on, sandboxed; ripgrep then `git grep`, argv arrays and never a shell     |
| git via bash allowlist    | `log show diff blame rev-parse ls-files describe merge-base`              |
| git mutation              | denied, fail-closed: anything not on the allowlist is treated as mutating |
| general bash              | off by default; opt-in per repo, allowlisted commands only                |
| write tools               | never registered on the review instance                                   |

The diff is attacker-controlled. This is not tunable downward by a PR.

---

## 5 · The static system instruction

One exported constant, ~1.5 KB, no interpolation. Contains only:

- role and method
- severity ladder and the marker convention
- the finding contract: every CRITICAL/MAJOR carries a concrete fix and an impact statement
- the gate rule: nothing is posted that the gate did not accept
- the false-positive taxonomy (pre-existing issues, linter-catchable, unmodified lines,
  pedantic nits, intentional changes)
- the output contract

Everything project-specific reaches the agent through `recall`, `policy_check`,
`check_results`, and supervisor guidance. Because the bytes are identical on every run,
provider prompt caching applies.

---

## 6 · Flow A — Onboarding

### `yama init` (new project)

```
1 DETECT     remote -> provider · stack · package scripts · CI system · CODEOWNERS
2 CONNECT    [BLOCKING] VCS choice · token env var name · AI provider + credential env vars
             writes .env.example and prints exact CI secret names
3 DOCTOR     [BLOCKING] connect servers · probe every capability · read a real PR
             · dry-run post to a scratch PR.  Any failure stops with the precise fix.
4 MERGE-MODE detect merge strategy (section 9.1) and wire `learn` accordingly
5 CHECKS     offer detected commands; writes them DISABLED and commented out
6 OFFER      `yama bootstrap` — reachable only once 2 and 3 are green
```

Writes `.yama/yama.yaml` and `.yama/mcp.yaml`. Nothing else is required.

### `yama migrate` (existing project)

```
ai.*, performance.*          -> yama.yaml
mcpServers.servers.*         -> mcp.yaml + inferred capability map (+ TODO for unknowns)
review.focusAreas            -> knowledge/focus/*.md
review.workflowInstructions  -> knowledge/workflow.md
review.blockingCriteria      -> policy/guards.yaml
review.excludePatterns       -> review.yaml   (now enforced in code, not prompt text)
projectStandards.*           -> rules/*.yaml
.github/CODEOWNERS           -> policy/ownership.yaml (offered; exclusive: true preserved)
DROPPED, reported explicitly: tokenBudget · costControls · toolPreferences.*
```

Prints a table of what moved where. The old file keeps working until deleted.

---

## 7 · Flow B — Review, fresh run

### Trigger

```
yama review --pr 142
yama review --branch feature/x     # agent resolves the PR from the branch
yama review                        # infers from CI environment
```

### Stage machine

Every stage has an exit predicate. Failing it re-prompts the agent **in the same session**,
naming exactly what is missing. Bounded at `remediation.maxAttemptsPerStage` (default 2),
after which the stage is recorded `degraded` and the summary says so.

```
S0 RESOLVE   agent finds the PR (branch or number), reads metadata
             EXIT  prId + headSha + baseSha + changed-file count known
             FAIL  re-ask naming the ambiguity; never guess between candidates

S1 ORIENT    recall(profile) · policy_check(paths) · git diff · build plan
             checks kick off in background here (code, parallel)
             EXIT  plan schema-valid AND every changed file belongs to a group
             FAIL  "these N files are in no group: ..."

S2 REVIEW    agent works its plan; fans out to sub-agents at its discretion
             EXIT  every planned group has a turn ending in findings-or-explicit-clean
                   AND the gate was called at least once per group
             FAIL  "group 3 produced no gate submission"

S3 POST      inline comments + summary comment
             EXIT  every gate-accepted finding has a comment id FROM THE TOOL RESULT
                   AND the summary exists under its marker
             FAIL  lists the specific unposted finding ids, never a count

S4 CHECKS    configured commands + builtin checks; output fed back to the agent
             EXIT  every enabled check ran or is recorded skipped-with-reason
                   AND every check finding is posted or explicitly rolled up
             FAIL  names the specific check

S5 ENHANCE   description: impact · blast radius · test cases · configured sections
             EXIT  description updated AND contains every `required: true` section
             FAIL  "missing section: Testing Strategy"

S6 VERDICT   approve / block, or skipped when verdict.enabled is false
             EXIT  status recorded via capability, or explicitly disabled
```

### Turn structure inside S2

The review stage is a supervised loop, not a single call. It ends when the agent says
it is finished, when the exit predicate is met, or when waste signals show it has
stopped working. **There is no turn count and no step budget** — those would make the
harness the controller, and the agent is.

```
TURN k     agent: read files -> recall(rules for these paths) -> check_results(files)
                  -> delegate specialists as it judges -> submit findings -> post accepted

SUPERVISOR between turns (code, no LLM unless configured):
  · coverage      which planned groups remain untouched
  · gate hygiene  findings claimed in prose but never submitted
  · waste         duplicate calls, empty-result streaks, error streaks
  · drift         re-inject binding rules for the next group's paths
  · compaction    if the window compacted, re-state invariants
  -> emits one guidance turn, in-session, or lets the agent continue
```

The supervisor reads the session with `getConversationHistory(sessionId)`. This is what
makes "is it on the right path" an observation rather than an assumption.

### Sub-agents

The agent decides whether and how to fan out. Each sub-agent:

- runs as an isolated agent with its **own session id**
- receives its slice plus re-injected rules for that slice
- has read-only tools; never posting capabilities
- returns **structured findings**, validated against a schema
- is subject to the inline judge on its findings

The main agent collates, resolves cross-agent duplicates (agreement raises confidence), and
owns every posting decision.

```yaml
# .yama/review.yaml
concurrency: { power: medium } # high | medium | low
```

| Power  | Pool | Delegations/turn |
| ------ | ---- | ---------------- |
| high   | 8    | 6                |
| medium | 4    | 3                |
| low    | 1    | 1                |

### The finding contract

Enforced at the gate, not requested in prose. A CRITICAL or MAJOR finding without a concrete
fix is **rejected** with "add a fix".

```
🔒 CRITICAL: <what>

Why it matters: <impact — what breaks, for whom>
Fix:
  <diff or code block>
Rule: [KB:conv.input-validation]     (when a rule drove the finding)
```

### Gate invariants (deterministic, pre-judge)

1. cited file exists in the change set
2. cited line falls inside a changed hunk (configurable per rule)
3. not a duplicate of an existing `<!-- yama:finding:id -->` marker on the PR
4. not in the learned suppression set
5. not already reported by a check
6. CRITICAL/MAJOR carries a fix
7. severity respects any `severityFloor` from `guards.yaml`

Survivors go to the inline judge (0–100, threshold default 80). Check findings skip the
judge — a compiler error is not a probabilistic claim.

---

## 8 · Flow C — Review, subsequent run

Differences from a fresh run:

```
PREFLIGHT   marker scan: read PR comments -> bot-authored <!-- yama:finding:id -->
                         -> previouslyReported set. Works with NO state store.
            state load:  lastReviewedSha, open findings, suppressions
            incremental: git diff <lastReviewedSha>..<headSha> is the new work;
                         full PR diff remains available for context

SESSION     same session key. Conversation continues only if Redis is configured;
            otherwise continuity is carried by markers + state, which is sufficient.

S1 ORIENT   additionally: classify every open prior finding as
            fixed | still-open | moot (code deleted)
            EXIT  every open finding classified

S2 REVIEW   scoped to files changed since lastReviewedSha, plus their dependents
            gate auto-rejects previouslyReported ids
            resolved findings -> resolve the thread, do not post a new comment

S6 VERDICT  computed over the FULL open set — new plus carried — not just the delta
```

Three v3 failure modes this closes, all observed in production traces:

| Was                                                                                                           | Now                                                                        |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Gate re-accepted already-posted findings; agent correctly refused to duplicate; result "accepted 1, posted 0" | markers on the PR are the dedup source of truth                            |
| Unposted findings persisted as reported, then auto-suppressed after 3 runs into permanent silence             | only findings with a confirmed posted comment id are persisted as reported |
| Duplicate comments when state was lost                                                                        | markers survive state loss; state is an optimization                       |

---

## 9 · Flow D — Learn, post-merge

### 9.1 Resolving which PR merged

Detected at `init`, re-verified at each learn run.

| Strategy              | Signal                                                       | PR extraction              |
| --------------------- | ------------------------------------------------------------ | -------------------------- |
| squash                | single parent, subject ends `(#123)` / `(pull request #123)` | subject regex — reliable   |
| merge commit          | two parents, `Merge pull request #123 from ...`              | subject regex — reliable   |
| rebase / fast-forward | single parent, no marker, linear                             | **not derivable from git** |

Resolution order:

1. **Trigger-supplied** — the merge event carries the PR number. Recommended; `init` writes
   the workflow this way.
2. **API reverse-lookup** — ask the provider which PR contains this SHA.
3. **Commit trailer** — `PR: #123` from a merge template.

None available → learning is **disabled and announced**, never silently degraded:

```
⚠ Merge strategy: rebase — PR numbers are not recoverable from commit history.
  Learning requires one of: (a) run on the merge event  (b) enable PR reverse-lookup
  (c) add a `PR: #<n>` trailer.  Review is unaffected. Learning is OFF.
```

### 9.2 The learn run

```
trigger   merge event on the default branch -> `yama learn --pr <N>`

INPUTS    merged PR + diff · human comments and replies · Yama's comments and their fate
          Yama's Impact Report from the review run (already computed, read from state)
          commit messages · revert/fix detection · linked tickets and labels

1 TRIAGE          one bounded agent pass, session-scoped, judged
   human comments, each classified even at a single occurrence:
     missed-convention  -> create or promote a knowledge entry
     missed-bug         -> gap entry, optionally a suggested check
     preference         -> low weight, needs corroboration
     context-specific   -> note only, never a rule
   Yama comments:
     acted-on            -> precision credit
     dismissed-no-change -> suppression candidate
     argued-down         -> nuance entry on the existing rule

2 WEIGHTING       weight = f(occurrences, distinct authors, severity prevented,
                             whether code changed after the comment)
   Coding conventions promote to active at 1–2 occurrences, author-independent.
   Preferences require corroboration. Weight is stored and ranks rules at recall time,
   so frequency drives importance rather than eligibility.

3 PRODUCT IMPACT  persist the review's Impact Report as an impact-log entry, corrected
                  against what actually merged; link reverts/fixes back to the PR that
                  introduced the behaviour; refine capabilities.yaml where boundaries moved

4 PROFILE DRIFT   dependency manifest hash changed, or a new top-level module appeared
                  -> refresh profile.md

5 METRICS         precision and recall per lens and per rule -> scorecard history

6 WRITE           git add .yama/** only; commit; push (section 9.3)
                  chore(yama): learn from #<N> [skip ci]
```

Everything written is a reviewable diff. A bad learning is one `git revert` away.

### 9.3 Git write access

Only the learn command ever holds write credentials. The review run never does.

```yaml
# .yama/yama.yaml
learn:
  trigger: merge-event # merge-event | push | disabled
  mergeStrategy: squash # detected by init
  mode: commit # commit | pull-request
  botIdentity: yama-bot
  git:
    auth: ssh # ssh | https
    sshKeyEnv: YAMA_SSH_KEY # CI credential -> env var (PEM body)
    userEnv: YAMA_GIT_USER # https fallback
    tokenEnv: YAMA_GIT_TOKEN
    remote: "git@host:org/repo.git"
    branch: main
```

Implementation, derived from Lighthouse's `scripts/workflow.js` with its two leaks fixed:

```
KEEP  credentials as env vars expanded by the SHELL, never interpolated into JS —
      the secret value never enters process memory or logs
KEEP  [skip ci] in the commit subject
KEEP  explicit remote rather than ambient config

FIX   Lighthouse writes `git config url."https://$USER:$TOKEN@host/".insteadOf ...`,
      which expands and persists the real token into the workspace .git/config.
      We never write credentials to any config file.
FIX   Lighthouse pushes with --force. We never force-push.
FIX   Lighthouse commits whatever is staged. We stage .yama/** explicitly and abort
      if anything else is staged.
```

```
SSH    key -> 0600 temp file OUTSIDE the workspace
       GIT_SSH_COMMAND="ssh -i <tmp> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
       finally: shred + unlink

HTTPS  GIT_ASKPASS=<tmp script echoing $TOKEN>
       never in the URL, never in .git/config, never visible in `ps`

PUSH   git push <remote> HEAD:refs/heads/<branch>
       rejected (concurrent merge) -> fetch, rebase, retry; max 3 attempts
       still rejected -> fail loudly, never force
```

**Prerequisites, verified by `yama doctor --learn`:** credential loads, remote reachable,
branch writable, branch-protection permits it. If protection forbids direct push, set
`mode: pull-request` and Yama opens a bot PR instead.

**Loop prevention, belt and braces:** `[skip ci]` in the subject **and** the workflow
carries `if: actor != botIdentity` plus `paths-ignore: ['.yama/knowledge/**',
'.yama/product/**']` — because `[skip ci]` is honoured inconsistently across GH Actions,
Bitbucket Pipelines, and Jenkins.

---

## 10 · Checks

```yaml
# .yama/checks.yaml
checks:
  - id: lint
    run: "pnpm run lint --format json"
    parse: eslint
    when: { paths: ["**/*.{ts,tsx,js}"] }
    severity: { error: MAJOR, warning: MINOR }
    scope: changed-lines
    maxFindings: 25

  - id: security
    run: "trivy fs --format sarif ."
    parse: sarif

  - id: migrations
    run: "./scripts/check-migrations.sh"
    parse: agent # cheap extraction pass, schema-bound
    hint: "offending file is column 2"

  - id: owners
    type: builtin.owners
    source: .yama/policy/ownership.yaml
    blocking: false
```

Parse strategies in order of preference: **`sarif`** (universal — eslint, semgrep, ruff,
golangci-lint, clippy, detekt, bandit, trivy, CodeQL), **named parsers** (`tsc`, `eslint`,
`junit`, `regex`), **`parse: agent`** for bespoke scripts.

Large output is externalized through NeuroLink's MCP output limits and read back on demand
rather than flooding context.

Results serve two purposes: they become findings, and they become **evidence the agent can
read** (`check_results`), which is what stops the agent re-reporting what a linter already
said.

Content-hash caching on `(check id, file content hash)` skips unchanged files.

### Ownership check (deterministic, no LLM)

```
changed files (including deletions and both sides of renames)
  -> match every rule's globs; all matches apply, owners unioned
  -> drop the PR author
  -> read current approvals via listApprovals, when that capability exists
  -> one grouped comment under <!-- yama:owners -->, never per-file tags
```

| Case                                     | Behaviour                                                   |
| ---------------------------------------- | ----------------------------------------------------------- |
| no `ownership.yaml`                      | no-op, zero cost                                            |
| re-run, same paths                       | comment updated in place, nobody re-tagged                  |
| re-run, new owned paths                  | only newly-required owners tagged                           |
| deleted file matches                     | rule applies — that is exactly when the owner should see it |
| rename                                   | matches on both old and new path                            |
| multiple rules match                     | all apply, one table row each                               |
| CODEOWNERS semantics wanted              | `exclusive: true`                                           |
| `blocking: true` without `listApprovals` | `yama doctor` fails loud                                    |

### Security rule

`checks.yaml` and every script it names are resolved from the **base branch**, never the PR
head. Yama refuses to run checks if the head modified any declared script. Fork PRs have
checks off unless explicitly opted in. Running project scripts on an attacker-controlled PR
is arbitrary code execution with CI credentials; this is not configurable downward.

---

## 11 · Resilience

### Context compaction

Every session — main and every sub-agent — enables NeuroLink's context compaction with a
dedicated cheap model, so a long review never dies on window overflow.

```yaml
ai:
  compaction: # Yama surface — accepts a chain
    provider: [vertex, litellm]
    model: [gemini-2.5-flash, glm-4.6]
  conversationMemory:
    contextCompaction: { enabled: true, threshold: 0.8 }
```

`ai.compaction` compiles to `conversationMemory.summarizationProvider` /
`summarizationModel` — which `contextCompaction` uses, since it has no model field of its
own. That pair takes a single value, so the chain is resolved by startup health probe
(§1.3), not by native pooling.

Two additions on our side, because compaction is exactly when rules get forgotten:

1. the supervisor detects a compaction event and re-states the binding rules for the current
   files
2. gate contract, severity ladder, and no-go zones are re-stated in every turn's guidance, so
   they survive any eviction

### Provider failure

**Yama walks the chain itself**, in `SessionRunner`, and pins the runtime's own provider
fallback off. This was not the original plan — the plan delegated to the runtime's
`modelPool`. Live testing showed that path resolving to whichever provider happened to have
credentials in the environment, so a review would succeed on a model nobody configured while
the report said it worked. A run failing is recoverable; a run silently answering from the
wrong model is not.

The chain advances on two conditions:

- **The call throws** — a 5xx, a timeout, a rate limit, a context overflow. A failure every
  member would share (a malformed request, a credential the chain has in common) does NOT
  advance it: one clear error beats the same error repeated once per member.
- **The call returns nothing** — empty content AND no tool calls. This is not an error and
  no exception is raised, but it is not a review either. A reasoning model that spends its
  whole output budget thinking, or a gateway swallowing an upstream fault, both look exactly
  like this. Counting it as a finished turn is how a review ends having reviewed nothing
  while reporting that it ran.

Once a member answers, the run stays on it: re-trying a member that just failed costs a full
timeout on every subsequent turn.

`ai.timeout` is a per-call hang detector, not a budget. Self-hosted models answer far slower
than a hosted API without being broken, and the runtime's own default would cut them off
mid-answer and report a stall.

### Per-agent models

Main reviewer, sub-agents, inline judge, scorecard judge, compactor, and the description
pass each name their own provider and model.

---

## 12 · Evals and metrics

| Stage        | Measured                                                                                      | Lands in                     |
| ------------ | --------------------------------------------------------------------------------------------- | ---------------------------- |
| preflight    | eligibility outcome, capability probe result                                                  | run report                   |
| S1           | plan coverage %, schema validity                                                              | report + trace               |
| each turn    | steps, tokens, tool calls, waste trips, coverage delta, gate calls                            | span per turn                |
| delegations  | count, duration, status, waste signals                                                        | report                       |
| gate         | submitted / accepted / rejected with reason histogram                                         | report                       |
| inline judge | score per finding, kill rate                                                                  | report + trace               |
| checks       | duration, cache hit, findings, capped count                                                   | report                       |
| S3           | accepted vs **actually posted** (from tool results), summary posted                           | report + CI outputs          |
| S6           | verdict source, gate-anchored, status recorded                                                | report                       |
| scorecard    | coverage · noise per 100 changed lines · severity calibration · verdict soundness             | scorecard                    |
| post-merge   | **precision** (acted-on ÷ posted) and **recall** (human-found ÷ total), per lens and per rule | scorecard history, committed |

Post-merge is the only place ground truth exists, so per-rule precision is the number that
justifies retiring a noisy rule with evidence rather than opinion.

**Alert thresholds:** summary posted <95% of live runs · gate-skip >5% · any run with
accepted findings and zero posted · noise >3 comments per 100 changed lines · any rule below
40% precision over 10 occurrences.

---

## 13 · Security model

| Surface                   | Control                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PR diff content           | untrusted. Prompt injection cannot grant tools, clear findings, or change the verdict — the gate and verdict are code |
| `.yama/**` in the PR head | untrusted for anything executable. Checks config and scripts come from the base branch                                |
| project MCP config        | opt-in via a trusted operator env var set outside the checkout                                                        |
| bash                      | off by default; allowlisted read-only git when on                                                                     |
| filesystem                | sandboxed to repo root                                                                                                |
| write credentials         | only present during `learn`; never registered on the review instance                                                  |
| posting tools             | exposed only during posting stages                                                                                    |
| fork PRs                  | checks off by default; posting via the CI's own restricted token                                                      |

---

## References

- [Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?](https://arxiv.org/pdf/2602.11988)
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Instruction Adherence in Coding Agent Configuration Files](https://arxiv.org/pdf/2605.10039)
- [Harness engineering for AI coding agents](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents)
- Lighthouse `scripts/workflow.js` — Jenkins credential handling (analysed, two leaks fixed)

---

## Appendix · The learning window

A single merge event is not a reliable unit of work. Runs get cancelled, CI has
outages, a workflow is disabled for a week, three pull requests merge while one
learn job is queued. If a run only ever learns from its own trigger, every one of
those situations loses feedback permanently and silently.

Learning therefore tracks a **watermark** — the last commit it has fully learned
from — and each run processes everything merged since. Usually one pull request.
Sometimes five. Same mechanism.

### Resolving the window, per strategy

| Strategy     | Source                                                         | Needs a provider call |
| ------------ | -------------------------------------------------------------- | --------------------- |
| squash       | `(#142)` in the commit subject                                 | no                    |
| merge commit | `Merge pull request #142 …`                                    | no                    |
| trailer      | `PR: #142` in the body                                         | no                    |
| **rebase**   | provider listing of pull requests merged after `lastLearnedAt` | **yes**               |

Rebase is the only strategy where git genuinely cannot answer: a rebased commit
carries no number and no merge commit. The provider recorded the merge even
though git did not, so the window comes from a time-bounded listing. Without one,
the run falls back to its trigger and says so.

The trigger's pull request is always included regardless of strategy — the CI
event is exact, and a run triggered by a merge must never conclude there was
nothing to learn from that merge.

### Invariants

1. **The watermark advances only past pull requests that were actually learned
   from.** A failure in the middle leaves the rest in the next window. Advancing
   past a failure loses that feedback permanently.
2. **It never rewinds.** A manual re-run of an old pull request records it as
   processed but does not move the watermark backwards, which would re-learn
   everything after it and double every occurrence count.
3. **It is committed in the same commit as the knowledge it tracks.** Stored
   apart, the two can disagree: an advanced watermark whose knowledge did not
   land loses feedback; landed knowledge whose watermark did not advance is
   learned from twice.
4. **A first run takes only the most recent merge.** A repository adopting Yama
   has years of history, and conventions from three years ago are not this
   team's conventions. `yama bootstrap` is the deliberate, human-reviewed path
   for mining history.
5. **Commits with no pull request reference are reported, never guessed at.** A
   direct push to the default branch taught nobody anything.
6. **A watermark from another branch is not inherited.** Branches merge different
   work; inheriting main's position on a release branch would skip everything
   that branch merged.
