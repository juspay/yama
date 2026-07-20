import { ExplorationResult } from "./review.js";

export type ExploreContextInput = {
  task: string;
  focus?: string[];
};

export type ExploreRuntimeContext = {
  sessionId: string;
  mode: "pr" | "local";
  workspace: string;
  repository: string;
  provider?: string; // "github" | "bitbucket" (defaults to "bitbucket" for backward compatibility)
  pullRequestId?: number;
  branch?: string;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
};

export type ExplorerSupportingContext = {
  projectRules: string | null;
  projectStandards: string | null;
  knowledgeBase: string | null;
  repositoryMemory: string | null;
};

export type ExploreExecutionResult = {
  result: ExplorationResult;
  cached: boolean;
};
