/**
 * Defaults for every optional config file.
 *
 * Absence of a file is expressed here as a concrete no-op value, so no consumer
 * ever branches on "was this file present?". That is what makes the two-file
 * minimum real: a repo with only `yama.yaml` and `mcp.yaml` runs a complete
 * review, it just runs one with no checks, no ownership, and no local rules.
 */

import type {
  ConcurrencyPower,
  ResolvedConfig,
  ReviewFile,
  StageName,
} from "../types/index.js";

/** Files that are never worth a reviewer's attention. */
export const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "**/*.lock",
  "**/*.min.js",
  "**/*.map",
  "**/*.snap",
  "**/*.svg",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/go.sum",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/composer.lock",
  "**/vendor/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
];

/**
 * Concurrency tiers.
 *
 * `pool` is the process-wide ceiling on concurrently running sub-agents;
 * `delegationsPerTurn` bounds how many the main agent may launch in one turn.
 * The agent still decides whether to fan out at all — these only cap it.
 */
export const CONCURRENCY_TIERS: Record<
  ConcurrencyPower,
  { pool: number; delegationsPerTurn: number }
> = {
  high: { pool: 8, delegationsPerTurn: 6 },
  medium: { pool: 4, delegationsPerTurn: 3 },
  low: { pool: 1, delegationsPerTurn: 1 },
};

/** Stage order. The machine walks this list. */
export const STAGE_ORDER: StageName[] = [
  "resolve",
  "orient",
  "review",
  "post",
  "checks",
  "enhance",
  "verdict",
];

export const REVIEW_DEFAULTS: Required<
  Pick<
    ReviewFile,
    | "excludePatterns"
    | "maxFiles"
    | "confidenceThreshold"
    | "changedLinesOnly"
    | "deletions"
  >
> = {
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  maxFiles: 300,
  // Matches the calibrated-confidence threshold this rubric was designed around.
  confidenceThreshold: 80,
  changedLinesOnly: true,
  // The original behaviour: deleted files are reviewed in full. "ignore" is the
  // opt-in for refactor-heavy repositories where deletions crowd out live code.
  deletions: "content",
};

/** The resolved shape of every optional block when its file is absent. */
export function optionalDefaults(): Omit<
  ResolvedConfig,
  "version" | "ai" | "mcp" | "projectRoot" | "notices"
> {
  return {
    learn: { trigger: "disabled", mode: "commit" },
    state: { enabled: true, path: ".yama/state" },
    observability: { enabled: true, reportPath: ".yama/reports" },
    // Off unless a repository configures a prompt platform: an enabled default
    // would make every run pay a network round trip for prompts it already has.
    prompts: { enabled: false, provider: "langfuse" },
    review: {
      ...REVIEW_DEFAULTS,
      concurrency: { power: "medium" },
      verdict: {
        enabled: true,
        majorThreshold: 3,
        // Every reason is on by default because each already has its own opt-in
        // upstream: a rule blocks only when it declares `blocking: true`, a check
        // only when it declares `blocking: true`, and ownership only when a rule
        // does. Requiring a second opt-in here would mean setting `blocking: true`
        // and watching nothing happen. This list is the global kill switch, not
        // the enrolment.
        blockOn: [
          "CRITICAL",
          "MAJOR_THRESHOLD",
          "blocking-rule",
          "blocking-check",
          "unapproved-ownership",
        ],
      },
      stages: { checks: true, enhance: true },
      remediation: { maxAttemptsPerStage: 2 },
      // No required sections by default: S5 then only has to prove the
      // description actually changed on the pull request, which every project
      // wants, rather than imposing a template nobody asked for.
      description: {},
    },
    // Checks stay on as a switch but do nothing without a checks.yaml.
    // Forks default off: running project scripts on untrusted code is RCE.
    checks: { enabled: true, allowForks: false, checks: [] },
    ownership: [],
    guards: [],
    rules: [],
    // Absent means impact analysis degrades to caller tracing, per the
    // architecture's degradation matrix — never an error.
    product: [],
    impactLog: [],
  };
}

/**
 * v3 keys that no code ever read. Accepted so old configs load, reported so the
 * operator learns they are inert rather than believing they still tune anything.
 */
export const DEAD_V3_KEYS: string[] = [
  "performance.tokenBudget",
  "performance.costControls",
  "performance.maxReviewDuration",
  "review.toolPreferences",
  "review.workflowInstructions",
  "review.contextLines",
  "review.fileAnalysisTimeout",
  "descriptionEnhancement.autoFormat",
  "monitoring.exportFormat",
];

/**
 * Fallback provider label when nothing else identifies one.
 *
 * A label only: it names a capability map in `.yama/mcp.yaml`, never a tool or
 * an API. Rule 7 forbids provider names in logic, not in a default a user
 * immediately overrides.
 */
export const DEFAULT_PROVIDER = "unknown";

/** Provider label from the CI environment, for run identity. */
export function identityProvider(env: NodeJS.ProcessEnv): string {
  if (env.GITHUB_REPOSITORY || env.GITHUB_ACTIONS) {
    return "github";
  }
  if (env.BITBUCKET_REPO_SLUG) {
    return "bitbucket";
  }
  if (env.CI_PROJECT_PATH) {
    return "gitlab";
  }
  return DEFAULT_PROVIDER;
}

/**
 * Is this CI run reviewing a pull request from a fork?
 *
 * Checks run repository-authored commands. Against a fork that is arbitrary code
 * execution with the job's credentials, so the answer gates whether they run at
 * all. Unknown is treated as "not a fork" only because the caller pairs this
 * with `checks.allowForks`, which defaults to off.
 */
export function isForkPullRequest(env: NodeJS.ProcessEnv): boolean {
  const head =
    env.GITHUB_HEAD_REPOSITORY ?? env.BITBUCKET_PR_SOURCE_REPO_FULL_NAME;
  const base = env.GITHUB_REPOSITORY ?? env.BITBUCKET_REPO_FULL_NAME;
  if (head && base) {
    return head !== base;
  }
  return env.GITHUB_EVENT_NAME === "pull_request_target";
}
