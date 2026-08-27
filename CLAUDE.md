# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Yama (`@juspay/yama`) is an autonomous, checklist-driven pull-request review agent built on
`@juspay/neurolink`. One main session works a stage flow (WarmUp → Task Insertion → Work →
Collate → Delivery), delegating investigations to workers whose full reports are banked to
files. Deterministic **gates** sit between the stages. It ships as an ESM library, a CLI
(`yama init | doctor | review | learn`) and a composite GitHub Action.

[README.md](./README.md) is the product; this file is the rulings.

## Commands

```bash
pnpm install
pnpm run check      # tsc over src/ and test/  (alias: pnpm run type-check)
pnpm run lint       # the rulings below — lint ERRORS, not preferences
pnpm run format     # prettier (CI runs format:check)
pnpm run build      # tsc → dist/
pnpm test           # e2e suites, driving the BUILT cli — build first
pnpm run validate   # the env + security scripts CI runs
```

`pnpm test` drives `dist/`. A stale `dist/` is a lying test run: build, then test.

## Layout

```
src/
  cli/        yargs entry, exit codes. The only place allowed to write to stdout.
  config/     .yama/ loading, zod schema, capability ids, env + model chains
  core/       session runner, review/learn/doctor/init, run report, instruction
  engine/     THE SEAM — the only directory that may import @juspay/neurolink.
              native/ uses the engine's own primitives; fallback/ implements the
              same shapes locally when the engine build lacks them.
  gates/      the deterministic checks between stages: schema, checklist
              completeness, marker dedup, posted-=-confirmed, recurrence,
              verdict, exit code
  platform/   capability → tool resolution, connect, startup probe, comments
  stages/     one module per stage, plus its structured-output schema
  store/      .yama/artifacts/ run store — stage outputs, worker reports, ledger
  tools/      git (read-only allowlist), fs, checks, markers, memory, gitWriter
  types/      ALL exported types. Barrel at index.ts.
  util/       small leaf helpers with no product knowledge
test/         e2e suites and fixtures; run.ts is both driver and harness
templates/    what `yama init` scaffolds into a consumer repository
eslint-rules/ the custom ESLint rules enforcing the type rulings
```

## Critical rules

Non-negotiable. Rules 1–8 are enforced by ESLint and mirror `@juspay/neurolink`'s
conventions; the rest are design rulings that reviews enforce.

1. **Zero `interface` — always `type`.** Intersection (`&`), never `extends`.
2. **Every exported type lives in `src/types/`.** Never a `types/` folder or a `types.ts`
   inside a feature directory, and never a type exported from a feature module. Helper types
   local to one file are fine.
3. **No "Type"/"Types" suffix in `src/types/` filenames.** The folder is the types folder:
   `config.ts`, not `config.types.ts`.
4. **Exported type names are unique across `src/types/`** — the barrel would collide.
   Disambiguate at the source with a domain prefix (`McpServerConfig`, `StoreLayout`).
5. **The barrel is `export *` only.** `src/types/index.ts` holds nothing but
   `export * from "./file.js"` lines — no selective or aliased re-export, no local type.
6. **Internal types are imported from the barrel** (`../types/index.js`) by everything outside
   `src/types/`; files inside it import each other directly. Library types (`zod`, engine
   types via the seam) import normally.
7. **Only `src/engine/` may import `@juspay/neurolink`** — statically or dynamically.
   Everything else talks to the engine through the seam, so an engine primitive can move
   without touching product code. Same rule, and the same reason, as NeuroLink's own `ai` seam.
8. **No `any`, and no double assertion** (`as unknown as T`). Fix the type at the source, or
   narrow with a runtime-validating guard.
9. **No tool, server or provider name in `src/`** outside `src/platform/registry.ts` and
   `templates/`. Code asks for a CAPABILITY; `.yama/mcp.yaml` maps it to a tool. If a change
   needs to know a tool name, the name belongs in config. The diff is the deliberate exception
   and is never a capability: git gives it on every forge.
10. **The verdict is code-derived, never model-trusted.** It is a pure function of the open
    findings and the `verdict:` block, so what a run decided is auditable from configuration
    alone. A prompt-injected "approve" must never clear a blocking finding, and a partial run
    never approves.
11. **A tool call is not a comment.** A finding counts as posted only when a tool RESULT
    returned an id. Claimed-but-not-posted is what turns one posting failure into permanent
    silence about a real defect.
12. **Pending tasks = incomplete review.** The checklist gate is deterministic: the shell sees
    pending items and puts them back in front of the agent (finish, delegate, or close with a
    reason). Never a model asked whether it is done.
13. **Every model call is schema-bound.** Structured output, or a schema on the turn — never
    JSON parsed out of prose. A response that does not validate fails that member and the chain
    advances; it never becomes an empty result.
14. **`--dry-run` is side-effect free.** Every new write path checks the run mode first.
15. **`yama learn` is the only writer**, and it stages `.yama/` only — verified by reading the
    staged set back out of git. No force push, no credential in a URL, `[skip ci]` in the
    subject, and a same-commit loop check.
16. **No silent catch.** Optional subsystems degrade, but every failure logs or surfaces a
    warning. `catch {}` that hides a cause is how a broken run becomes indistinguishable from a
    clean one.
17. **No budgets.** No turn count, no step cap, no token budget — adding one is a design
    change, not a fix. The agent decides when it is done and the gates verify it. Timeouts
    exist only as hang detectors, and come from config.
18. **Config stays backward compatible.** New keys are optional with behaviour-preserving
    defaults; a rename gets a loud validation error carrying the copy-paste fix.

## Tests

End-to-end only, and they drive what ships: the built CLI (`dist/cli/index.js`) or the built
library entry (`dist/index.js`). Importing out of `src/` to assert on an internal is a unit
test and does not belong here — and mixing `src/` with `dist/` in one suite breaks object
identity silently.

- One module graph per suite: everything from `dist/`.
- The only skip signal is `throw new Skip(reason)`. No message sniffing, ever.
- Keep captured payloads out of assertion messages; describe the discrepancy instead.
- Sanity-check a new suite by breaking one assertion on purpose: it must report `✗` and exit
  non-zero, never `⊘`.
- `test/fixtures/` is review INPUT — deliberately bad code and, in one case, deliberately
  unparseable config. It is excluded from lint and from prettier on purpose. Do not "fix" it.

Register a new suite in `test/run.ts`, which is the driver and the harness both.

## Conventions

- ESM everywhere, `.js` extensions on relative imports (NodeNext), Node >= 22, pnpm.
- `zod` is pinned to an EXACT version, matching the copy NeuroLink resolves. Two zod minors
  give two structurally incompatible `ZodType`s and the engine seam stops typechecking. When
  NeuroLink moves zod, move this pin in the same change.
- Conventional Commits, and one commit per pull request — see
  `.github/SINGLE_COMMIT_POLICY.md`. Releases are generated from the commit history.
- Never commit or push unless you were asked to.
- No secrets in code, config, tests or docs. Credentials are referenced by environment
  variable NAME only — see `.env.example`.
