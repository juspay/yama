# EngineTask is { id, title, status, note } and carries no scope, so engine-level distinctTasks cannot key on title::scope the way plan-level mergeTasks can; same-title collapse is a deliberate trade-off bounded by the per-file coverage gate at preparation.

- yama-fact: enginetask-cannot-key-on-scope
- kind: knowledge
- scope: src/gates/checklist.ts, src/stages/taskInsertion.ts
- sources: 3901583301, 3901726257
- learned-at: 2026-09-01T07:47:15.994Z · pull request #101

## Why

A reviewer must know the completeness gate's same-title masking cannot be removed at the engine-checklist layer because scope exists only on the plan's InsertionTask. The author explained the proposed fix is unavailable and pinned the behaviour with a test; the per-file coverage gate at preparation is what bounds the exposure.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
