# When readDescription cannot read a PR's description it returns undefined and Yama silently declines description enhancement without surfacing any error to the author. A description Yama 'cannot read' is one it 'refuses to touch', so an unwrap regression can quietly kill the describe action with a green suite.

- yama-fact: unreadable-description-silently-disables-describe
- kind: knowledge
- scope: src/platform/results.ts, src/stages/delivery.ts
- sources: comment 3892727038, comment 3892512555, comment 3892906998
- learned-at: 2026-08-31T08:55:21.115Z · pull request #95

## Why

Both reviewer and author stated this behavior in the discussion ('A description Yama cannot read is one it refuses to touch'; 'silently disables the describe action... without any error surfaced to the author'). Explains why a readDescription regression is high impact despite being silent.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
