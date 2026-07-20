# Dependency audit — residual advisories (F6)

`pnpm audit --prod` is run in CI (advisory, non-blocking). This documents the
residual advisories and why they remain, so the report is auditable rather than
silently ignored.

## Fixed via `pnpm.overrides`

| Advisory                                       | Override   |
| ---------------------------------------------- | ---------- |
| protobufjs (**critical**, prototype pollution) | `>=7.5.5`  |
| jws (high)                                     | `>=4.0.1`  |
| form-data (high)                               | `>=4.0.6`  |
| @grpc/grpc-js (high)                           | `>=1.13.5` |
| adm-zip (high)                                 | `>=0.6.0`  |

No **critical** advisories remain.

## Residual highs (as of this writing: 49→44 after overrides)

The remaining high advisories are all **transitive** and fall into two buckets:

1. **Unused NeuroLink features.** NeuroLink pulls in a proxy/gateway + voice-agent
   (LiveKit) stack — `hono`, `@hono/node-server`, `express-rate-limit`,
   `music-metadata`, `ws`, and their deps. Yama uses NeuroLink only for
   `generate()` + MCP tool calling, so these code paths are not reached. They can
   only be cleared by an upstream NeuroLink dependency bump.
2. **Constrained pins.** `undici` is pinned to `~7.22.0` for Node 20 compatibility
   (see the `fix(deps): pin undici to 5.x/Node 20` history); moving it to the
   patched `>=7.24.0` needs a compatibility check on the CI Node version. `axios`
   (via the Bitbucket MCP server) needs the MCP server itself upgraded.

## Action items (time-bounded)

- Track a NeuroLink release that bumps the proxy/LiveKit transitive deps, then drop
  the corresponding advisories.
- Re-evaluate the `undici` pin against the current Node floor (`>=20.18.1`).
- Upgrade `@nexus2520/bitbucket-mcp-server` when a release ships patched `axios`.
- Do **not** blanket-override multi-major utilities (`minimatch`/`glob`/`lodash`) —
  different consumers require different majors and a global override breaks the build.
