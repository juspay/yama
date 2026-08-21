/**
 * Types for the sandbox layer.
 */

export type SandboxCheck =
  | { allowed: true; absolutePath: string }
  | { allowed: false; reason: string };
