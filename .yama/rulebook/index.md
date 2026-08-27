# Review rulebook

Read this first. Everything it points at is read after it.

`CLAUDE.md` is the long form of the same rulings, written for someone changing the code.
This directory is the short form, written for someone reviewing a change: each rule has an
id, a statement that can actually be checked against a diff, and a severity. Findings cite
the ids.

## How this repository wants to be reviewed

Yama is a review agent. It reads attacker-controlled diffs with credentials in its
environment and it decides whether code merges — so the posture is sceptical about anything
touching what it can execute, what it can post, and what decides the verdict, and relaxed
about everything a linter already owns.

- **Do not review what a check reviews.** `pnpm run lint`, `pnpm run check` and the e2e
  suites run as checks on the pull request. Formatting, unused variables, `interface` vs
  `type`, missing `.js` extensions, a type in the wrong folder — all of it is a lint error
  with a file and a line already. Repeating it as a comment buries the finding that matters.
- **The rulings below are the ones a linter cannot see.** They are about what the code
  guarantees, not how it is written, and every one of them exists because breaking it caused
  an observed failure.
- **A guarantee weakened quietly is the worst finding here.** A review that posts nothing
  and a review that found nothing look identical from outside; so do a verdict derived from
  posted findings and one the model asserted. Anything that blurs those pairs is CRITICAL
  even when it is three lines long.
- **Degradation is a feature; silence is not.** An optional subsystem may switch itself off,
  but it must name itself and its reason. `catch {}` is never acceptable.

## Rules

- [architecture.md](./architecture.md) — the invariants that keep a review honest: the
  verdict, what counts as posted, the engine seam, fail-closed tool policy, no budgets.
- [types.md](./types.md) — the type-system conventions worth a comment, and the ones that
  are lint's job rather than a reviewer's.
- [testing.md](./testing.md) — end-to-end only, driving what ships.

## Hot paths

Changes under these paths carry a higher floor: report at MAJOR at least, even when the
change looks small, and say what the blast radius is.

| Path                                                          | Why                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/gates/**`                                                | Decides what merges and what counts as delivered. A quiet regression here weakens every future review at once. |
| `src/tools/checks.ts`                                         | Executes repository-authored commands with CI credentials. The largest blast radius in the product.            |
| `src/tools/gitWriter.ts`                                      | The only code that holds write credentials and the only code that commits.                                     |
| `src/tools/git.ts`, `src/tools/fs.ts`, `src/engine/policy.ts` | Confine an agent that is reading an untrusted diff.                                                            |
| `src/config/**`                                               | A config surface that breaks on upgrade breaks every consumer repository at once.                              |

## What this rulebook does NOT cover

Say so rather than inventing a house style:

- **Performance.** Nothing here is on a hot path; a review turn is dominated by model
  latency. Do not raise a finding about an extra array pass.
- **Naming and prose style** beyond the type-name rulings. Prettier owns layout; taste is
  not a finding.
- **Dependency choice.** Adding a dependency is a maintainer decision, not a review one —
  note it, do not gate on it.
- **Prompt wording.** The stage prompts are tuned against real runs. Changed wording is
  reviewable for what it now permits or forbids the agent to do, never for how it reads.
