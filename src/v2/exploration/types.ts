import { ExplorationResult } from "../types/v2.types.js";

export interface ExploreContextInput {
  task: string;
  focus?: string[];
}

export interface ExploreRuntimeContext {
  sessionId: string;
  mode: "pr" | "local";
  workspace: string;
  repository: string;
  provider?: string; // "github" | "bitbucket" (defaults to "bitbucket" for backward compatibility)
  pullRequestId?: number;
  branch?: string;
  dryRun?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ExplorerSupportingContext {
  projectRules: string | null;
  projectStandards: string | null;
  knowledgeBase: string | null;
  repositoryMemory: string | null;
}

export interface ExploreExecutionResult {
  result: ExplorationResult;
  cached: boolean;
}
