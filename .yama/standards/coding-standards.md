# Yama coding standards (review context)

These are the reviewer-expectation standards for the Yama codebase. Treat items
marked **[BLOCKING]** as blocking criteria for a PR.

## Architecture

- **[BLOCKING] Config-driven, no hardcoding.** MCP servers, their commands/URLs,
  and tool filtering (`blockedTools`/`allowedTools`) must come from config. Do
  NOT hardcode tool names, provider tool vocabularies, or provider special-casing
  in the codebase. New behaviour that a user might want to change belongs in config.
- The system/review prompt should describe the reviewer's **intent and method**
  (standards-first, verify before claiming, file-by-file, severity, be actionable)
  and use whatever tools it is given — not enumerate specific tool names.
- Keep the orchestrator thin; parsing/decision/registry logic lives in its own
  module (`ReviewResultParser`, `reviewDecision`, `McpRegistry`, `NeuroLinkFactory`).

## Security

- **[BLOCKING]** No secrets in code, logs, prompts, or committed files. Secrets
  come from the environment (`${VAR}` substitution).
- **[BLOCKING]** Never execute untrusted, checkout-controlled input as a command.
  Trust gates (e.g. `YAMA_ENABLE_PROJECT_MCP`) must be read from the real
  environment, not from a checkout-local `.env`.
- Validate/normalise external data (AI responses, YAML/JSON config) before use;
  guard `JSON.parse`; no prototype-pollution-prone deep merges.

## TypeScript / ESM

- ESM only (`"type": "module"`); import paths end in `.js`.
- Avoid `any` on public/exported surfaces; prefer precise types.
- No unused exports or dead code (`no-unused-vars` is enforced).
- Errors are surfaced, not silently swallowed; distinguish `ENOENT` from real I/O errors.

## Testing

- New pure logic (parsers, decision policy, registry helpers) has focused unit tests.
- Behaviour-preserving refactors keep existing tests green; snapshot the output of
  prompt-producing code before restructuring it.
