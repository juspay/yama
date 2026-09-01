# The prior review engine under src/ (including src/gates/verdict-gate.ts and the run store) is fully intact and still builds and runs; this change only swapped the workflow's engine invocation and added reviewer/. git diff main --name-only shows only .github/workflows/yama-review.yml, eslint.config.js, and reviewer/.

- yama-fact: old-engine-under-src-intact
- kind: knowledge
- scope: src/, reviewer/, .github/workflows/
- sources: 3903119358, 3903118308
- learned-at: 2026-09-01T12:05:03.554Z · pull request #102

## Why

A reviewer asserted the approval-threshold gate and enforcement boundary were deleted; the maintainer showed via git diff that no file under src/ changed, so the old gate logic remains live in the codebase.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
