# Review memory

Knowledge accumulated from earlier reviews, written by `yama learn` after a pull request
merges: which findings were accepted, which were dismissed and why, and the suppressions
that came out of that. Every review reads this directory during WarmUp.

```
memory/
  README.md      this file — yours to edit
  index.md       GENERATED: every fact, rebuilt from facts/ on each learn run
  facts/<id>.md  one fact, one file. The file name is the fact's id
```

A note in here outranks a general principle — it is what this repository actually decided.

**These are documents, not a database.** A fact that is wrong should be deleted with `rm`;
a fact that is nearly right should be fixed in an editor. Either way the index catches up
on the next `yama learn`, because it is rebuilt from `facts/` rather than appended to.

Nothing else writes here. It is committed; the run store (`.yama/artifacts/`) is not.
