/**
 * Running `yama bootstrap` — the one-time history mining pass.
 *
 * `Bootstrap.ts` holds the pure half: what counts as enough history, and how a
 * model's draft becomes a set of files. This is the half that talks to the
 * world — it reads merged pull requests through the capability map, reads the
 * repository's own docs off disk, asks for one schema-bound draft, and writes
 * the result.
 *
 * It never commits. The first knowledge base is a set of claims about how a team
 * works, written by a model that read some of their pull requests, and those
 * claims shape every review afterwards. They get a human read first — and the
 * corrections a reviewer makes on that pull request are the highest-quality
 * signal the system will ever receive.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  BootstrapInput,
  BootstrapPlan,
  BootstrapRunOptions,
  BootstrapRunResult,
  ProductCapability,
  RuleEntry,
} from "../types/index.js";
import { CapabilityResolver } from "../connections/Capabilities.js";
import { createRuntime } from "../core/Runtime.js";
import { generateStructured } from "../core/StructuredCall.js";
import { normalizeComments } from "../connections/Comments.js";
import { capabilityParams, targetParams } from "../connections/invoke.js";
import { resolvePrompts } from "../prompts/PromptStore.js";
import { BOOTSTRAP_WINDOW, buildBootstrapPlan } from "./Bootstrap.js";

/**
 * The draft schema.
 *
 * Flat, and every field the model might not know is optional. A schema that
 * demands a `failureMode` for every capability gets one invented for every
 * capability, and an invented failure mode is worse than an absent one.
 */
export const bootstrapDraftSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string(),
      paths: z.array(z.string()).optional(),
      example: z.string().optional(),
      severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]).optional(),
      domain: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      evidence: z.array(z.string()).optional(),
      occurrences: z.number().optional(),
    }),
  ),
  capabilities: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      paths: z.array(z.string()),
      entrypoints: z.array(z.string()).optional(),
      userVisible: z.boolean().optional(),
      failureMode: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      criticality: z.enum(["high", "medium", "low"]).optional(),
    }),
  ),
  profile: z.string(),
});

/** Documentation worth showing the model, in the order it is looked for. */
const DOC_CANDIDATES = [
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/architecture.md",
];

const MAX_DOC_CHARS = 4_000;

/** Read the repository's own documentation, bounded. */
export async function readRepositoryDocs(
  projectRoot: string,
): Promise<Array<{ path: string; excerpt: string }>> {
  const docs: Array<{ path: string; excerpt: string }> = [];
  for (const candidate of DOC_CANDIDATES) {
    const path = join(projectRoot, candidate);
    if (!existsSync(path)) {
      continue;
    }
    try {
      const raw = await readFile(path, "utf-8");
      docs.push({ path: candidate, excerpt: raw.slice(0, MAX_DOC_CHARS) });
    } catch (error) {
      // An unreadable doc is skipped, not fatal — but it is not silent either,
      // because a permissions problem here looks exactly like a repository with
      // no documentation.
      docs.push({
        path: candidate,
        excerpt: `[could not be read: ${(error as Error).message}]`,
      });
    }
  }
  return docs;
}

/** Top-level directories, for the first capability sketch. */
export async function readTopLevelPaths(
  projectRoot: string,
): Promise<string[]> {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules",
    )
    .map((entry) => entry.name)
    .sort();
}

/** Render the evidence for the model. Bounded per pull request. */
export function renderBootstrapEvidence(input: BootstrapInput): string {
  const sections = input.mergedPullRequests.map((pullRequest) =>
    [
      `### Pull request #${pullRequest.id} — ${pullRequest.title}`,
      `Changed: ${pullRequest.changedPaths.slice(0, 40).join(", ") || "(unknown)"}`,
      "",
      ...pullRequest.comments.map(
        (comment) =>
          `- ${comment.author}${comment.path ? ` on ${comment.path}` : ""}: ` +
          comment.body.slice(0, 1_500),
      ),
    ].join("\n"),
  );

  return [
    `Top-level directories: ${input.topLevelPaths.join(", ")}`,
    "",
    "## Documentation",
    ...input.docs.map((doc) => `### ${doc.path}\n${doc.excerpt}`),
    "",
    "## Recent merged pull requests and their human review comments",
    ...sections,
  ].join("\n\n");
}

/**
 * Mine history once and produce the files a human will review.
 *
 * Returns the plan rather than writing it, so `--write` stays the caller's
 * decision and a dry run is genuinely free of side effects.
 */
export async function runBootstrap(
  options: BootstrapRunOptions,
): Promise<BootstrapRunResult> {
  const { config, context, chains } = options;
  const warnings: string[] = [];

  const prompts = await resolvePrompts({
    config: config.prompts,
    env: options.env ?? process.env,
  });
  warnings.push(...prompts.warnings);

  const runtime = await createRuntime({
    config,
    chains,
    context,
    role: "main",
    ...(options.logger ? { logger: options.logger } : {}),
  });

  try {
    const resolver = new CapabilityResolver(runtime.capabilities);
    const list = resolver.find("listMergedPullRequests", "resolve");
    if (!list) {
      return {
        warnings: [
          ...warnings,
          "No listMergedPullRequests capability is mapped, so there is no history to " +
            "mine. Map it in .yama/mcp.yaml under the server that serves pull requests, " +
            "then run bootstrap again.",
        ],
      };
    }

    const listComments = resolver.find("listComments", "resolve");
    if (!listComments) {
      return {
        warnings: [
          ...warnings,
          "No listComments capability is mapped. Bootstrap learns from what humans said " +
            "in review, so without it there is nothing to learn from.",
        ],
      };
    }

    // ── gather ──────────────────────────────────────────────────────────────
    const merged = await runtime.invoke(
      list.toolName,
      capabilityParams(list, {
        ...targetParams({
          owner: context.identity.owner,
          repo: context.identity.repo,
        }),
        state: "merged",
        limit: options.window ?? BOOTSTRAP_WINDOW,
      }),
    );

    const pullRequests = normalizePullRequests(merged).slice(
      0,
      options.window ?? BOOTSTRAP_WINDOW,
    );

    if (pullRequests.length === 0) {
      return {
        warnings: [
          ...warnings,
          "The provider returned no merged pull requests, so there is no history to " +
            "mine yet. Yama reviews fine without a knowledge base and will learn from " +
            "each merge.",
        ],
      };
    }

    const withComments = await Promise.all(
      pullRequests.map(async (pullRequest) => {
        try {
          const comments = normalizeComments(
            await runtime.invoke(
              listComments.toolName,
              capabilityParams(
                listComments,
                targetParams({
                  owner: context.identity.owner,
                  repo: context.identity.repo,
                  pullRequestId: pullRequest.id,
                }),
              ),
            ),
          );
          return {
            ...pullRequest,
            // Bot comments teach nothing about the team — they are Yama's own
            // earlier opinions, and learning from them would be a feedback loop.
            comments: comments
              .filter(
                (comment) =>
                  !config.learn.botIdentity ||
                  comment.author !== config.learn.botIdentity,
              )
              .map((comment) => ({
                author: comment.author ?? "unknown",
                body: comment.body,
                ...(comment.filePath ? { path: comment.filePath } : {}),
              })),
          };
        } catch (error) {
          warnings.push(
            `Could not read the conversation on #${pullRequest.id}: ` +
              `${(error as Error).message}. It is excluded from what bootstrap learned.`,
          );
          return { ...pullRequest, comments: [] };
        }
      }),
    );

    const input: BootstrapInput = {
      mergedPullRequests: withComments,
      topLevelPaths: await readTopLevelPaths(config.projectRoot),
      docs: await readRepositoryDocs(config.projectRoot),
    };

    // ── draft ───────────────────────────────────────────────────────────────
    const call = await generateStructured({
      host: runtime.host,
      // The strong chain: this output shapes every later review, so it is the
      // one place in the learning path where deliberation is worth paying for.
      chain: chains.review,
      context,
      systemPrompt: prompts.get("yama-bootstrap"),
      message: renderBootstrapEvidence(input),
      schema: bootstrapDraftSchema,
      operation: "bootstrap-draft",
    });

    if (!call.data) {
      return {
        warnings: [
          ...warnings,
          ...call.warnings,
          "Bootstrap produced nothing usable and wrote no files.",
        ],
      };
    }

    const plan = buildBootstrapPlan(input, {
      rules: call.data.rules as RuleEntry[],
      capabilities: call.data.capabilities as ProductCapability[],
      profile: call.data.profile,
    });

    return {
      plan,
      warnings: [...warnings, ...call.warnings, ...plan.warnings],
    };
  } finally {
    await runtime.shutdown();
  }
}

/**
 * Normalise whatever the provider's listing returned.
 *
 * Shape-driven rather than provider-driven: the field names differ across
 * providers, and Yama's code is not allowed to know which provider it is
 * talking to.
 */
export function normalizePullRequests(
  result: unknown,
): Array<{ id: number; title: string; changedPaths: string[] }> {
  const list = Array.isArray(result)
    ? result
    : ((result as Record<string, unknown>)?.values ??
      (result as Record<string, unknown>)?.items ??
      (result as Record<string, unknown>)?.pull_requests ??
      (result as Record<string, unknown>)?.pullRequests ??
      []);

  return (Array.isArray(list) ? list : [])
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const id = Number(record.number ?? record.id ?? Number.NaN);
      return {
        id,
        title: String(record.title ?? ""),
        changedPaths: Array.isArray(record.changedPaths)
          ? (record.changedPaths as string[])
          : [],
      };
    })
    .filter((entry) => Number.isFinite(entry.id));
}

/** What bootstrap would write, rendered for a terminal. */
export function renderBootstrapPlan(plan: BootstrapPlan): string {
  const lines = [
    "Bootstrap read " +
      `${plan.evidence.pullRequestsExamined} merged pull request(s) and ` +
      `${plan.evidence.humanCommentsExamined} human comment(s).`,
    "",
  ];

  if (plan.evidence.docsFound.length > 0) {
    lines.push(`Docs read: ${plan.evidence.docsFound.join(", ")}`, "");
  }

  lines.push("Files it would write:");
  for (const file of plan.files) {
    lines.push(`  ${file.path}`, `      ${file.rationale}`);
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  lines.push(
    "",
    "Every rule is written as a CANDIDATE. Nothing here is enforced until a human " +
      "approves it or a live review states it again.",
  );

  return lines.join("\n");
}
