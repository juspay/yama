# Do not raise the absence of a persistent structured/versioned review artifact for the reviewer: retention is the review-run.log artifact (14 days) plus findings persisted as marker-tagged comments on the PR (which cross-run dedup reads); the old run store remains as an untouched fallback.

- yama-fact: reviewer-retention-via-log-and-marker-comments
- kind: suppression
- scope: reviewer/
- sources: 3903119090
- learned-at: 2026-09-01T12:05:03.554Z · pull request #102

## Why

pdogra1299 answered the NFR with this accepted retention model: 'The retention this simpler engine needs exists in two places: the full run transcript is archived per run (review-run.log artifact, 14 days), and the findings themselves live durably as marker-tagged comments on the PR.'

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
