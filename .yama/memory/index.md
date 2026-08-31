# Review memory

What earlier reviews of this repository decided. Written by `yama learn` after a pull
request merges; read by every review during WarmUp. A note in here outranks a general
principle — it is what this repository actually settled on.

**This file is generated.** Edit or delete the fact files under `facts/`; this index is
rebuilt from them on the next `yama learn`.

5 fact(s):

- [`bitbucket-pr-description-and-comments-share-one-record`](facts/bitbucket-pr-description-and-comments-share-one-record.md) · knowledge — In Bitbucket, a PR document (id, empty body, description under description/summary) and its inline comments live in the same record: the comments sit in the active_comments array inside the PR document itself. Any descent into list keys while reading the PR document will therefore capture the comment records instead of the document that holds the description.
- [`checkremote-only-on-push-confirmed`](facts/checkremote-only-on-push-confirmed.md) · knowledge — checkRemote (the credential-in-URL check that refuses a remote URL carrying user:token@) is only invoked inside the `if (push)` branch of planMemoryCommit, so a configuration that commits but does not push (learn.push defaults to false) never inspects a credential-bearing remote; this is a real but defense-in-depth-grade gap on the learn write path.
- [`fact-id-schema-constrains-filename`](facts/fact-id-schema-constrains-filename.md) · suppression — Do not raise fact.id filename-sanitization / allowlist findings on the learn memory write path: MemoryFactSchema.id is already constrained to /^[a-z0-9]+(?:-[a-z0-9]+)*$/, which forbids '/', '.', and '..', so a fact.id is filename-safe before it is joined onto the memory directory; the downstream isWritablePath refusal is redundant defense, not a missing layer.
- [`readcomments-and-readdescription-need-separate-descent`](facts/readcomments-and-readdescription-need-separate-descent.md) · knowledge — readComments and readDescription consume the same envelope but want different things from it: comment reading must descend into list keys (active_comments), while description reading must stop at the top-level document. They therefore cannot share one unwrap descent; this PR split the single unwrapRecords into unwrapRecords (descending, for readComments) and unwrapDocuments (envelope-tolerant but stops at the document, for readDescription).
- [`unreadable-description-silently-disables-describe`](facts/unreadable-description-silently-disables-describe.md) · knowledge — When readDescription cannot read a PR's description it returns undefined and Yama silently declines description enhancement without surfacing any error to the author. A description Yama 'cannot read' is one it 'refuses to touch', so an unwrap regression can quietly kill the describe action with a green suite.
