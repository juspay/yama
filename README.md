# Yama

[![npm](https://img.shields.io/npm/v/@juspay/yama.svg)](https://www.npmjs.com/package/@juspay/yama)
[![license](https://img.shields.io/npm/l/@juspay/yama.svg)](./LICENSE)

**Yama is an autonomous, checklist-driven pull-request review agent**, built on
[NeuroLink](https://www.npmjs.com/package/@juspay/neurolink). TypeScript, ESM, Node >= 22.
Coming from v4? The old configs do not load — see **[MIGRATION.md](./MIGRATION.md)** for the
mechanical v4 → v5 mapping (your CI secrets are unchanged).

One agent reads your rulebook, writes itself a task checklist for the change under review,
works that checklist — itself, or through delegated workers running in parallel — then
collates, ranks and delivers a verdict.

```
WARMUP       read the rulebook, the guidelines and past memory → an operating brief

TASK         understand the target: files, existing comments, fresh vs. re-review
INSERTION    → WRITE THE CHECKLIST. The concrete review pointers this run must finish
             ("auth changes vs. the security rules", "migrations", "tests for the
             new endpoints").

WORK         per task the agent decides: do it itself, or delegate to a worker.
             Workers run in parallel and come back in any order. A worker's full
             report is banked to a file; the conversation carries only a summary and
             the reference, so evidence never dies of context pressure.
             PENDING TASKS = INCOMPLETE REVIEW. That is the completeness contract,
             and it is enforced by code, not by the model's good intentions.

COLLATE      every task done or explicitly closed with a reason → read the banked
             reports back, dedupe, rank → findings + verdict. Terminal for --dry-run.

DELIVERY     a deterministic stage, NOT agent-chosen work. Config decides what lands
             on the pull request; the shell confirms it actually landed.
```

Two boundaries the agent does not get to move: **delivery is outside the checklist** (what
gets posted is configuration, and every posted comment is confirmed by its returned id),
and **checklist completeness is checked by the shell** — a stage cannot end with silently
pending tasks.

## Quick start

```bash
pnpm add -D @juspay/yama       # or: npm i -D @juspay/yama
pnpm exec yama init --platform github
```

`yama init` scaffolds `.yama/`, and never overwrites a file you already have (pass
`--force` if you mean to):

```
.yama/
  yama.yaml        REQUIRED  model chains per role, pool tier, delivery + verdict policy
  mcp.yaml         REQUIRED  MCP servers, and the capability → tool map
  rulebook/        what this repository actually wants enforced (index.md first)
  checks.yaml      commands to run as evidence (resolved from the base branch)
  memory/          knowledge; written by `yama learn`, read by every review
  ci/              GitHub Actions + Jenkins recipes to copy
  artifacts/       the run store — a CI artifact, never committed
```

Then edit the two required files, export the environment variables they name, and prove the
setup before CI does:

```bash
pnpm exec yama doctor                 # connects every server, probes every capability
pnpm exec yama review --dry-run       # a full review of the local diff, posting nothing
```

## Commands

```bash
yama init   [--platform github|bitbucket|none] [--force]
yama doctor [--pr N | --branch X] [--base ref]
yama review [--pr N | --branch X] [--base ref] [--dry-run] [--json out.json]
yama learn  --pr N [--dry-run] [--json out.json]
```

With neither `--pr` nor `--branch`, `yama review` reviews the local diff.

Exit codes are a CI contract — codes get added, never renumbered:

| code | meaning                                         |
| ---- | ----------------------------------------------- |
| `0`  | finished; verdict APPROVE or COMMENT            |
| `1`  | finished; verdict BLOCK                         |
| `2`  | configuration is wrong (`yama doctor` says how) |
| `3`  | the run itself failed                           |

## What lands on the pull request

- **Inline comments** — one per finding, on the line it is about:
  `**MAJOR · ci/deterministic-build** — <summary>`, the impact, a concrete **Fix:**, the
  evidence refs, and the dedup markers. Severity taxonomy: `CRITICAL / MAJOR / MINOR / INFO`,
  filtered by `delivery.minSeverity` and capped by `delivery.maxInlineComments`.
- **One summary comment** — what was reviewed, every finding ranked most-serious-first, the
  verdict and its reasons, and what was withheld or already posted by an earlier run.
- **The verdict** — `APPROVE / COMMENT / BLOCK`, decided by the `verdict:` policy in
  `yama.yaml` (a pure function of the open findings — the model does not get a vote), and
  carried by the exit code so CI can gate on it.

Findings must cite files the change actually touches — a groundedness gate drops and NAMES
anything else — and posting is confirmed against the platform's own state, never the
agent's account of it.

## What a run reports

Every run writes a `run.json` (plus per-stage payloads and every worker's full report) into
`.yama/artifacts/<target>/`, uploads it as a CI artifact, and can mirror the result with
`--json out.json`:

| metric         | what it tells you                                                           |
| -------------- | --------------------------------------------------------------------------- |
| `stages`       | per-stage wall time, steps used, and whether the output validated first try |
| `gates`        | checklist complete? · workers collected · findings reported → after dedupe  |
| `recurrence`   | prior findings: fixed / still open / moot, and the incremental sha range    |
| `delivery`     | intended / posted / already-posted / stale, each finding accounted for      |
| `degradations` | every capability or check that was OFF this run, with the reason            |
| `verdict`      | the decision and the exact policy reasons behind it                         |

`yama review` prints the same as a human-readable summary at the end of every run.

## Capabilities, not platforms

Yama's code never spells a platform tool name. It asks for a **capability**; `.yama/mcp.yaml`
says which tool provides it — so a forge is a config file, not a code path.

```yaml
capabilities:
  # short form — just the tool
  comment.summary.create: github.add_issue_comment

  # long form — the tool plus the arguments every call of it needs
  comment.inline.create:
    tool: github.create_pull_request_review_comment
    args:
      owner: "${GITHUB_OWNER}" # from the environment, loud when unset
      repo: "${GITHUB_REPO}"
      pull_number: "${pr}" # from the run target
```

Run placeholders are `${pr}`, `${branch}`, `${base}` and `${mode}`; anything else is an
environment variable. A capability whose placeholders the current target has no value for is
switched **off** for that run and named in the report — never silently broken. The set:
`pr.read`, `pr.diff`, `pr.describe`, `comment.list`, `comment.inline.create`,
`comment.summary.create`, `comment.update`, `verdict.set`.

At startup every mapped capability is probed against the tools its server really advertises.
A tool nobody serves switches that capability off and prints what the server does expose; a
capability the run cannot start without stops the run and names the fix. `yama doctor` prints
the whole table and exits `2` if anything is broken.

The **diff always comes from git** (`merge-base(base, head)..head`), never from the platform:
deterministic, no API call, identical on every forge. In CI, pass `--base` and clone deep
enough to have it (`fetch-depth: 0`).

## Reviewing the same pull request twice

A re-review must not repeat itself, and must not forget itself. Two independent mechanisms
make that true, because CI loses artifacts and pull requests do not lose comments:

- **Markers.** Every comment Yama posts carries `<!-- yama:finding:<id> -->`. Before the first
  stage the shell reads the comments actually on the target, so the run knows what it has
  already said even with an empty run store.
- **The run store** (`.yama/artifacts/<target>/`, carried between runs as a CI artifact). It
  holds the findings the last run left open and the sha it reviewed — which gives this run an
  _incremental_ patch, banked alongside the whole patch, never instead of it.

Every previously open finding must be accounted for: `fixed`, `moot` or `open`. Anything the
agent says nothing about is carried as **still open** and named in the report, because silence
is not evidence of a fix. The verdict is taken over the full open set, so a CRITICAL nobody
fixed still blocks on the fifth review.

## Description enhancement

With `delivery.describe: true`, Yama writes only inside a fenced block of its own:

```
<!-- yama:description:start -->  …  <!-- yama:description:end -->
```

Everything outside it belongs to the author and is never touched; on later runs the block is
replaced _in place_, wherever the author moved it to. `delivery.describeSections` picks what
goes in it (`summary`, `risk`, `findings`, `coverage`). A description Yama could not read is a
description Yama does not set.

## `yama learn` — the only command that writes

After a pull request merges, `yama learn --pr N` reads its discussion, works out what the
reviewers actually decided, and writes one Markdown file per fact under `.yama/memory/` (plus
a generated `index.md`). Every later review reads that directory during WarmUp, and a note in
it outranks a general principle.

It is off until `learn.enabled: true`, and its write path is deliberately paranoid:

- only `.yama/` is ever staged, and the staged set is **read back out of git** — anything else
  already staged in the checkout aborts the commit rather than being swept into it;
- credentials never touch a config file, a URL or a command line; a remote whose URL carries
  `user:token@` is refused, not used;
- never a force push, ever;
- `[skip ci]` in the subject, and a commit that is already this exact learn commit is refused —
  a learn run that re-triggered itself is a loop;
- `--dry-run` computes everything, prints the exact commit it would make, and writes nothing.
  Run it that way first.

## In CI

`yama init` drops ready-to-copy recipes in `.yama/ci/` — a GitHub Actions workflow and a
Jenkins pipeline. Both do the three things a review needs from CI:

1. check out deep enough for the merge base (`fetch-depth: 0`);
2. restore and save `.yama/artifacts/` between runs, so a re-review remembers;
3. let the exit code decide the job — `1` is a BLOCK verdict, not a crash.

This repository also publishes a composite GitHub Action ([`action.yml`](./action.yml)) if you
would rather not write the steps yourself.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development loop, and [CLAUDE.md](./CLAUDE.md)
for the code rulings this repository enforces — they are lint errors, not preferences.

## License

MIT © [Juspay Technologies](https://juspay.io) — see [LICENSE](./LICENSE).
