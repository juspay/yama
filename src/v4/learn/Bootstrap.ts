/**
 * `yama bootstrap` — mine history once, so no review ever has to.
 *
 * The single biggest cost in the previous architecture was re-deriving the same
 * repository knowledge on every pull request. That work belongs here: once, at
 * setup, and then incrementally on merge. A review becomes a consumer.
 *
 * Bootstrap opens a pull request rather than committing. The first knowledge
 * base is a set of claims about how a team works, written by a model that has
 * read some of their pull requests. Those claims deserve a human read before
 * they start shaping reviews — and the corrections are the most valuable signal
 * the system will ever get.
 */

import { stringify as stringifyYAML } from "yaml";
import type {
  BootstrapDraft,
  BootstrapInput,
  BootstrapPlan,
  RuleEntry,
} from "../types/index.js";

/**
 * How much history is worth mining.
 *
 * Fifteen is enough to see a recurring convention and few enough to stay cheap.
 * Going deeper mostly surfaces conventions the team has since abandoned, which
 * is worse than not finding them.
 */
export const BOOTSTRAP_WINDOW = 15;

/**
 * Whether there is enough history to learn anything.
 *
 * A repository with three merged pull requests cannot show a recurring pattern,
 * and inventing rules from two data points produces exactly the confident,
 * wrong rulebook that makes teams stop trusting a reviewer.
 */
export function hasEnoughHistory(input: BootstrapInput): boolean {
  const withComments = input.mergedPullRequests.filter(
    (pr) => pr.comments.length > 0,
  );
  return withComments.length >= 3;
}

/**
 * Assemble the plan from a model's draft.
 *
 * Every rule starts as a CANDIDATE regardless of what the draft says. Nothing
 * mined from history is enforced until a human either approves the pull request
 * or a live reviewer states the same thing again — which is the promotion path
 * the learning loop already implements.
 */
export function buildBootstrapPlan(
  input: BootstrapInput,
  draft: BootstrapDraft,
): BootstrapPlan {
  const warnings: string[] = [];

  if (!hasEnoughHistory(input)) {
    warnings.push(
      `Only ${input.mergedPullRequests.filter((pr) => pr.comments.length > 0).length} ` +
        `merged pull request(s) carry human review comments. That is too little history ` +
        `to distinguish a convention from a one-off, so the conventions below are weak ` +
        `guesses. Prune them hard.`,
    );
  }

  const rules = draft.rules.map((rule) => ({
    ...rule,
    status: "candidate" as const,
    occurrences: rule.occurrences ?? 1,
    weight: rule.weight ?? 1,
  }));

  const files: BootstrapPlan["files"] = [];

  for (const rule of rules) {
    files.push({
      path: `.yama/rules/${rule.id.replace(/[^a-z0-9.-]/gi, "-")}.yaml`,
      content: stringifyYAML(rule),
      rationale: `Observed in review comments on ${(rule.evidence ?? []).join(", ") || "recent pull requests"}`,
    });
  }

  if (draft.capabilities.length > 0) {
    files.push({
      path: ".yama/product/capabilities.yaml",
      content:
        "# What each part of this codebase DOES, in product terms.\n" +
        "# Yama uses this to say what a change will affect, not just what it edits.\n" +
        "# The `failureMode` field is the most valuable one — say how it fails, and\n" +
        "# especially whether it fails silently.\n\n" +
        stringifyYAML({ capabilities: draft.capabilities }),
      rationale: "Sketched from the repository's top-level structure and docs",
    });
  }

  if (draft.profile.trim()) {
    files.push({
      path: ".yama/profile.md",
      content: `${draft.profile.trim()}\n`,
      rationale: "Stack, layout and conventions inferred from the repository",
    });
  }

  return {
    files,
    evidence: {
      pullRequestsExamined: input.mergedPullRequests.length,
      humanCommentsExamined: input.mergedPullRequests.reduce(
        (sum, pr) => sum + pr.comments.length,
        0,
      ),
      docsFound: input.docs.map((doc) => doc.path),
    },
    warnings,
    pullRequestBody: renderBootstrapPullRequest(input, rules, draft, warnings),
  };
}

function renderBootstrapPullRequest(
  input: BootstrapInput,
  rules: RuleEntry[],
  draft: BootstrapDraft,
  warnings: string[],
): string {
  const lines: string[] = [
    "## Yama knowledge base",
    "",
    "This is what Yama learned from your repository's history. Reviewing it matters:",
    "these files shape every review from here on, and corrections you make now are",
    "the strongest signal the system will get.",
    "",
    "### What it read",
    "",
    `- ${input.mergedPullRequests.length} merged pull requests`,
    `- ${input.mergedPullRequests.reduce((sum, pr) => sum + pr.comments.length, 0)} human review comments`,
    `- ${input.docs.length} documentation file(s): ${input.docs.map((doc) => doc.path).join(", ") || "none"}`,
    "",
  ];

  if (warnings.length > 0) {
    lines.push("### Read this first", "");
    for (const warning of warnings) {
      lines.push(`> ${warning}`);
    }
    lines.push("");
  }

  if (rules.length > 0) {
    lines.push(
      `### Conventions (${rules.length})`,
      "",
      "Every one is a **candidate**: recorded and retrievable, but not enforced until",
      "a reviewer states it again on a real pull request. Delete anything that is not",
      "actually how you work.",
      "",
    );
    for (const rule of rules) {
      lines.push(`- **${rule.title}** — ${rule.summary}`);
    }
    lines.push("");
  }

  if (draft.capabilities.length > 0) {
    lines.push(
      `### Capabilities (${draft.capabilities.length})`,
      "",
      "What each part of the codebase does, in product terms. Check the `failureMode`",
      "lines especially — knowing that something fails *silently* changes how a",
      "reviewer reads a change to it.",
      "",
    );
    for (const capability of draft.capabilities) {
      lines.push(`- **${capability.name}** — ${capability.paths.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(
    "### After merging",
    "",
    "Yama updates these files itself on every merge, so they stay current without",
    "anyone maintaining them. Each update is an ordinary commit you can revert.",
  );

  return lines.join("\n");
}

/** The instruction the bootstrap agent works from. */
export const BOOTSTRAP_INSTRUCTIONS = `You are setting up a code reviewer for a repository it has never seen.

Read the merged pull requests you are given and find what the team's HUMAN reviewers actually care about — the things they say repeatedly that a newcomer would not know. You are looking for conventions that are real and unwritten, not for restating what a linter enforces.

For each convention: one imperative sentence, one concrete code example, and the paths it applies to. Record only what you saw stated more than once, or stated once with clear conviction. Do not pad the list — a short accurate rulebook is worth more than a long speculative one, and every wrong rule costs an author time on every future pull request.

Then sketch the product capability map: what each major part of the codebase does in terms a user would recognise, and how it fails. Say plainly when something fails silently — that is the most useful thing you can record about it.

Finally write a short repository profile: the stack, the layout, where tests live, and the conventions that hold across the whole codebase. Keep it under 2000 characters. It is loaded on every review, so anything that is not universally true does not belong in it.

Say what you could not determine. A gap you name is fixable; a gap you paper over is not.`;
