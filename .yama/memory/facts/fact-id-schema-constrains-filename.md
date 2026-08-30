# Do not raise fact.id filename-sanitization / allowlist findings on the learn memory write path: MemoryFactSchema.id is already constrained to /^[a-z0-9]+(?:-[a-z0-9]+)*$/, which forbids '/', '.', and '..', so a fact.id is filename-safe before it is joined onto the memory directory; the downstream isWritablePath refusal is redundant defense, not a missing layer.

- yama-fact: fact-id-schema-constrains-filename
- kind: suppression
- scope: src/tools/gitWriter.ts, src/tools/memory.ts
- sources: 5467658545
- learned-at: 2026-08-30T14:49:52.599Z · pull request #90

## Why

The reviewer explicitly withdrew the prior fact.id filename-sanitization findings (learn-fact-id-filename-sanitization / F1 / learn-fact-id-not-allowlisted) as invalid on exactly this ground, so any future review flagging this class would repeat a dismissal.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
