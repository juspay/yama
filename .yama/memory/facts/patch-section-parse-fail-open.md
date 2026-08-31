# When a patch section's target path cannot be parsed from its diff --git header, keep the hunk in the banked patch rather than dropping it.

- yama-fact: patch-section-parse-fail-open
- kind: convention
- scope: src/stages/taskInsertion.ts
- sources: 3893816503
- learned-at: 2026-08-31T13:45:19.134Z · pull request #100

## Why

The reviewer fixed stripPatchOf to parse each section's path off its own header and stated the failure preference explicitly: showing a hunk that should have been dropped is a smaller failure than silently discarding a real one. This is the fail-open counterpart to the repository's silent-drop aversion.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
