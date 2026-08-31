# Glob exclude patterns are root-anchored the way a gitignore entry containing a slash is: dist/** does not match packages/app/dist/bundle.js, and '**/dist/**' is the spelling for 'anywhere'; a leading '**/' segment followed by a separator must match zero directories too (root-level files).

- yama-fact: glob-patterns-root-anchored-gitignore
- kind: knowledge
- scope: src/util/glob.ts, src/config/schema.ts
- sources: 3893816503, 3894782954
- learned-at: 2026-08-31T13:45:19.134Z · pull request #100

## Why

The reviewer explained both the deliberate root-anchoring (strip-patch) and the '**/' zero-directory semantics (F2), noting these are the gitignore spellings operators reach for. Future reviewers should not flag '**/X' missing a root file or 'dist/**' missing a nested file as bugs.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
