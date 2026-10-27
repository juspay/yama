# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Yama (`@juspay/yama`) is a prompts-driven pull-request review agent built on
`@juspay/neurolink`. The whole product is `src/`: a small ESM CLI (bin `yama`) that
reads `config.json`, `MCP.json`, `prompts.json` and `skills/` from the working directory,
runs the prompts top to bottom in one NeuroLink session, and keeps long-term memory in a
committed Hippocampus SQLite database. It ships as an npm package and a composite GitHub
Action (`action.yml`).

[README.md](./README.md) is the product; this file is the rulings.

## Commands

```bash
pnpm install
pnpm run check      # tsc over test/
pnpm run lint       # eslint over src/ and test/
pnpm run format     # prettier (CI runs format:check)
pnpm test           # e2e suite, driving src/index.mjs as a subprocess
pnpm run validate   # the env + security scripts CI runs
```

There is no build step: `src/*.mjs` is what ships.

## Layout

```
src/            THE PACKAGE — everything that ships
  index.mjs     bin entry: init | run | learn | REPL; config, MCP connect, turns, shutdown
  init.mjs      `yama init` scaffold — never overwrites
  learn.mjs     the deterministic git write after a learn turn
.yama/          this repository's OWN Yama setup (dogfood) — CI runs `yama` from here
  config.json   provider/model chains, timeouts, memory, learn
  MCP.json      MCP servers for this repository's reviews
  prompts.json  the review prompts
  skills/       on-demand skills (repo-conventions, github-commenting)
  memory/       hippocampus.sqlite — committed, written only by `yama learn`
test/           run.ts (driver + harness) and suite-reviewer.ts
scripts/        commit-message, env and security validators run by CI and git hooks
action.yml      composite action consumers use
```

## Critical rules

1. **Tests are end-to-end only.** Suites drive `src/index.mjs` as a subprocess and
   never import a `src/` module. The only skip signal is `throw new Skip(reason)`.
2. **`yama learn` is the only writer**, and it stages exactly the memory database —
   verified by reading the staged set back out of git. No force push, no credential in a
   remote URL, `[skip ci]` in the subject, gated by `config.learn`.
3. **A failed prompt fails the run.** An aborted review must never read as a clean one.
4. **No silent catch.** Optional subsystems (memory, the code graph) may degrade, but every
   failure logs a warning naming the subsystem and the reason.
5. **No secrets in code, config, tests or docs.** Credentials are referenced by environment
   variable NAME only — see `.env.example`. Attacker-controllable values (branch names,
   inputs) reach shells through env vars, never template interpolation.
6. **Config stays backward compatible.** New `config.json` keys are optional with
   behaviour-preserving defaults; `yama init` output and `action.yml` inputs are a public
   contract.
7. **Timeouts are hang detectors and come from config** (`config.timeouts`). No step or
   token budgets beyond what `config.json` declares.

## Conventions

- ESM everywhere, pnpm. Node is pinned to patched releases in `engines` (22.23.4+,
  24.22.1+, 26.12.1+); raise the floor with each Node security release.
- The root `package.json` is the one dependency manifest. `@juspay/neurolink` is pinned
  EXACTLY (it ships many releases a week, and an `npx` install ignores our lockfile), and
  `pnpm-workspace.yaml` refuses versions under 3 days old except `@juspay/*`. Each
  `pnpm.overrides` entry exists to clear an audit advisory: re-check them with `pnpm audit`
  when bumping NeuroLink, and drop any that no longer change the result.
- `src/` is product code and must not depend on anything in `.yama/`; `.yama/` is
  configuration only — no code. A behaviour change for every consumer goes in `src/` (or
  the `yama init` scaffold); a change to how THIS repository is reviewed goes in `.yama/`.
- Conventional Commits, and one commit per pull request — see
  `.github/SINGLE_COMMIT_POLICY.md`. Releases are generated from the commit history.
- Never commit or push unless you were asked to.
