# Synthetic pull request (TASKS:Y8.1)

A pull request that has already been reviewed once, as data — so the recurring-run path
(TASKS:Y7.1) and `yama learn` (TASKS:Y7.2) can be driven end to end with no forge, no MCP
server and no credentials anywhere.

| File | What it stands in for |
|---|---|
| `comments.json` | exactly what a `comment.list` tool returns: two forges' shapes in one list, three of the comments carrying Yama's `<!-- yama:finding:… -->` markers, one written by a human replying to one of them |
| `prior-run.json` | the run report the previous review banked — its `headSha` is the left-hand side of the incremental diff |
| `prior-findings.json` | the findings ledger that review left behind: what a re-review has to account for |

The two shapes in `comments.json` are deliberate. A GitHub-style comment puts the text in
`body` and the id in `id`; a Bitbucket-style one nests it under `content.raw`. Product code
never learns which is which — `readComments` reads both — and a fixture that only carried
one of them would let a forge-specific reader pass.
