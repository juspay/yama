---
name: repo-conventions
description: This repository's review standards — what to check, what NOT to comment on, the hot paths, and where the full rulebook lives. Load before reviewing any change here.
---

# Reviewing a change in this repository

Full sources — read them when the diff touches what they govern:

- `../CLAUDE.md` — the rulings, long form
- `../.yama/rulebook/index.md` → `architecture.md`, `types.md`, `testing.md` — the short form, with stable rule ids and severities. Findings cite these ids.

## Posture

This project is a review agent: it reads attacker-controlled diffs with credentials in its environment and decides whether code merges. Be sceptical about anything touching what it can execute, what it can post, and what decides the verdict; relaxed about everything a linter already owns.

## Do NOT comment on

- Anything `pnpm run lint` or `pnpm run check` already fails: formatting, `interface` vs `type`, missing `.js` extensions, type-location rules, `any` / double assertions. Restating lint output buries the findings that matter.
- Performance micro-costs (a review turn is dominated by model latency), naming and prose taste, dependency choice.

## The invariants that matter (cite the id)

- `arch.verdict-is-code-derived` — CRITICAL. The verdict is a pure function of the open findings and config; a model-supplied decision must never reach it.
- `arch.posted-not-called` — CRITICAL. A finding counts as posted only when a tool RESULT returned an id; claimed-but-not-posted turns one failure into permanent silence.
- `arch.checklist-completeness` — CRITICAL. Pending tasks mean an incomplete review; the shell decides done-ness, never model self-assessment.
- `arch.engine-seam` — MAJOR. Only `src/engine/` imports `@juspay/neurolink`, statically or dynamically.
- No silent catch — an optional subsystem may degrade but must name itself and its reason.
- No budgets — no step caps or token budgets; timeouts are hang detectors and come from config.
- `--dry-run` is side-effect free; `yama learn` is the only writer and stages `.yama/` only.
- Config stays backward compatible: new keys optional, renames get a loud validation error.
- Tests are end-to-end only, driving `dist/` (`test.drives-what-ships`): a suite importing from `src/` is a finding even when it passes.

## Hot paths — report at MAJOR or higher, and name the blast radius

| Path                                                          | Why                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `src/gates/**`                                                | Decides what merges and what counts as delivered        |
| `src/tools/checks.ts`                                         | Executes repository-authored commands with CI creds     |
| `src/tools/gitWriter.ts`                                      | The only code holding write credentials                 |
| `src/tools/git.ts`, `src/tools/fs.ts`, `src/engine/policy.ts` | Confine an agent reading an untrusted diff              |
| `src/config/**`                                               | A breaking config surface breaks every consumer at once |

## Conventions worth remembering

ESM with `.js` extensions on relative imports, Node >= 22, pnpm. `zod` is pinned to an exact version matching NeuroLink's copy — a drift is a real finding. Conventional Commits, one commit per pull request, releases generated from the commit history.
