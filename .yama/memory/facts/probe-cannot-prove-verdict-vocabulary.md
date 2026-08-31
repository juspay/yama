# A capability probe can prove a platform is reachable but cannot derive its verdict vocabulary — knowing whether a platform considers a state a meaningful 'comment' requires a maintained table of vocabularies, which a probe cannot reconstruct.

- yama-fact: probe-cannot-prove-verdict-vocabulary
- kind: knowledge
- scope: src/cli/index.ts
- sources: 3894783139
- learned-at: 2026-08-31T13:45:19.134Z · pull request #100

## Why

The reviewer rejected the proposed capability-probe fix for F4 because a static vocabulary table was removed precisely because it was hardcoded to GitHub and misjudged Bitbucket's NEEDS_WORK; re-deriving it in a probe would reintroduce the defect one layer down. Claim derivations must instead gate on evidence the agent cannot fabricate (here, confirmed posting of the summary carrying the verdict).

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
