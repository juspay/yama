# checkRemote (the credential-in-URL check that refuses a remote URL carrying user:token@) is only invoked inside the `if (push)` branch of planMemoryCommit, so a configuration that commits but does not push (learn.push defaults to false) never inspects a credential-bearing remote; this is a real but defense-in-depth-grade gap on the learn write path.

- yama-fact: checkremote-only-on-push-confirmed
- kind: knowledge
- scope: src/tools/gitWriter.ts
- sources: 3873330094, 5467658545, 5467723190
- learned-at: 2026-08-30T14:49:52.599Z · pull request #90

## Why

Multiple review runs raised it; a later run explicitly 'confirmed and left standing: checkRemote is invoked only on push (gitwriter-checkremote-only-on-push holds)' rather than fixing or dismissing it, establishing it as a known, valid, acknowledged-but-unfixed property of the codebase.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
