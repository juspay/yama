/**
 * Types for the gitwriter layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { LearnGitConfig } from "./config.js";

/** Runs a command. Injected so credential handling is testable without git. */
export type GitRunner = (
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type CredentialSetup = {
  /** Extra environment for git. Contains no secret VALUES — only references. */
  env: NodeJS.ProcessEnv;
  /** Remove temp files. Always called, including on failure. */
  cleanup(): void;
};

export type CommitOptions = {
  runner: GitRunner;
  cwd: string;
  config: LearnGitConfig;
  env: NodeJS.ProcessEnv;
  botIdentity: string;
  botEmail?: string;
  message: string;
  /** Paths to stage. Every one must sit under `.yama/`. */
  paths: string[];
  /** Attempts before giving up on a rejected push. */
  maxPushAttempts?: number;
};

export type CommitResult = {
  committed: boolean;
  pushed: boolean;
  sha?: string;
  /** Present when nothing needed committing. */
  reason?: string;
  attempts: number;
};
