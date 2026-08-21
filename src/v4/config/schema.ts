/**
 * Zod schemas for every config file.
 *
 * Validation is strict about SHAPE and permissive about EXTENSION: unknown keys
 * on server definitions pass through to NeuroLink (so any option a future
 * NeuroLink adds is configurable without a Yama change), while unknown keys on
 * Yama's own blocks are reported as notices rather than accepted silently — a
 * typo'd key that quietly does nothing is worse than a loud one.
 */

import { z } from "zod";

const severity = z.enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]);

const stringOrArray = z.union([z.string(), z.array(z.string())]);

/**
 * Prompt ids, as a closed enum.
 *
 * Closed rather than a free string because these are the names a prompt
 * platform stores entries under: a typo in `only:` would otherwise silently
 * manage nothing, which looks exactly like a platform that is working.
 */
const promptId = z.enum([
  "yama-review",
  "yama-judge",
  "yama-triage",
  "yama-bootstrap",
  "yama-description",
  "yama-extraction",
  "yama-subagent-impact",
  "yama-subagent-security",
  "yama-subagent-history",
  "yama-subagent-tests",
  "yama-subagent-conventions",
]);

const modelChainMember = z.object({
  provider: z.string(),
  model: z.string().optional(),
  region: z.string().optional(),
  weight: z.number().optional(),
});

const poolSettings = z.object({
  strategy: z.enum(["priority", "round-robin", "weighted"]).optional(),
  cooldownMs: z.number().optional(),
  maxAttempts: z.number().optional(),
});

/** Any model slot: scalars, arrays, or an explicit member list. */
export const modelSlotSchema = z.object({
  provider: stringOrArray.optional(),
  model: stringOrArray.optional(),
  fallback: z.array(modelChainMember).optional(),
  pool: poolSettings.optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  timeout: z.union([z.string(), z.number()]).optional(),
});

// ── yama.yaml ────────────────────────────────────────────────────────────────

export const yamaFileSchema = z.object({
  version: z.literal(4),
  ai: modelSlotSchema.extend({
    review: modelSlotSchema.optional(),
    subAgent: modelSlotSchema.optional(),
    judge: modelSlotSchema.optional(),
    scorecard: modelSlotSchema.optional(),
    description: modelSlotSchema.optional(),
    extraction: modelSlotSchema.optional(),
    compaction: modelSlotSchema.optional(),
    memory: modelSlotSchema.optional(),
    // Runtime tool names to drop before the agent sees them. Names belong in
    // config, never in code (rule 7); absent excludes nothing (rule 12).
    excludeRuntimeTools: z.array(z.string()).optional(),
  }),
  learn: z
    .object({
      trigger: z.enum(["merge-event", "push", "disabled"]).optional(),
      mergeStrategy: z.enum(["squash", "merge", "rebase"]).optional(),
      mode: z.enum(["commit", "pull-request"]).optional(),
      botIdentity: z.string().optional(),
      git: z
        .object({
          auth: z.enum(["ssh", "https"]).optional(),
          sshKeyEnv: z.string().optional(),
          userEnv: z.string().optional(),
          tokenEnv: z.string().optional(),
          remote: z.string().optional(),
          branch: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  state: z
    .object({ enabled: z.boolean().optional(), path: z.string().optional() })
    .optional(),
  observability: z
    .object({
      enabled: z.boolean().optional(),
      reportPath: z.string().optional(),
    })
    .optional(),
  // Optional prompt management. Absent, or enabled: false, means every prompt
  // resolves to the text Yama ships — which is also every failure path, so a
  // platform outage slows nothing and changes nothing.
  prompts: z
    .object({
      enabled: z.boolean().optional(),
      provider: z.literal("langfuse").optional(),
      label: z.string().optional(),
      version: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
      publicKeyEnv: z.string().optional(),
      secretKeyEnv: z.string().optional(),
      baseUrlEnv: z.string().optional(),
      only: z.array(promptId).optional(),
    })
    .optional(),
  extends: z.string().optional(),
});

// ── mcp.yaml ─────────────────────────────────────────────────────────────────

const capabilityName = z.enum([
  "readPullRequest",
  "findPullRequest",
  "listComments",
  "listApprovals",
  "listChangedFiles",
  "beginReview",
  "postInlineComment",
  "submitReview",
  "updateComment",
  "postSummary",
  "resolveComment",
  "setStatus",
  "updateDescription",
  "listMergedPullRequests",
  "codeIntel",
  "readTicket",
]);

const stageName = z.enum([
  "resolve",
  "orient",
  "review",
  "post",
  "checks",
  "enhance",
  "verdict",
]);

/**
 * Passthrough is deliberate: unrecognised keys reach NeuroLink verbatim so a
 * server can use options Yama has never heard of.
 */
export const mcpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    transport: z.enum(["stdio", "http", "sse", "websocket"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // partialRecord, not record: a server declares only the capabilities it
    // actually provides. z.record over an enum would demand all of them.
    // A bare string is the tool name; the object form pins arguments the tool
    // needs on every call. String stays valid, so existing configs are
    // untouched.
    capabilities: z
      .partialRecord(
        capabilityName,
        z.union([
          z.string(),
          z.object({
            tool: z.string(),
            args: z.record(z.string(), z.unknown()).optional(),
          }),
        ]),
      )
      .optional(),
    stages: z.array(stageName).optional(),
    roles: z.array(z.enum(["main", "sub"])).optional(),
    blockedTools: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    timeout: z.number().optional(),
    retryConfig: z
      .object({
        maxAttempts: z.number().optional(),
        initialDelay: z.number().optional(),
        maxDelay: z.number().optional(),
        backoffMultiplier: z.number().optional(),
      })
      .optional(),
  })
  .loose();

export const mcpFileSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema),
});

// ── review.yaml ──────────────────────────────────────────────────────────────

export const reviewFileSchema = z.object({
  concurrency: z
    .object({ power: z.enum(["high", "medium", "low"]).optional() })
    .optional(),
  verdict: z
    .object({
      enabled: z.boolean().optional(),
      blockOn: z
        .array(
          z.enum([
            "CRITICAL",
            "MAJOR_THRESHOLD",
            "blocking-rule",
            "blocking-check",
            "unapproved-ownership",
          ]),
        )
        .optional(),
      majorThreshold: z.number().optional(),
    })
    .optional(),
  stages: z
    .object({ checks: z.boolean().optional(), enhance: z.boolean().optional() })
    .optional(),
  remediation: z
    .object({ maxAttemptsPerStage: z.number().optional() })
    .optional(),
  excludePatterns: z.array(z.string()).optional(),
  maxFiles: z.number().optional(),
  confidenceThreshold: z.number().min(0).max(100).optional(),
  changedLinesOnly: z.boolean().optional(),
  // What to do with deleted files. Absent means "content" — the original
  // behaviour — so existing configs are untouched (rule 12).
  deletions: z.enum(["content", "ignore"]).optional(),
  /**
   * Steps per turn before the turn ends and the supervisor looks at progress.
   *
   * NOT a work budget (rule 13): the next turn continues in the same session
   * exactly where the last one stopped. What it bounds is how much history one
   * inner tool loop can accumulate before a turn boundary — production run
   * 32639184394 ran 200-step turns that grew to 488K tokens, blew past every
   * compaction opportunity, and gave the supervisor two interventions in 45
   * minutes. Absent means the runtime's own default applies (uncapped turns).
   */
  maxStepsPerTurn: z.number().int().positive().optional(),
  // Sections the enhanced description must contain. Verified by re-reading the
  // pull request, never by believing the agent said it wrote them.
  description: z
    .object({
      sections: z
        .array(
          z.object({
            title: z.string().min(1),
            required: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  deadline: z.string().optional(),
});

// ── checks.yaml ──────────────────────────────────────────────────────────────

export const checkSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().optional(),
    run: z.string().optional(),
    type: z.literal("builtin.owners").optional(),
    source: z.string().optional(),
    parse: z
      .enum(["sarif", "eslint", "tsc", "junit", "regex", "agent"])
      .optional(),
    hint: z.string().optional(),
    when: z.object({ paths: z.array(z.string()).optional() }).optional(),
    severity: z.record(z.string(), severity).optional(),
    scope: z.enum(["changed-lines", "changed-files", "repo"]).optional(),
    maxFindings: z.number().optional(),
    blocking: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    workingDirectory: z.string().optional(),
  })
  .refine((check) => Boolean(check.run) !== Boolean(check.type), {
    message:
      "a check needs exactly one of `run` (a shell command) or `type` (a built-in)",
  });

export const checksFileSchema = z.object({
  enabled: z.boolean().optional(),
  allowForks: z.boolean().optional(),
  checks: z.array(checkSchema),
});

// ── policy ───────────────────────────────────────────────────────────────────

export const ownershipFileSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      paths: z.array(z.string()).min(1),
      owners: z.array(z.string()).min(1),
      minApprovals: z.number().min(0).optional(),
      blocking: z.boolean().optional(),
      reason: z.string().optional(),
      exclusive: z.boolean().optional(),
    }),
  ),
});

export const guardsFileSchema = z.object({
  guards: z.array(
    z.object({
      id: z.string().min(1),
      paths: z.array(z.string()).min(1),
      severityFloor: severity.optional(),
      requireChecks: z.array(z.string()).optional(),
      forbid: z.boolean().optional(),
      reason: z.string().optional(),
    }),
  ),
});

// ── rules/*.yaml ─────────────────────────────────────────────────────────────

export const ruleEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  domain: z.string().optional(),
  paths: z.array(z.string()).optional(),
  severity: severity.optional(),
  blocking: z.boolean().optional(),
  example: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  status: z.enum(["active", "candidate", "dormant", "suppressed"]).optional(),
  weight: z.number().optional(),
  occurrences: z.number().optional(),
  authors: z.number().optional(),
  evidence: z.array(z.string()).optional(),
});

/** A rule file is either one rule or a `rules:` array. */
export const rulesFileSchema = z.union([
  z.object({ rules: z.array(ruleEntrySchema) }),
  ruleEntrySchema,
]);

/** Format a zod failure into something a human can act on. */
export function formatIssues(error: z.ZodError, file: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
  return `${file} is invalid:\n${lines.join("\n")}`;
}

// ── product/capabilities.yaml + product/impact-log/*.yaml — generated ────────

/**
 * The product model, written by `bootstrap` and refined by `learn`.
 *
 * Validated on read like every other file: these are generated, but they are
 * also git-tracked and hand-edited, and a typo in a hand-edit must surface as a
 * notice rather than as a capability that silently matches nothing.
 */
export const productCapabilityFileSchema = z.object({
  capabilities: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      paths: z.array(z.string()),
      entrypoints: z.array(z.string()).optional(),
      userVisible: z.boolean().optional(),
      failureMode: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      criticality: z.enum(["high", "medium", "low"]).optional(),
      notes: z.string().optional(),
    }),
  ),
});

export const impactLogEntrySchema = z.object({
  pullRequestId: z.number(),
  mergedAt: z.string().optional(),
  at: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  changeKind: z
    .enum([
      "contract-change",
      "behavior-change",
      "perf",
      "internal",
      "fix",
      "revert",
    ])
    .optional(),
  summary: z.string().default(""),
  userVisibleEffect: z.string().optional(),
  risk: z.enum(["high", "medium", "low"]).optional(),
  testedBy: z.array(z.string()).optional(),
  laterCorrectedBy: z.array(z.number()).optional(),
  corrects: z.array(z.number()).optional(),
  paths: z.array(z.string()).optional(),
  title: z.string().optional(),
});
