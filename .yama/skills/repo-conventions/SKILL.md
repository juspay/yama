---
name: repo-conventions
description: This repository's review standards — what to check, what NOT to comment on, the hot paths, and where the full rulings live. Load before reviewing any change here.
---

# Reviewing a change in this repository

Full source — read it when the diff touches what it governs:

- `../CLAUDE.md` — the rulings, long form

## Posture

This project is a review agent: it reads attacker-controlled diffs with credentials in its environment and posts on pull requests. Be sceptical about anything touching what it can execute, what it can write, and what it can post; relaxed about everything a linter already owns.

## Do NOT comment on

- Anything `pnpm run lint` or `pnpm run check` already fails: formatting, unused variables, `interface` vs `type` in `test/`. Restating lint output buries the findings that matter.
- Performance micro-costs (a review turn is dominated by model latency), naming and prose taste, dependency choice.
- That the APPROVE / NEEDS_WORK verdict does not change the job's exit code. Green deliberately means "review delivered", not "approved"; merge gating belongs to required checks and human review.
- The absence of a structured, versioned review artifact. Retention is the uploaded run log (14 days) plus the comments on the pull request itself.
- `maxSteps` "running out" across prompts: it applies per prompt — each `prompts.json` entry is its own turn with a fresh step allowance, sharing only conversation history.

## Known, accepted gaps

- `src/learn.mjs` checks the remote URL for an embedded credential only when `learn.push` is on. A commit-only configuration never inspects the remote. This is defense-in-depth, not a live leak: nothing is sent anywhere without a push.

## The invariants that matter

- CRITICAL — `yama learn` is the only writer: it stages exactly the memory database, reads the staged set back out of git, never force-pushes, refuses a remote URL carrying a credential, and puts `[skip ci]` in the subject.
- CRITICAL — attacker-controllable values (branch names, action inputs, PR text) reach a shell only through env vars, never `${{ }}` interpolation into a `run:` script.
- CRITICAL — no secret value in code, config, tests or docs; credentials are referenced by env var NAME.
- MAJOR — a failed prompt fails the run; an aborted review must never read as a clean one.
- MAJOR — no silent catch: an optional subsystem (memory, code graph) may degrade but must name itself and its reason.
- MAJOR — config stays backward compatible: new `config.json` keys optional with behaviour-preserving defaults; `yama init` output and `action.yml` inputs are a public contract.
- MAJOR — `src/` never depends on `.yama/`: `src/` is the package every consumer runs, `.yama/` is only this repository's own configuration.
- Tests are end-to-end only: `test/` drives `src/index.mjs` as a subprocess. A suite importing a `src/` module is a finding even when it passes.

## Hot paths — report at MAJOR or higher, and name the blast radius

| Path                                 | Why                                                        |
| ------------------------------------ | ---------------------------------------------------------- |
| `src/learn.mjs`                      | The only code that commits and pushes                      |
| `src/index.mjs`                      | Loads config, expands env refs, connects MCP, runs turns   |
| `src/init.mjs`                       | Scaffold every consumer starts from                        |
| `action.yml`, `.github/workflows/**` | Run with repository credentials on untrusted pull requests |
| `.yama/config.json`, `MCP.json`      | What this repository's own reviews can reach               |

## Conventions worth remembering

ESM, Node >= 22, pnpm; the root `package.json` is the single dependency manifest. Conventional Commits, one commit per pull request, releases generated from the commit history.
