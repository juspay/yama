# In the transient error classifier, a provider-set HTTP status is authoritative: if a usable status is present it decides classification, and the message text can never overrule it. Text-fallback marker matching runs only when the error carries no usable status field.

- yama-fact: provider-status-is-authoritative
- kind: knowledge
- scope: src/util/transient.ts
- sources: 3893034545
- learned-at: 2026-08-31T09:13:36.362Z · pull request #96

## Why

A 4xx misconfiguration (401 wrong key, 403 model-not-allowed, 400 malformed) whose message merely mentions a transient marker like 'timeout' or '500' must fail fast on the first attempt rather than be silently retried 3x with backoff.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
