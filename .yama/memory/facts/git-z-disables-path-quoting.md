# git diff writes headers quoted and C-escaped (diff --git "a/caf\303\251.svg") while git diff --name-status -z emits the raw path, because -z disables path quoting; unescaping must collect octal triples as bytes and UTF-8-decode them together since one character is several triples.

- yama-fact: git-z-disables-path-quoting
- kind: knowledge
- scope: src/stages/taskInsertion.ts, src/util/glob.ts
- sources: 3894782775
- learned-at: 2026-08-31T13:45:19.134Z · pull request #100

## Why

The F1 reviewer had to explain why two predicates comparing diff.files[] and a diff header disagreed for the same file and how the quoted branch must be un-escaped correctly. Without this, any future code matching paths from both forms will diverge.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
