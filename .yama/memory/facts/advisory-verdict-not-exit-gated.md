# Do not raise that the APPROVE/NEEDS_WORK verdict is not mapped to a non-zero exit code or code gate in the reviewer workflow; green deliberately means 'review delivered', not 'approved', and merge gating stays with required checks and human review.

- yama-fact: advisory-verdict-not-exit-gated
- kind: suppression
- scope: .github/workflows/yama-review.yml, reviewer/
- sources: 3903118524, 3903119358
- learned-at: 2026-09-01T12:05:03.554Z · pull request #102

## Why

pdogra1299 twice dismissed this class: 'Intentional scope reduction: the new reviewer is advisory... today green deliberately means "review delivered"' and 'whether this workflow should regain a code-enforced verdict→exit mapping is a product decision we're deferring deliberately.' A run that breaks still exits non-zero.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
