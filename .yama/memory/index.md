# Review memory

What earlier reviews of this repository decided. Written by `yama learn` after a pull
request merges; read by every review during WarmUp. A note in here outranks a general
principle — it is what this repository actually settled on.

**This file is generated.** Edit or delete the fact files under `facts/`; this index is
rebuilt from them on the next `yama learn`.

2 fact(s):

- [`checkremote-only-on-push-confirmed`](facts/checkremote-only-on-push-confirmed.md) · knowledge — checkRemote (the credential-in-URL check that refuses a remote URL carrying user:token@) is only invoked inside the `if (push)` branch of planMemoryCommit, so a configuration that commits but does not push (learn.push defaults to false) never inspects a credential-bearing remote; this is a real but defense-in-depth-grade gap on the learn write path.
- [`fact-id-schema-constrains-filename`](facts/fact-id-schema-constrains-filename.md) · suppression — Do not raise fact.id filename-sanitization / allowlist findings on the learn memory write path: MemoryFactSchema.id is already constrained to /^[a-z0-9]+(?:-[a-z0-9]+)*$/, which forbids '/', '.', and '..', so a fact.id is filename-safe before it is joined onto the memory directory; the downstream isWritablePath refusal is redundant defense, not a missing layer.
