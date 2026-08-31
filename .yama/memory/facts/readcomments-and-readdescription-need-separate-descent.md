# readComments and readDescription consume the same envelope but want different things from it: comment reading must descend into list keys (active_comments), while description reading must stop at the top-level document. They therefore cannot share one unwrap descent; this PR split the single unwrapRecords into unwrapRecords (descending, for readComments) and unwrapDocuments (envelope-tolerant but stops at the document, for readDescription).

- yama-fact: readcomments-and-readdescription-need-separate-descent
- kind: knowledge
- scope: src/platform/results.ts
- sources: comment 3892727038, comment 3892727201
- learned-at: 2026-08-31T08:55:21.115Z · pull request #95

## Why

Author explicitly stated 'The two callers want different things from the same envelope, so they no longer share one descent' when describing the fix, confirming this as a deliberate repository decision.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
