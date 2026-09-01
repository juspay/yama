# Memory enabled with no summarizer evicting is a distinct, bad state that must be named on the run report (memoryDegradation distinguishes memory OFF from memory ON WITH NOTHING EVICTING); and the summarizer timeout/ceiling is a property of NeuroLink the gateway, not Yama, so it must be configurable (memory.summarizeTimeoutMs), never a hardcoded constant.

- yama-fact: memory-on-without-eviction-must-degrade-named
- kind: knowledge
- scope: src/engine, src/config
- sources: 3901583120, 3901581434
- learned-at: 2026-09-01T07:47:15.994Z · pull request #101

## Why

The author's most-valued finding: a memory that grows for ever while looking managed is worse than memory off. Fix was to thread the timeout from config via the patch and to expose a named degradation (memoryDegradation) rather than returning silently from a timeout/failure. Also: 'a ceiling that is a property of somebody else's gateway cannot be right for this one.'

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
