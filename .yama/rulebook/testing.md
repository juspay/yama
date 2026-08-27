# Testing rules

This repository tests END TO END and nothing else. There is no unit-test layer, no mocking
framework, and no coverage target. `test/run.ts` is both the driver and the harness, and
every suite drives what actually ships: the built CLI (`dist/cli/index.js`) or the built
library entry (`dist/index.js`).

That is a deliberate reversal of how this repository used to test, so a review reading an
older habit into a change should say so rather than ask for it back.

---

### `test.drives-what-ships` — from `dist/`, never from `src/`

**Severity: MAJOR.** Paths: `test/**/*.ts`.

A suite that imports out of `src/` to assert on an internal is a unit test and does not
belong here. Worse, mixing `src/` and `dist/` in one suite gives two module graphs and two
copies of every class — object identity fails silently and the failure looks like a bug in
the code under test.

One module graph per suite. Everything from `dist/`. A change to a suite's imports that
breaks that rule is a finding even when the suite passes.

---

### `test.behaviour-not-shape` — assert the guarantee

**Severity: MINOR.** Paths: `test/**/*.ts`.

Assert the invariant a reader would care about: the exit code, the verdict, what reached the
pull request, which degradation was named. A test pinned to an internal shape breaks on
every refactor and protects nothing — and a test that only asserts "it did not throw" is a
smoke test wearing a suite's name.

---

### `test.skip-is-a-signal-not-a-string` — only `throw new Skip(reason)`

**Severity: MAJOR.** Paths: `test/**/*.ts`.

Skipping is explicit, typed, and carries a reason. Never infer a skip by sniffing an error
message: the day that message changes, a suite that was silently skipping starts silently
passing, or the reverse — and either way nobody notices, because the summary line looks the
same.

A new suite is sanity-checked by breaking one assertion on purpose: it must report `✗` and
exit non-zero, never `⊘`.

---

### `test.new-behaviour-is-covered` — at the seam a user would touch

**Severity: MINOR.** Paths: `src/**/*.ts`.

New behaviour ships with a suite, or an assertion added to an existing one, that would fail
without the change. Cover it where it is observable — a CLI flag, an exit code, a file the
run store wrote, a comment body — not at the function that happens to implement it.

A change with no reachable behaviour (a rename, a comment, a type-only refactor) needs no
test, and asking for one is a finding against the review, not the change.

---

### `test.fixtures-are-input` — `test/fixtures/` is deliberately bad

**Severity: MAJOR.** Paths: `test/fixtures/**`.

Fixtures are review INPUT: code with real defects in it, and in one case a config file that
deliberately does not parse. They are excluded from lint and from prettier on purpose.

Never "fix" a fixture, never lint it, and never make a suite depend on the specific wording
of a fixture's defect. A change that quietly cleans one up has removed a test's subject.

---

### `test.registered-in-the-driver` — a suite nobody runs is not a test

**Severity: MAJOR.** Paths: `test/run.ts`.

A new suite is registered in `test/run.ts`. An unregistered file under `test/` is dead
weight that will rot without ever failing, and the first person to notice will be the one
who trusted it.
