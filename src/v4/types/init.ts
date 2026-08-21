/**
 * Types for the init layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { MergeStrategy } from "./merge.js";

export type DetectedProject = {
  /** From the git remote. */
  provider?: "github" | "bitbucket" | "gitlab" | "unknown";
  remoteUrl?: string;
  /** Language ecosystem, from manifest files present. */
  stacks: string[];
  /** Commands worth offering as checks. */
  candidateChecks: Array<{ id: string; run: string; parse?: string }>;
  ci?: "github-actions" | "bitbucket-pipelines" | "jenkins" | "gitlab-ci";
  hasCodeowners: boolean;
  codeownersPath?: string;
  /** A v3 config that should be migrated rather than replaced. */
  legacyConfigPath?: string;
};

export type InitAnswers = {
  provider: string;
  /** Env var holding the VCS token. Named, never the value. */
  tokenEnv: string;
  aiProvider: string[];
  aiModel: string[];
  dryRunFirst: boolean;
  /** Check ids the operator chose to enable. */
  enabledChecks: string[];
  importCodeowners: boolean;
  mergeStrategy?: MergeStrategy;
};

export type InitPlan = {
  files: Array<{ path: string; content: string }>;
  /** Secrets the operator must set in CI, by name. */
  requiredSecrets: string[];
  /** What to do next, in order. */
  nextSteps: string[];
  warnings: string[];
};
