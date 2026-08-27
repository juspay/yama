# Review memory

What earlier reviews of this repository decided. Written by `yama learn` after a pull
request merges; read by every review during WarmUp. A note in here outranks a general
principle — it is what this repository actually settled on.

**This file is generated.** Edit or delete the fact files under `facts/`; this index is
rebuilt from them on the next `yama learn`.

No facts recorded yet.

---

## What lives here

`yama learn --pr N` reads a merged pull request's discussion, works out what the reviewers
actually decided — which findings were accepted, which were dismissed and why, which
suppressions came out of it — and writes:

```
memory/
  index.md          this file. GENERATED: rebuilt from facts/ on every learn run
  facts/<id>.md     one fact, one file. The file name is the fact's id
```

**These are documents, not a database.** A fact that is wrong should be deleted with `rm`;
a fact that is nearly right should be fixed in an editor. Either way the index catches up on
the next run, because it is rebuilt from `facts/` rather than appended to — a fact deleted by
hand disappears from this list without anyone having to remember to remove the line.

Nothing else writes here. This directory is committed, by the one command in Yama that ever
commits, and it stages `.yama/` and nothing else. The run store (`.yama/artifacts/`) is the
opposite: per-pull-request, carried between runs as a CI artifact, never committed.

The text above this section is what a generated index says when the directory is empty, so
the first `yama learn` run replaces this file with the same header and the facts it found.
