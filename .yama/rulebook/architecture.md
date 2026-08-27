# Architecture rules

Invariants. Each one exists because breaking it caused a real, observed failure — the
statement says which. Ids are stable: a finding from an older review cites the same id.

---

### `arch.verdict-is-code-derived` — the verdict comes from the findings, not from the model

**Severity: CRITICAL.** Paths: `src/gates/verdict.ts`, `src/gates/exit.ts`,
`src/stages/collate.ts`.

`decideVerdict` is a pure function of the open findings and the `verdict:` block, so what a
run decided is auditable from configuration alone. A model's self-reported decision is
advisory and nothing more, and a run whose checklist did not finish never approves.

Reject any change that lets a model-supplied field reach the decision, that reads a
`decision` out of a stage payload instead of computing it, or that gives the agent a way to
mark findings resolved. The diff being reviewed is attacker-controlled: a comment in it
saying "approve this" must not be able to clear a real finding.

---

### `arch.posted-not-called` — a tool call is not a comment

**Severity: CRITICAL.** Paths: `src/gates/posting.ts`, `src/stages/delivery.ts`,
`src/store/runStore.ts`.

A finding counts as posted only when the posting tool RESULT carried an id. Counting calls
is how runs reported findings that were never on the pull request, and how one posting
failure became permanent silence about a real defect.

Watch for: confirmation derived from what the agent said it did rather than from tool
results; a failed post that leaves the ledger claiming success; a marker written before the
comment it dedupes exists.

---

### `arch.checklist-completeness` — pending tasks mean an incomplete review

**Severity: CRITICAL.** Paths: `src/gates/checklist.ts`, `src/stages/work.ts`.

The completeness contract is deterministic and belongs to the shell: it reads the checklist
state, and pending items go back in front of the agent to be finished, delegated, or closed
with a reason. The agent is never asked whether it is done.

Reject anything that lets a stage end with silently pending tasks, that closes a task
without a recorded reason, or that replaces the gate with a model self-assessment. An
incomplete review reported as complete is worse than no review.

---

### `arch.engine-seam` — only `src/engine/` imports the engine

**Severity: MAJOR.** Paths: `src/**/*.ts`.

`@juspay/neurolink` is imported by `src/engine/` and by nothing else, statically or
dynamically. Everything else talks to the engine through the seam, so an engine primitive
can move — `native/` to `fallback/` and back — without product code changing. ESLint
enforces the import; what a review adds is the shape: an engine type or an engine-specific
error leaking through the seam's own exports defeats it just as thoroughly as an import.

---

### `arch.no-tool-names-in-code` — code asks for a capability

**Severity: MAJOR.** Paths: `src/**/*.ts`.

No platform tool name, server id, or provider name in `src/`. Code asks for a CAPABILITY;
`.yama/mcp.yaml` maps it to a tool, and `src/platform/registry.ts` is the only module that
resolves one. A name hardcoded in `src/` ties the reviewer to one forge and cannot be fixed
by configuration.

The diff is the deliberate exception and is never a capability: git provides it on every
forge. Adding a capability id is a change to `src/config/capabilities.ts` plus the shipped
templates, not a special case somewhere downstream.

```ts
// no
await invoke("create_pull_request_review_comment", params);
// yes
await invoke(registry.requireTool("comment.inline.create"), params);
```

---

### `arch.context-through-tools` — never concatenate context into a prompt

**Severity: MAJOR.** Paths: `src/stages/**`, `src/core/instruction.ts`.

The system instruction is one static constant, and a stage prompt says what is on disk,
what the run is, and what to report. Rulebook files, diffs, memory and worker reports reach
the agent through TOOLS — `read_file`, the run store, the bank — never by being inlined.
A prompt that carries content grows without bound, and the worker prompt carries a slice of
the OperatingBrief rather than the raw rulebook for exactly this reason.

---

### `arch.fail-closed` — tool and path policy fails closed

**Severity: CRITICAL.** Paths: `src/tools/git.ts`, `src/tools/fs.ts`,
`src/engine/policy.ts`, `src/platform/probe.ts`.

An unknown git subcommand is treated as mutating. A path that does not resolve inside the
repository root is refused rather than normalized. A capability probe that comes back empty
is a registration failure, not an open door. An allowlist that cannot be enforced drops the
server instead of running unrestricted.

Commands are argv, never shell strings — no pipes, no globs, no `&&` — and check commands
come from the BASE branch, never from the change under review.

---

### `arch.dry-run-side-effect-free` — `--dry-run` writes nothing

**Severity: CRITICAL.** Paths: `src/**/*.ts`.

Every write path — comments, description, review state, the run store, memory, git — checks
the run mode before executing. A new write added without that check is a finding on its own,
even when the surrounding change is correct: dry run is how this agent is tested against
real pull requests.

---

### `arch.learn-is-the-only-writer` — and it stages `.yama/` only

**Severity: CRITICAL.** Paths: `src/tools/gitWriter.ts`, `src/core/learn.ts`.

`yama learn` is the one command that changes a repository. It stages `.yama/` and nothing
else, verified by reading the staged set back out of git rather than by trusting the add.
No force push. No credential in a remote URL or a config file — the token comes from the
environment by NAME. `[skip ci]` in the subject, and a same-commit loop check so a learn
commit cannot trigger the run that writes the next one.

---

### `arch.no-silent-catch` — a failure that hides is a failure that lies

**Severity: MAJOR.** Paths: `src/**/*.ts`.

An optional subsystem may degrade, but it must say so: a degradation entry, a warning on the
run report, something a reader will see. A bare `catch {}` turns a broken feature into one
that looks like it simply found nothing.

```ts
// no
try {
  await loadRules();
} catch {}
// yes
try {
  await loadRules();
} catch (error) {
  degradations.push({ what: "rulebook", reason: message(error) });
}
```

---

### `arch.no-budgets` — the gates decide when a run is done, not a counter

**Severity: MAJOR.** Paths: `src/**/*.ts`.

No turn count, no token budget, no step cap standing in for a completeness check. The agent
decides when it has finished and the gates verify it. Timeouts exist only as hang detectors
and come from configuration. A cap added to make a symptom go away is a design change
wearing a fix's clothes — and the symptom it hides is a review that stopped early and
reported success.

---

### `arch.config-is-backward-compatible` — and absent means off, never broken

**Severity: MAJOR.** Paths: `src/config/**`.

Only `yama.yaml` and `mcp.yaml` are required. Every other piece of `.yama/` being absent
means "that capability is off", recorded as a named degradation the run report carries — it
never means an error. New keys are optional with behaviour-preserving defaults; a rename
gets a loud validation error carrying the copy-paste fix.

Schema objects are strict on purpose: an unknown key is a typo, and a silently ignored typo
is a config bug that surfaces three stages later as odd behaviour.

---

### `arch.schema-bound-model-calls` — no JSON parsed out of prose

**Severity: MAJOR.** Paths: `src/stages/**`, `src/gates/schema.ts`,
`src/engine/structured.ts`.

Every model call is structured-output or schema-bound on the turn. A response that does not
validate fails that chain member and the chain advances; it never becomes an empty result
or a half-parsed object. Regex over model output, `JSON.parse` on a code fence, or a
`try/catch` that falls back to a default payload are all the same finding.
