/**
 * Types for the gitsafe layer.
 */

export type GitCommandCheck =
  | { allowed: true; subcommand: string; args: string[] }
  | { allowed: false; reason: string };
