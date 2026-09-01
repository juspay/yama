# Do not raise the memory block being on by default (enabled=true, summarize=true) as a backward-compat violation or demand it be made opt-in — it is a deliberate design decision, not an oversight.

- yama-fact: memory-default-on-is-intent
- kind: suppression
- scope: src/config/schema.ts, src/engine
- sources: 3901584620
- learned-at: 2026-09-01T07:47:15.994Z · pull request #101

## Why

Author dismissed the default-on suggestion as intent: 'Memory on by default is the point of the change, not an oversight' — it fixes the silent memory-less cold-call failure of v5, and off degrades speed, not correctness; every stage prompt is self-contained and a test forbids prompt builders depending on the conversation. Raising it again would re-litigate a settled design decision.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
