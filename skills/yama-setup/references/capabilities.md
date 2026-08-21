# Capabilities

Yama's code never names a tool. It asks for a capability, and `.yama/mcp.yaml`
maps that to whatever the connected server calls it. This is what lets identical
code drive GitHub, Bitbucket, GitLab, or anything else with an MCP server.

## Required for a live run

Without these three, a live run reviews a pull request and then throws the
findings away — which reads to the team as "Yama found nothing".

| Capability          | Used for                                                         |
| ------------------- | ---------------------------------------------------------------- |
| `readPullRequest`   | metadata: title, description, base and head, author, draft state |
| `postInlineComment` | one comment per accepted finding, carrying its marker            |
| `postSummary`       | the single summary comment with the verdict                      |

## Strongly recommended

| Capability         | Used for                                    | Without it                              |
| ------------------ | ------------------------------------------- | --------------------------------------- |
| `listComments`     | reading markers for cross-run deduplication | re-runs may duplicate comments          |
| `updateComment`    | updating the summary in place               | a new summary comment every run         |
| `setStatus`        | recording the review decision               | the verdict appears only in the comment |
| `listChangedFiles` | fallback when the checkout is shallow       | a shallow clone produces a wrong diff   |

## Conditional

| Capability               | Required when                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listApprovals`          | any ownership rule sets `blocking: true` — you cannot enforce what you cannot read, and `doctor` fails loudly rather than letting it pass silently |
| `findPullRequest`        | reviewing by `--branch` instead of `--pr`                                                                                                          |
| `updateDescription`      | the enhance stage is on                                                                                                                            |
| `listMergedPullRequests` | `yama bootstrap` and `yama learn`                                                                                                                  |
| `resolveComment`         | resolving a thread when a finding is fixed                                                                                                         |

## Optional

| Capability   | Used for                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------- |
| `codeIntel`  | caller and dependent tracing for impact analysis; degrades to ripgrep, then to plain text |
| `readTicket` | pulling linked issue context                                                              |

## Stage scoping is a security control

`stages:` decides when a server's tools are visible. This is not bookkeeping.

An agent reviewing a diff is reading attacker-controlled text. If posting tools
are within reach during that turn, a prompt injection in a comment becomes a
write to the pull request. So:

```yaml
stages: [resolve, orient, post, checks, enhance, verdict]
```

means the review turn itself cannot post, and the posting turn cannot review.
Omitting `stages:` exposes the server in every stage — convenient, and worth
avoiding on anything that can write.

## Finding the real tool names

Do not guess.

```bash
npx @juspay/yama doctor --live --pr <number>
```

`--live` is the part that matters: without it `doctor` only checks config shape.
With it, it connects and resolves every capability against what the server really
advertises:

```
✗ capability:readPullRequest: "github" declares "get_pull_request", which that server does not provide
    → That server advertises: add_issue_comment, add_comment_to_pending_review, pull_request_read, …
```

That exact failure is real: GitHub's MCP server consolidated its per-operation
pull-request tools behind `pull_request_read`, selected by a `method` argument.
Configs written against the old names broke silently. When a tool needs a fixed
argument, put it in the mapping:

```yaml
readPullRequest: { tool: pull_request_read, args: { method: get } }
```
