# CI workflows

Complete files for GitHub Actions. Adapt the shape for other CI systems — the
requirements below are what matter, not the syntax.

## Requirements, whatever the CI system

1. **Full checkout.** Yama reads the diff and the code from disk. A shallow
   clone cannot reach the base commit, so the diff is _wrong_ rather than
   absent — which is worse.
2. **One review per pull request at a time.** Two concurrent runs race on
   comment markers and can duplicate comments.
3. **An artifact per pull request.** It carries what earlier runs established.
   Losing it is survivable — markers still deduplicate — but every run then
   re-derives what it already knew.
4. **`doctor` before the review.** Fail in ten seconds, not twenty minutes.

## Review

```yaml
name: Yama review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: yama-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Drafts are not ready. And Yama must never review its own learning commits.
    if: >
      github.event.pull_request.draft == false &&
      github.event.pull_request.user.login != 'github-actions[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # required — see (1) above

      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Restore this pull request's memory
        continue-on-error: true # absent is fine
        uses: actions/download-artifact@v4
        with:
          name: yama-pr-${{ github.event.pull_request.number }}
          path: .yama/state
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Verify the setup
        env:
          YAMA_GITHUB_TOKEN: ${{ secrets.YAMA_GITHUB_TOKEN }}
        run: npx --yes @juspay/yama doctor --live

      - name: Review
        env:
          YAMA_GITHUB_TOKEN: ${{ secrets.YAMA_GITHUB_TOKEN }}
          YAMA_CONCURRENCY: medium
        run: npx --yes @juspay/yama review --pr ${{ github.event.pull_request.number }}

      - name: Save this pull request's memory
        if: always()
        continue-on-error: true
        uses: actions/upload-artifact@v4
        with:
          name: yama-pr-${{ github.event.pull_request.number }}
          path: .yama/state
          retention-days: 30
          overwrite: true
```

## Learn

```yaml
name: Yama learn

# The merge event is the only trigger that reliably identifies which pull
# request merged. On a rebasing repository it is the ONLY option — commits carry
# no pull request number, and a push trigger would attribute feedback wrongly.
on:
  pull_request:
    types: [closed]

concurrency:
  group: yama-learn # serialised: two runs would race pushing to main
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: read

jobs:
  learn:
    # Only a MERGED pull request teaches anything. A rejected one would teach
    # conventions nobody adopted.
    if: >
      github.event.pull_request.merged == true &&
      github.event.pull_request.user.login != 'github-actions[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0 # correction linking walks history
          token: ${{ secrets.YAMA_GITHUB_TOKEN }}

      - uses: actions/setup-node@v4
        with: { node-version: 22 }

      - name: Restore the pull request's memory
        continue-on-error: true
        uses: actions/download-artifact@v4
        with:
          name: yama-pr-${{ github.event.pull_request.number }}
          path: .yama/state
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Verify the write path
        # Before computing anything. Discovering at push time that the bot
        # cannot write loses this pull request's feedback permanently.
        env:
          YAMA_GITHUB_TOKEN: ${{ secrets.YAMA_GITHUB_TOKEN }}
          YAMA_GIT_USER: github-actions[bot]
        run: npx --yes @juspay/yama doctor --learn

      - name: Learn
        env:
          YAMA_GITHUB_TOKEN: ${{ secrets.YAMA_GITHUB_TOKEN }}
          YAMA_GIT_USER: github-actions[bot]
        run: npx --yes @juspay/yama learn --pr ${{ github.event.pull_request.number }}
```

## Loop prevention needs all three

A learning commit lands on the default branch. Left alone it retriggers CI, and
on some setups retriggers learning.

1. **`[skip ci]`** in the commit subject — Yama does this automatically.
2. **An actor guard** in every workflow: `github.actor != 'github-actions[bot]'`.
3. **`paths-ignore`** in your _other_ push-triggered workflows:

```yaml
on:
  push:
    branches: [main]
    paths-ignore:
      - ".yama/knowledge/**"
      - ".yama/product/**"
      - ".yama/state/**"
```

All three, because `[skip ci]` is honoured inconsistently across GitHub Actions,
Bitbucket Pipelines and Jenkins, and a self-retriggering learning loop is both
expensive and unpleasant to diagnose.

## Secrets

| Secret               | For                                           |
| -------------------- | --------------------------------------------- |
| `YAMA_GITHUB_TOKEN`  | the VCS MCP server, and pushing learn commits |
| provider credentials | whatever `ai.provider` needs                  |

Reference the VCS token by a **non-reserved** name. `${{ secrets.GITHUB_TOKEN }}`
is not reliably forwarded into composite actions, and the failure surfaces much
later as an opaque remote 401.

If the default branch is protected, either allow the bot to bypass it, or set
`learn.mode: pull-request` so Yama opens a bot pull request instead of pushing.
