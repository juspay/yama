/**
 * Types for the posting layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { StageName } from "./config.js";
import type { IdentifiedFinding, PostedFinding } from "./findings.js";
import type { RunMode } from "./run.js";
import type { CapabilityResolver } from "../connections/Capabilities.js";

/** Executes a capability's tool. Injected so this layer is testable offline. */
export type ToolInvoker = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export type PostingContext = {
  resolver: CapabilityResolver;
  invoke: ToolInvoker;
  mode: RunMode;
  stage: StageName;
  /** Identity whose markers are trusted, and whose comments may be edited. */
  botIdentity?: string;
  /** Identifiers the VCS tools need. Passed through verbatim. */
  target: Record<string, unknown>;
};

export type PostOutcome = {
  posted: PostedFinding[];
  /** Findings that could not be posted, with why. Never silently dropped. */
  failures: Array<{ finding: IdentifiedFinding; error: string }>;
  skipped: number;
};

export type SummaryPostResult = {
  status: "created" | "updated" | "skipped" | "failed";
  commentId?: string;
  error?: string;
};
