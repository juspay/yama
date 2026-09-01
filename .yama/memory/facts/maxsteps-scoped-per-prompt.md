# maxSteps (60) applies per prompt, not per session: each entry in prompts.json is its own generate() call with a fresh step budget, so one prompt's spend never cuts short another's; prompts share only conversation history (with auto-compaction).

- yama-fact: maxsteps-scoped-per-prompt
- kind: knowledge
- scope: reviewer/, prompts.json, config.json
- sources: 3903118819
- learned-at: 2026-09-01T12:05:03.554Z · pull request #102

## Why

A reviewer incorrectly assumed a single 60-step budget spanned the whole run and that prompt 2's validation could be starved by prompt 1's review spend; the maintainer corrected this as a factual matter about how the engine meters steps.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
