# Error status extraction must not read the `code` field: Node puts strings like ECONNRESET there and other SDKs use their own numbering. Because the extracted status now decides rather than merely hints, reading `code` would lead a wrong guess to silence a legitimate retry.

- yama-fact: statusof-ignores-code-field
- kind: knowledge
- scope: src/util/transient.ts
- sources: 3893034545
- learned-at: 2026-08-31T09:13:36.362Z · pull request #96

## Why

The decision followed directly from making the status authoritative — once it decides, the extraction source must be trustworthy.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
