# Every new write surface added to the Delivery stage must be folded into the posted-confirmed contract: confirmDelivery confirms the tool result (per-tool, matching the marker in captured call args) and a dedup marker is written, so a falsely-reported write is never treated as delivered and a later recurring run does not skip real work.

- yama-fact: every-new-write-surface-joins-confirmed-contract
- kind: convention
- scope: src/stages/delivery.ts, src/gates/markers.ts
- sources: 3901581297, 3898431581, 3897957233
- learned-at: 2026-09-01T07:47:15.994Z · pull request #101

## Why

comment.reply started as a write surface exempt from posted-confirmed (marker only, no confirmation), explicitly trusting the agent's claim — the reviewers rejected that ('the worst place to trust an agent's claim'), and the author fixed it: confirmAcceptedWrites against the comment.reply tool matching the reply marker, returning repliesConfirmed. This confirms the rulebook's posted-confirmed posture extends to any new write surface.

> Written by `yama learn` from what reviewers said on a merged pull request. Edit it if
> it is nearly right, delete the file if it is wrong — the index rebuilds from this
> directory on the next run.
