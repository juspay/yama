---
name: yama-setup
description: >
  Set up Yama pull-request review in a repository, or migrate an existing v3
  Yama config to v4. Use when someone asks to add Yama, set up AI code review,
  configure .yama/, wire the review or learn CI workflow, or when they mention
  yama.config.yaml, capability maps, or Yama ownership and check policy.
---

# Setting up Yama

Yama reviews pull requests from inside the repository's own checkout. Getting it
working is mostly a matter of proving four things in order: it can connect, it
can read a pull request, it can post, and — if the team wants it — it can write
back what it learns.

Work through the phases below **in order**. Each one has a verification step,
and skipping a verification is how setups fail thirty minutes into a real review
instead of in ten seconds at a terminal.

---

## Phase 1 · Look before configuring

```bash
npx @juspay/yama init          # detects and shows a plan; writes nothing
```

Read what it detected. Then check three things it cannot:

```bash
git remote get-url origin                                    # which VCS
git log -25 --pretty=format:"%s|%P" | head                   # merge strategy
gh secret list 2>/dev/null || echo "check your CI secrets"   # what already exists
```

**Merge strategy matters more than it looks.** Learning needs to know which pull
request a merge commit came from:

| Commit subjects look like          | Strategy     | Learning                     |
| ---------------------------------- | ------------ | ---------------------------- |
| `feat: thing (#142)`               | squash       | works on push or merge event |
| `Merge pull request #142 from …`   | merge commit | works on push or merge event |
| no number anywhere, single parents | **rebase**   | **merge event only**         |

If it is rebase, learning MUST run on the merge event. A `push` trigger would
attribute feedback to the wrong pull request, which teaches the knowledge base
things that are not true. Yama refuses rather than guessing, but wire it right
the first time.

**If `.yama/config.yaml` or `yama.config.yaml` already exists**, stop here and go
to Phase 6 instead — that is a migration, not a new setup.

---

## Phase 2 · The two required files

Everything else is optional. A repository with just these two gets a working
review; it simply gets one with no checks, no ownership, and no local rules.

### `.yama/yama.yaml`

```yaml
version: 4
ai:
  # Every model slot is a FALLBACK CHAIN, paired by position. The next entry is
  # tried when one fails.
  provider: [litellm, litellm]
  model: [strong-model, fallback-model]
  temperature: 0.1
  pool: { strategy: priority, cooldownMs: 60000 }

  # Cheap slots. These do bounded, mechanical work and gain nothing from a
  # reasoning model — put a fast one here and the run gets materially cheaper.
  judge: { provider: [litellm], model: [fast-model], temperature: 0 }
  subAgent: { provider: [litellm], model: [fast-model] }
  extraction: { provider: [litellm], model: [fast-model], temperature: 0 }
  compaction: { provider: [litellm], model: [fast-model] }
```

Chain rules: arrays pair by position; a single provider broadcasts across many
models; a single model broadcasts across many providers; mismatched lengths are
a loud error naming both counts.

**Honest limitation to pass on:** compaction and memory take a single provider
and model upstream, so their chain resolves by a startup health probe — failover
between runs, not mid-run. `yama doctor` labels each slot so this is visible.

### `.yama/mcp.yaml`

This is the file people get wrong. Code never names a tool; it asks for a
**capability**, and this maps it to whatever the server actually calls it.

```yaml
servers:
  github:
    transport: http
    url: https://api.githubcopilot.com/mcp/
    headers:
      # Use a NON-reserved env name. ${GITHUB_TOKEN} is not reliably forwarded
      # inside a composite action.
      Authorization: "Bearer ${YAMA_GITHUB_TOKEN}"
    capabilities:
      # A bare string is the tool name. The object form pins arguments the tool
      # needs on every call — servers increasingly put many operations behind
      # one tool chosen by a parameter, and that parameter is part of the map.
      readPullRequest: { tool: pull_request_read, args: { method: get } }
      listComments:
        { tool: pull_request_read, args: { method: get_review_comments } }
      listChangedFiles: { tool: pull_request_read, args: { method: get_files } }
      # Inline comments attach to an open review: opened before, submitted after.
      # Map BOTH or neither — half the pair writes comments nobody can see.
      beginReview: { tool: pull_request_review_write, args: { method: create } }
      postInlineComment: add_comment_to_pending_review
      submitReview:
        {
          tool: pull_request_review_write,
          args: { method: submit_pending, event: COMMENT },
        }
      postSummary: add_issue_comment
    # Posting is exposed ONLY in the stages that post. A review turn reads an
    # attacker-controlled diff; it must not be able to write.
    stages: [resolve, orient, post, checks, enhance, verdict]
    roles: [main]
    blockedTools:
      [push_files, create_or_update_file, delete_file, merge_pull_request]
```

Do not guess tool names, and do not copy the block above without checking it —
these names drift. Run `yama doctor --live --pr <n>`: it connects, and when a name
is wrong it prints what the server really advertises, so the fix is a copy-paste.

See `references/capabilities.md` for the full capability list and what each one
is used for.

### Verify

```bash
npx @juspay/yama doctor          # dry-run requirements
npx @juspay/yama doctor --live   # everything a live run needs
```

Do not continue until this is green. Every expensive failure mode in Yama's
history was a _late_ failure — a run that reviewed for twenty minutes and then
found it could not post. `doctor` moves all of them here.

---

## Phase 3 · First review, in dry run

```bash
npx @juspay/yama review --pr <number> --dry-run
```

Read what it _would_ have posted before letting it post anything. Look for:

- findings on lines the pull request did not change (should be impossible — the
  gate rejects them — but it tells you the diff was parsed correctly)
- noise: more than about three comments per hundred changed lines gets ignored
  by humans, and a reviewer people ignore is worse than none
- whether the findings carry real fixes, not just complaints

Then run it live on a real pull request and read the summary comment.

---

## Phase 4 · Optional policy, added deliberately

Add these one at a time, and leave everything non-blocking until you have read a
few scorecards. A reviewer that blocks merges on day one gets turned off on day
two.

### `.yama/checks.yaml` — absorb the CI checks

```yaml
enabled: true
allowForks: false # keep this
checks:
  - id: typecheck
    run: "pnpm run type-check"
    parse: tsc
    scope: changed-lines
    blocking: false
  - id: security
    run: "trivy fs --format sarif ."
    parse: sarif # also covers semgrep, ruff, golangci-lint, clippy, bandit
```

Prefer `parse: sarif` wherever the tool supports it — one parser covers most of
the ecosystem, which is what makes "any language" real rather than aspirational.
For a bespoke script with no parser, `parse: agent` plus a `hint` works.

> **Security, and not negotiable.** `checks.yaml` and every script it names are
> read from the **base branch**, never the pull request. Yama refuses to run
> checks if the head modified a declared script, and forks are off by default.
> Running repository code on an untrusted pull request is arbitrary code
> execution with the CI job's credentials. Never set `allowForks: true` unless
> every fork is trusted.

### `.yama/policy/ownership.yaml` — who must approve what

```yaml
rules:
  - id: payments
    paths: ["src/payments/**"]
    owners: ["@team/payments"]
    minApprovals: 1
    blocking: false # start here; promote later
```

Deterministic, no model involved. One grouped comment, updated in place on
re-runs, nobody re-tagged. If the repository already has `CODEOWNERS`, import it
— but note the import is non-blocking, because importing a file must never
silently change what can merge.

### `.yama/rules/*.yaml` — the conventions

The evidence here is unambiguous: **verbose rule files make agents worse.**
Developer-written context files buy about +4% task success for +19% inference
cost, and LLM-generated ones _reduced_ success in five of eight tested settings.

So write only what the agent cannot infer:

```yaml
rules:
  - id: types.no-interface
    title: Use `type`, never `interface` # imperative, one sentence
    summary: Declare with `type X = {...}` and compose with `&`, not `extends`.
    paths: ["src/**/*.ts"]
    severity: MINOR
    example: | # one example beats three paragraphs
      // no
      interface Result extends Base { ok: boolean }
      // yes
      type Result = Base & { ok: boolean };
```

Delete anything a linter already enforces — move it to `checks.yaml` instead. A
rule that duplicates a linter produces two comments on one line, and the team
learns to skim both.

---

## Phase 5 · CI, and learning

Wire the review workflow first, verify it on a real pull request, and only then
turn on learning.

`references/workflows.md` has complete, commented workflow files for GitHub
Actions. The parts that matter:

**Review workflow**

- `fetch-depth: 0` — Yama reads the diff from disk; shallow clones produce a
  _wrong_ diff, not an absent one
- `concurrency` group per pull request, `cancel-in-progress: true`
- upload/download an artifact named `yama-pr-<n>` — this is the pull request's
  memory across runs
- run `doctor --live` before the review

**Learn workflow**

- triggers on `pull_request: [closed]`, gated on `merged == true`
- `fetch-depth: 0` — correction linking walks history
- `doctor --learn` before computing anything
- three independent loop guards: `[skip ci]` in the commit, an actor guard, and
  `paths-ignore` on `.yama/knowledge/**` in the _other_ workflows. `[skip ci]`
  alone is honoured inconsistently across GitHub Actions, Bitbucket Pipelines and
  Jenkins.

Learning needs write access. `.yama/yama.yaml`:

```yaml
learn:
  trigger: merge-event
  mergeStrategy: rebase # from Phase 1
  mode: commit # or pull-request, for a protected branch
  botIdentity: github-actions[bot]
  git:
    auth: https # or ssh
    userEnv: YAMA_GIT_USER
    tokenEnv: YAMA_GITHUB_TOKEN
    remote: "https://github.com/org/repo.git"
    branch: main
```

```bash
npx @juspay/yama doctor --learn   # proves credential, remote and branch
```

### Bootstrap, last

```bash
npx @juspay/yama bootstrap
```

Mines recent merged pull requests once and opens a **pull request** with what it
learned. It never commits directly the first time — those files shape every
future review, and the corrections a human makes reviewing them are the
strongest signal the system will ever get. Every mined rule starts as a
_candidate_: recorded and retrievable, not enforced until a reviewer states it
again on a real pull request.

---

## Phase 6 · Migrating an existing v3 config

```bash
npx @juspay/yama migrate           # shows what moves where
npx @juspay/yama migrate --write   # applies it
```

The old config keeps working the whole time. Delete it when satisfied.

**Tell the user about the one real behaviour change.** v3 concatenated
`focusAreas` and `workflowInstructions` into every prompt. v4 has no prompt to
put them in — the system instruction is a static constant, and everything else
reaches the agent through tools. `migrate` writes them to `.yama/knowledge/`
where they are retrieved on demand. They are not silently dropped and not
silently injected, but they _are_ reaching the model differently, and the user
should know.

Keys that migrate reports as dropped were never read by v3 either:
`performance.tokenBudget`, `performance.costControls`,
`performance.maxReviewDuration`, `review.toolPreferences`.

---

## Troubleshooting

| Symptom                        | Cause                                     | Fix                                                                     |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------- |
| `doctor` fails on a capability | the tool name is wrong                    | `doctor` prints what the server advertises — copy it                    |
| Registered but 0 tools         | credentials or scopes                     | the server connected and exposed nothing; check the token's permissions |
| Auth header empty              | env var unset or misnamed                 | avoid `${GITHUB_TOKEN}` inside composite actions                        |
| Findings but no comments       | no posting capability in the `post` stage | add `post` to that server's `stages`                                    |
| Duplicate comments on re-run   | `botIdentity` mismatch                    | markers are only trusted from the configured identity                   |
| Learning silently does nothing | rebase repo on a `push` trigger           | switch to `merge-event`; Yama disables and says so rather than guessing |
| Too many comments              | rules duplicating a linter                | move them to `checks.yaml` and delete the rules                         |

---

## What to tell the user when you finish

1. Nothing blocks yet. Every blocking reason needs its own opt-in.
2. The reviewer starts cold and improves with every merge — the expensive work
   happens at merge time, where nobody is waiting, so reviews get better without
   ever getting slower.
3. Read the scorecard after a few pull requests. Per-rule precision is what
   justifies retiring a noisy rule with evidence rather than opinion.
