# In Bitbucket, a PR document (id, empty body, description under description/summary) and its inline comments live in the same record: the comments sit in the active_comments array inside the PR document itself. Any descent into list keys while reading the PR document will therefore capture the comment records instead of the document that holds the description.

- yama-fact: bitbucket-pr-description-and-comments-share-one-record
- kind: knowledge
- scope: src/platform/results.ts, src/platform/*
- sources: comment 3892512555, comment 3892727038
- learned-at: 2026-08-31T08:55:21.115Z · pull request #95

## Why

Reviewer explained the envelope shape (finding 1) and the author confirmed it against the live Bitbucket response, then fixed by making readDescription stop at the document rather than descend into active_comments.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
