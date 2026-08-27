# Type rules

The type rulings are mostly MECHANICAL here — `pnpm run lint` fails the build on them, with
a file and a line, before a review ever looks. This file exists to say which half is which,
so a review spends its comments on the half a linter cannot see.

## Lint's job, not a reviewer's

These are ESLint errors. If one is broken the `lint` check has already said so on the exact
line; commenting on it again is noise, and a review that mostly restates lint output teaches
everyone to skim it.

| Ruling                                                | Enforced by                                      |
| ----------------------------------------------------- | ------------------------------------------------ |
| No `interface` — `type` with `&`, never `extends`     | `@typescript-eslint/consistent-type-definitions` |
| No `Type`/`Types` suffix on filenames in `src/types/` | `yama/no-types-suffix-filename`                  |
| Exported type names unique across `src/types/`        | `yama/unique-type-names`                         |
| The barrel is `export *` lines and nothing else       | selectors on `src/types/index.ts`                |
| No `types/` folder or `types.ts` outside `src/types/` | `yama/no-local-types-folder`                     |
| No type defined or re-exported outside `src/types/`   | `yama/no-type-export-outside-types`              |
| Internal types imported from the barrel only          | `yama/barrel-type-imports`                       |
| No `any`, no `as unknown as T`                        | `no-explicit-any`, selectors                     |
| Only `src/engine/` imports `@juspay/neurolink`        | `no-restricted-imports` + selector               |

The one thing worth a comment about the list above: a change that ADDS an
`eslint-disable` for any of them. The comment has to say why the rule is wrong here, and
"it was easier" is not why.

---

### `types.right-file-in-the-types-folder` — the folder is enforced, the file is not

**Severity: MINOR.** Paths: `src/types/**`.

Lint proves an exported type lives in `src/types/`. It cannot tell whether it landed in the
right file. `src/types/` is split by domain — `config.ts`, `platform.ts`, `stages.ts`,
`gates.ts`, `store.ts`, `tools.ts`, `run.ts` — and a store type filed under `run.ts` is
found by nobody and duplicated by the next person.

Same reviewer's question in the other direction: does this new type already exist under
another name? The barrel makes every type visible from one import, which makes a duplicate
easy to write and hard to notice.

---

### `types.inferred-from-the-schema` — the zod schema is the source of truth

**Severity: MAJOR.** Paths: `src/types/config.ts`, `src/types/stages.ts`,
`src/types/store.ts`.

Where a shape is validated by zod, its type is INFERRED from the schema (`z.infer<…>`),
never hand-written alongside it. A hand-written twin drifts on the first field added to one
of them, and the drift shows up as a runtime value that does not match its own type — with
the compiler agreeing that everything is fine.

The direction of the dependency is fixed: `src/config/schema.ts` is the single source of
truth for the config surface, and it may not import from the types barrel.

---

### `types.assertions-carry-a-reason` — `as` on data from outside is a claim

**Severity: MAJOR.** Paths: `src/**/*.ts`.

A double assertion is banned by lint. A SINGLE `as` is still an unchecked claim when the
value came from outside the program — an MCP tool result, a model response, a YAML
document, a JSON file in the run store. Those get a runtime-validating guard or a zod parse,
not an assertion.

`as` on a value the program itself just built is fine and not a finding.

---

### `types.no-optional-to-dodge-a-decision` — `?` means genuinely absent

**Severity: MINOR.** Paths: `src/types/**`.

An optional field should mean "this may legitimately not exist" — an unmapped capability, a
rulebook with no index. Making a field optional because filling it in three call sites was
tedious pushes an `if (x === undefined)` into every reader, and one of them will get it
wrong. Prefer a union that names the states, or a required field with an explicit default.
