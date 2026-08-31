# The transient status set is 5xx plus the specific 4xx codes 408/409/425/429 — the codes that describe a condition to wait out — not 'any 4xx'. An unlisted 4xx fails first.

- yama-fact: transient-status-set-is-5xx-plus-select-4xx
- kind: knowledge
- scope: src/util/transient.ts
- sources: 3893034545
- learned-at: 2026-08-31T09:13:36.362Z · pull request #96

## Why

The doc comment's blanket 'any 4xx fails first' wording contradicted the actual set and was corrected to state the real rule so the contract matches the code.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
