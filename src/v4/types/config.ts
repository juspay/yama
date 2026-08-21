/**
 * Yama v4 configuration types.
 *
 * The config is a FILE TREE, not one document. Only `yama.yaml` and `mcp.yaml`
 * are required; every other file resolves to a behaviour-preserving default so a
 * repo with two files still gets a working review.
 *
 * Nothing here ever becomes prompt text. Config drives tools, guardrails, and
 * deterministic stages — the agent discovers project context through tools.
 */

import type { ModelSlotConfig } from "./model.js";
import type { PromptsConfig } from "./prompts.js";
import type { ImpactLogEntry, ProductCapability } from "./product.js";
import type { DeletionPolicy } from "./changeset.js";

// ─────────────────────────────────────────────────────────────────────────────
// yama.yaml — required
// ─────────────────────────────────────────────────────────────────────────────

export type YamaFile = {
  version: 4;
  /** Base model chain; every slot inherits from it. */
  ai: ModelSlotConfig & YamaModelSlots;
  learn?: LearnConfig;
  state?: StateConfig;
  observability?: ObservabilityConfig;
  /** Optional prompt management. Absent means every prompt is the shipped text. */
  prompts?: PromptsConfig;
  /** Inherit another config tree (org baseline) before local files apply. */
  extends?: string;
};

/** Per-role model overrides. Each inherits `ai` when absent. */
export type YamaModelSlots = {
  review?: ModelSlotConfig;
  subAgent?: ModelSlotConfig;
  judge?: ModelSlotConfig;
  scorecard?: ModelSlotConfig;
  description?: ModelSlotConfig;
  extraction?: ModelSlotConfig;
  /** Drives NeuroLink's summarization pair, which context compaction uses. */
  compaction?: ModelSlotConfig;
  /** Drives the condensed per-repo memory writer. */
  memory?: ModelSlotConfig;
  /**
   * Runtime tool names to drop before the agent ever sees them.
   *
   * The provider runtime registers its own file-reading tools. They are not
   * sandboxed to the repository and they duplicate Yama's read_file /
   * list_files / search_code — two tools doing the same job differently is a
   * worse prompt and a hole in the sandbox at once.
   *
   * Names live in config, not code: they are the runtime's vocabulary, not
   * Yama's logic (rule 7). Absent means nothing is excluded, which preserves
   * existing behaviour (rule 12).
   */
  excludeRuntimeTools?: string[];
};

export type LearnConfig = {
  /** merge-event is the only trigger that reliably identifies the merged PR. */
  trigger?: "merge-event" | "push" | "disabled";
  /** Detected by `yama init`; determines how a PR number is recovered. */
  mergeStrategy?: "squash" | "merge" | "rebase";
  /** Direct commit, or open a bot PR when the branch is protected. */
  mode?: "commit" | "pull-request";
  /** Author identity used for commits and for trusting comment markers. */
  botIdentity?: string;
  git?: LearnGitConfig;
};

export type LearnGitConfig = {
  auth?: "ssh" | "https";
  /** Env var holding the private key PEM body (never a path in config). */
  sshKeyEnv?: string;
  userEnv?: string;
  tokenEnv?: string;
  remote?: string;
  branch?: string;
};

export type StateConfig = {
  enabled?: boolean;
  /** Where PR artifacts and cross-run state live, relative to the repo root. */
  path?: string;
};

export type ObservabilityConfig = {
  enabled?: boolean;
  /** Report artifact directory, relative to the repo root. */
  reportPath?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// mcp.yaml — required
// ─────────────────────────────────────────────────────────────────────────────

export type McpFile = {
  servers: Record<string, McpServerConfig>;
};

/**
 * A connection. Yama code never names a tool — it asks for a capability and this
 * map supplies the tool name, so any MCP server can back any capability.
 */
export type McpServerConfig = {
  enabled?: boolean;
  transport?: "stdio" | "http" | "sse" | "websocket";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * capability name → the tool on this server that provides it.
   *
   * A bare string is the tool name. The object form adds arguments that are
   * merged into every call: modern VCS servers consolidate many operations
   * behind one tool selected by a parameter, and the parameter belongs in
   * config with the tool name, never in Yama's code.
   */
  capabilities?: Partial<Record<CapabilityName, CapabilityBinding>>;
  /** Stages during which this server's tools are exposed. Default: all. */
  stages?: StageName[];
  /** Which agents may use it. Default: both. */
  roles?: McpRole[];
  /** Denylist applied at registration. */
  blockedTools?: string[];
  /** Fail-closed allowlist: everything the server advertises outside it is blocked. */
  allowedTools?: string[];
  timeout?: number;
  retryConfig?: McpRetryConfig;
  /** Anything else is passed through to NeuroLink verbatim. */
  [passthrough: string]: unknown;
};

/** How a capability maps onto a tool: a name, or a name plus fixed arguments. */
/**
 * Runtime tools to drop before the agent sees them.
 *
 * The provider runtime registers its own file-reading tools. They are not
 * sandboxed to the repository and they duplicate Yama's, so a project keeps this
 * list populated. Names live here rather than in code because they belong to the
 * runtime's vocabulary, not to Yama's logic (rule 7).
 */
export type CapabilityBinding =
  | string
  | { tool: string; args?: Record<string, unknown> };

export type McpRole = "main" | "sub";

export type McpRetryConfig = {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
};

/**
 * Every capability Yama's code can request. Adding one here is the only way to
 * make new deterministic behaviour possible — never a hardcoded tool name.
 */
export type CapabilityName =
  | "readPullRequest"
  | "findPullRequest"
  | "listComments"
  | "listApprovals"
  | "listChangedFiles"
  | "beginReview"
  | "postInlineComment"
  | "submitReview"
  | "updateComment"
  | "postSummary"
  | "resolveComment"
  | "setStatus"
  | "updateDescription"
  | "listMergedPullRequests"
  | "codeIntel"
  | "readTicket";

// ─────────────────────────────────────────────────────────────────────────────
// review.yaml — optional
// ─────────────────────────────────────────────────────────────────────────────

/** One section the enhanced description must carry. */
export type DescriptionSection = {
  title: string;
  /** When true, S5 fails if the section is absent from the posted description. */
  required?: boolean;
};

export type DescriptionConfig = {
  sections?: DescriptionSection[];
};

export type ReviewFile = {
  concurrency?: ConcurrencyConfig;
  verdict?: VerdictConfig;
  stages?: StageToggles;
  remediation?: RemediationConfig;
  /** Paths never reviewed. Enforced in code, not requested in a prompt. */
  excludePatterns?: string[];
  maxFiles?: number;
  /** Inline judge acceptance threshold, 0-100. Default 80. */
  confidenceThreshold?: number;
  /** Only comment on lines the pull request changed. Default true. */
  changedLinesOnly?: boolean;
  /** Deleted-file policy. Default "content" (review them, as before). */
  deletions?: DeletionPolicy;
  /** Steps per turn before a supervisor checkpoint. Absent = uncapped. */
  maxStepsPerTurn?: number;
  /** What the enhanced description must contain, verified by re-reading it. */
  description?: DescriptionConfig;
  /** Optional hard run deadline. No default — reviews are bounded by work. */
  deadline?: string;
};

export type ConcurrencyConfig = {
  power?: ConcurrencyPower;
};

export type ConcurrencyPower = "high" | "medium" | "low";

export type VerdictConfig = {
  /** Some teams want review without an approve/block decision. */
  enabled?: boolean;
  blockOn?: VerdictBlockReason[];
  /** MAJOR findings at or above this count block. Default 3. */
  majorThreshold?: number;
};

export type VerdictBlockReason =
  | "CRITICAL"
  | "MAJOR_THRESHOLD"
  | "blocking-rule"
  | "blocking-check"
  | "unapproved-ownership";

export type StageToggles = {
  checks?: boolean;
  enhance?: boolean;
};

export type RemediationConfig = {
  /** Re-prompts allowed per failing stage before it is marked degraded. */
  maxAttemptsPerStage?: number;
};

/** The stage machine's stages, in order. */
export type StageName =
  | "resolve"
  | "orient"
  | "review"
  | "post"
  | "checks"
  | "enhance"
  | "verdict";

// ─────────────────────────────────────────────────────────────────────────────
// checks.yaml — optional
// ─────────────────────────────────────────────────────────────────────────────

export type ChecksFile = {
  enabled?: boolean;
  /** Run checks on pull requests from forks. Default false — untrusted code. */
  allowForks?: boolean;
  checks: CheckConfig[];
};

export type CheckConfig = {
  id: string;
  enabled?: boolean;
  /** Shell command. Mutually exclusive with `type`. */
  run?: string;
  /** Built-in check. Mutually exclusive with `run`. */
  type?: BuiltinCheckName;
  /** Extra config for a built-in check (e.g. the ownership policy path). */
  source?: string;
  parse?: CheckParser;
  /** Free-text guidance for `parse: agent`, describing the output shape. */
  hint?: string;
  when?: CheckCondition;
  /** Parser severity label → Yama severity. */
  severity?: Record<string, FindingSeverity>;
  scope?: CheckScope;
  /** Cap on posted findings; the remainder is rolled up in the summary. */
  maxFindings?: number;
  blocking?: boolean;
  timeoutMs?: number;
  workingDirectory?: string;
};

export type BuiltinCheckName = "builtin.owners";

export type CheckParser =
  | "sarif"
  | "eslint"
  | "tsc"
  | "junit"
  | "regex"
  | "agent";

export type CheckCondition = {
  paths?: string[];
};

export type CheckScope = "changed-lines" | "changed-files" | "repo";

// ─────────────────────────────────────────────────────────────────────────────
// policy/ownership.yaml — optional
// ─────────────────────────────────────────────────────────────────────────────

export type OwnershipFile = {
  rules: OwnershipRule[];
};

export type OwnershipRule = {
  id: string;
  paths: string[];
  owners: string[];
  minApprovals?: number;
  /** Block the verdict until the required approvals exist. */
  blocking?: boolean;
  reason?: string;
  /** CODEOWNERS semantics: the last matching rule wins instead of unioning. */
  exclusive?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// policy/guards.yaml — optional
// ─────────────────────────────────────────────────────────────────────────────

export type GuardsFile = {
  guards: GuardRule[];
};

export type GuardRule = {
  id: string;
  paths: string[];
  /** No finding in these paths may be reported below this severity. */
  severityFloor?: FindingSeverity;
  /** Check ids that must pass for changes in these paths. */
  requireChecks?: string[];
  /** Touching these paths at all is a finding. */
  forbid?: boolean;
  reason?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// rules/*.yaml — optional
// ─────────────────────────────────────────────────────────────────────────────

/** A rule file holds one rule or a `rules:` array. */
export type RulesFile = { rules: RuleEntry[] } | RuleEntry;

/**
 * A rule as the agent receives it through `recall`. Fields mirror what lexical
 * retrieval ranks on: title and summary carry the signal, aliases and keywords
 * widen recall, paths scope it.
 */
export type RuleEntry = {
  id: string;
  title: string;
  summary: string;
  domain?: string;
  paths?: string[];
  severity?: FindingSeverity;
  blocking?: boolean;
  /** One concrete example beats three paragraphs of description. */
  example?: string;
  aliases?: string[];
  keywords?: string[];
  status?: RuleStatus;
  /** Ranking weight; grows as `yama learn` observes recurrences. */
  weight?: number;
  occurrences?: number;
  authors?: number;
  evidence?: string[];
};

export type RuleStatus = "active" | "candidate" | "dormant" | "suppressed";

export type FindingSeverity = "CRITICAL" | "MAJOR" | "MINOR" | "SUGGESTION";

// ─────────────────────────────────────────────────────────────────────────────
// The resolved configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the runtime reads, with every optional file resolved to a concrete
 * default. Consumers never check whether a file existed — absence is already
 * expressed as a no-op value here.
 */
export type ResolvedConfig = {
  version: 4;
  ai: YamaFile["ai"];
  learn: Required<Pick<LearnConfig, "trigger" | "mode">> & LearnConfig;
  state: Required<StateConfig>;
  observability: Required<ObservabilityConfig>;
  prompts: PromptsConfig;
  mcp: McpFile;
  review: Required<
    Pick<
      ReviewFile,
      | "excludePatterns"
      | "maxFiles"
      | "confidenceThreshold"
      | "changedLinesOnly"
      | "deletions"
    >
  > & {
    maxStepsPerTurn?: number;
    concurrency: Required<ConcurrencyConfig>;
    verdict: Required<Omit<VerdictConfig, "blockOn">> & {
      blockOn: VerdictBlockReason[];
    };
    stages: Required<StageToggles>;
    remediation: Required<RemediationConfig>;
    description: DescriptionConfig;
    deadline?: string;
  };
  checks: Required<Pick<ChecksFile, "enabled" | "allowForks">> & {
    checks: CheckConfig[];
  };
  ownership: OwnershipRule[];
  guards: GuardRule[];
  rules: RuleEntry[];
  /**
   * The product capability map, from `.yama/product/capabilities.yaml`.
   *
   * Generated by `bootstrap` and refined by `learn`. Empty means impact
   * analysis degrades to caller tracing, which is the documented behaviour when
   * the file is absent — never an error.
   */
  product: ProductCapability[];
  /** Per-merge impact ledger, from `.yama/product/impact-log/`. */
  impactLog: ImpactLogEntry[];
  /** Absolute repo root every relative path resolves against. */
  projectRoot: string;
  /** Diagnostics surfaced by the loader — never thrown, always reported. */
  notices: ConfigNotice[];
};

export type ConfigNotice = {
  level: "info" | "warn";
  message: string;
};
