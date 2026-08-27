/**
 * Process exit codes for the `yama` binary. CI pipelines branch on these, so they are a
 * contract — add codes, never renumber them (TASKS:Y4.5, Y6.1).
 */
export const EXIT_CODES = {
  /** Run finished; verdict `approve` or `comment`. */
  ok: 0,
  /** Run finished; verdict `block`. */
  block: 1,
  /** Bad invocation, or `.yama/` missing / invalid / a required capability unavailable. */
  configError: 2,
  /** The run itself failed — engine, MCP, platform, or check execution. */
  runError: 3,
} as const;
