/**
 * Types for the tools layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ChangeSet } from "./changes.js";
import type { CheckRunResult } from "./checks.js";
import type { GuardRule, McpRole, OwnershipRule, StageName } from "./config.js";
import type { InlineJudge } from "./judge.js";
import type { RecallEntry } from "./recall.js";
import type { FindingLedger } from "../findings/Ledger.js";

/** A tool Yama registers itself, as opposed to one an MCP server provides. */
export type YamaTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Stages in which this tool is exposed. */
  stages: StageName[];
  /** Roles that may use it. Sub-agents never post. */
  roles: McpRole[];
  execute(params: Record<string, unknown>): Promise<unknown>;
};

export type ToolDependencies = {
  entries: RecallEntry[];
  changeSet?: ChangeSet;
  ledger: FindingLedger;
  guards: GuardRule[];
  ownership: OwnershipRule[];
  checkResults: CheckRunResult[];
  approvals?: string[];
  author?: string;
  alreadyReported: ReadonlySet<string>;
  suppressed: ReadonlySet<string>;
  checkFlagged: ReadonlySet<string>;
  confidence?: ReadonlyMap<string, number>;
  /**
   * Scores gate-surviving findings before they are accepted. Absent means the
   * project turned scoring off, which is a valid configuration and not a
   * degraded one.
   */
  judge?: InlineJudge;
  /** Where the judge's own warnings go, so a degraded pass is never silent. */
  onWarnings?: (warnings: string[]) => void;
  confidenceThreshold: number;
  changedLinesOnly: boolean;
  dryRun: boolean;
};

/** What the workspace tools need from the environment. */
export type WorkspaceToolOptions = {
  projectRoot: string;
  timeoutMs?: number;
};
