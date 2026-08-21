/**
 * `yama init` — the onboarding wizard, as a set of pure steps.
 *
 * Structured as data rather than as an interactive script so the whole flow is
 * testable without a terminal, and so the CLI layer only has to render it.
 *
 * The two BLOCKING gates matter more than anything else here. Bootstrap cannot
 * run without credentials and connections, and letting someone reach it before
 * those work produces a confusing failure deep inside a model call instead of a
 * clear one at setup time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYAML } from "yaml";
import type { DetectedProject, InitAnswers, InitPlan } from "../types/index.js";

const MANIFESTS: Array<{ file: string; stack: string }> = [
  { file: "package.json", stack: "node" },
  { file: "go.mod", stack: "go" },
  { file: "pyproject.toml", stack: "python" },
  { file: "requirements.txt", stack: "python" },
  { file: "Cargo.toml", stack: "rust" },
  { file: "pom.xml", stack: "java" },
  { file: "build.gradle", stack: "java" },
  { file: "Gemfile", stack: "ruby" },
  { file: "composer.json", stack: "php" },
  { file: "*.csproj", stack: "dotnet" },
];

/** Script names worth offering, and how to parse their output. */
const KNOWN_SCRIPTS: Record<string, { id: string; parse?: string }> = {
  lint: { id: "lint", parse: "eslint" },
  "type-check": { id: "typecheck", parse: "tsc" },
  typecheck: { id: "typecheck", parse: "tsc" },
  test: { id: "test", parse: "junit" },
};

export function detectProvider(
  remoteUrl: string | undefined,
): DetectedProject["provider"] {
  if (!remoteUrl) {
    return undefined;
  }
  const url = remoteUrl.toLowerCase();
  if (url.includes("github")) {
    return "github";
  }
  if (url.includes("bitbucket")) {
    return "bitbucket";
  }
  if (url.includes("gitlab")) {
    return "gitlab";
  }
  return "unknown";
}

/** Inspect the repository. Pure over the filesystem, no network. */
export function detectProject(
  projectRoot: string,
  remoteUrl?: string,
): DetectedProject {
  const has = (relative: string): boolean =>
    existsSync(join(projectRoot, relative));

  const stacks = [
    ...new Set(
      MANIFESTS.filter(
        (entry) => !entry.file.includes("*") && has(entry.file),
      ).map((entry) => entry.stack),
    ),
  ];

  const candidateChecks: DetectedProject["candidateChecks"] = [];
  if (has("package.json")) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(projectRoot, "package.json"), "utf-8"),
      ) as { scripts?: Record<string, string> };
      const runner = has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : "npm run";
      for (const [name, known] of Object.entries(KNOWN_SCRIPTS)) {
        if (manifest.scripts?.[name]) {
          candidateChecks.push({
            id: known.id,
            run: `${runner} ${name}`,
            parse: known.parse,
          });
        }
      }
    } catch {
      // A malformed package.json is the project's problem, not a reason to fail
      // onboarding. Offer nothing rather than crash.
    }
  }

  const codeownersPath = [
    ".github/CODEOWNERS",
    "CODEOWNERS",
    "docs/CODEOWNERS",
  ].find((path) => has(path));

  const legacyConfigPath = [
    ".yama/config.yaml",
    "yama.config.yaml",
    "yama.config.yml",
  ].find((path) => has(path));

  return {
    provider: detectProvider(remoteUrl),
    remoteUrl,
    stacks,
    candidateChecks,
    ci: has(".github/workflows")
      ? "github-actions"
      : has("bitbucket-pipelines.yml")
        ? "bitbucket-pipelines"
        : has("Jenkinsfile")
          ? "jenkins"
          : has(".gitlab-ci.yml")
            ? "gitlab-ci"
            : undefined,
    hasCodeowners: codeownersPath !== undefined,
    codeownersPath,
    legacyConfigPath,
  };
}

/**
 * Build what `init` will write.
 *
 * Checks are written DISABLED and commented out. Running project commands is
 * the highest-blast-radius thing Yama does, and enabling it as a side effect of
 * onboarding would be a decision made by a wizard rather than by a person.
 */
export function buildInitPlan(
  detected: DetectedProject,
  answers: InitAnswers,
): InitPlan {
  const warnings: string[] = [];
  const files: InitPlan["files"] = [];

  files.push({
    path: ".yama/yama.yaml",
    content:
      "# Yama core configuration.\n" +
      "# Every model slot accepts a list — the next entry is tried when one fails.\n\n" +
      stringifyYAML({
        version: 4,
        ai: {
          provider: answers.aiProvider,
          model: answers.aiModel,
        },
        learn:
          answers.mergeStrategy === undefined
            ? { trigger: "disabled" }
            : {
                trigger: "merge-event",
                mergeStrategy: answers.mergeStrategy,
                mode: "commit",
                botIdentity: "yama-bot",
              },
      }),
  });

  files.push({
    path: ".yama/mcp.yaml",
    content:
      "# Connections. Yama's code asks for a CAPABILITY; this maps it to the tool\n" +
      "# name your server provides. `yama doctor` verifies every mapping is real.\n\n" +
      stringifyYAML({
        servers: {
          [answers.provider]: {
            transport: "http",
            url: `# set the ${answers.provider} MCP endpoint`,
            headers: { Authorization: `Bearer \${${answers.tokenEnv}}` },
            capabilities: {
              readPullRequest: "# tool name",
              listComments: "# tool name",
              postInlineComment: "# tool name",
              postSummary: "# tool name",
            },
            stages: ["resolve", "orient", "post", "checks", "verdict"],
          },
        },
      }),
  });

  if (detected.candidateChecks.length > 0) {
    const chosen = detected.candidateChecks.filter((check) =>
      answers.enabledChecks.includes(check.id),
    );
    const body = detected.candidateChecks
      .map((check) => {
        const enabled = chosen.some((entry) => entry.id === check.id);
        const stanza = [
          `  - id: ${check.id}`,
          `    run: ${JSON.stringify(check.run)}`,
          ...(check.parse ? [`    parse: ${check.parse}`] : []),
          `    enabled: ${enabled}`,
          `    blocking: false`,
        ].join("\n");
        // Everything the operator did not pick is written commented out, so it
        // is discoverable without being active.
        return enabled
          ? stanza
          : stanza
              .split("\n")
              .map((line) => `# ${line}`)
              .join("\n");
      })
      .join("\n\n");

    files.push({
      path: ".yama/checks.yaml",
      content:
        "# Checks Yama runs during review, reporting their output as findings.\n" +
        "#\n" +
        "# SECURITY: this file and every script it names are read from the BASE\n" +
        "# branch, never from the pull request. A pull request that could edit them\n" +
        "# could run anything with this job's credentials.\n\n" +
        `enabled: true\nallowForks: false\n\nchecks:\n${body}\n`,
    });

    if (answers.enabledChecks.length > 0) {
      warnings.push(
        "Checks execute commands from your repository. They are read from the base " +
          "branch and are off for forks by default — keep it that way unless every " +
          "fork is trusted.",
      );
    }
  }

  if (answers.importCodeowners && detected.codeownersPath) {
    warnings.push(
      `CODEOWNERS will be imported as NON-blocking ownership rules. Importing must not ` +
        `silently change what can merge — set \`blocking: true\` per rule when you want it enforced.`,
    );
  }

  const requiredSecrets = [answers.tokenEnv];
  if (answers.mergeStrategy !== undefined) {
    requiredSecrets.push("YAMA_SSH_KEY");
  }

  const nextSteps = [
    `Set ${requiredSecrets.join(" and ")} in your CI secret store.`,
    "Fill in the MCP endpoint and capability tool names in .yama/mcp.yaml.",
    "Run `yama doctor` — it connects, verifies every capability, and reads a real pull request.",
    answers.dryRunFirst
      ? "Run `yama review --pr <n> --dry-run` and read what it would have posted."
      : "Run `yama review --pr <n>`.",
    "Then `yama bootstrap` to mine your history into a knowledge base (opens a pull request).",
  ];

  if (answers.mergeStrategy === "rebase") {
    warnings.push(
      "This repository rebases on merge, so commits carry no pull request number. " +
        "Learning must run on the merge event — the workflow `init` writes does exactly that.",
    );
  }

  return { files, requiredSecrets, nextSteps, warnings };
}

/**
 * The workflow that runs learning after a merge.
 *
 * Loop prevention is belt and braces: `[skip ci]` in the commit subject, an
 * actor guard, and a paths-ignore filter. `[skip ci]` alone is honoured
 * inconsistently across CI systems, and a learning loop that retriggers itself
 * is both expensive and hard to diagnose.
 */
export function buildLearnWorkflow(botIdentity: string): string {
  return `name: Yama learn

on:
  pull_request:
    types: [closed]

jobs:
  learn:
    # Only merged pull requests teach anything. A closed-unmerged one was rejected.
    if: >
      github.event.pull_request.merged == true &&
      github.event.pull_request.user.login != '${botIdentity}'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          # Learning reads history to link corrections back to what they corrected.
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @juspay/yama learn --pr \${{ github.event.pull_request.number }}
        env:
          YAMA_SSH_KEY: \${{ secrets.YAMA_SSH_KEY }}
`;
}

/** Render the wizard's plan for a terminal. */
export function renderInitPlan(
  detected: DetectedProject,
  plan: InitPlan,
): string {
  const lines = ["Yama setup", ""];

  lines.push("Detected:");
  lines.push(`  provider: ${detected.provider ?? "unknown"}`);
  lines.push(`  stack: ${detected.stacks.join(", ") || "unknown"}`);
  lines.push(`  ci: ${detected.ci ?? "none found"}`);
  if (detected.hasCodeowners) {
    lines.push(`  CODEOWNERS: ${detected.codeownersPath}`);
  }
  if (detected.legacyConfigPath) {
    lines.push(
      `  existing config: ${detected.legacyConfigPath} — run \`yama migrate\` instead of \`init\`.`,
    );
  }

  lines.push("", "Will write:");
  for (const file of plan.files) {
    lines.push(`  ${file.path}`);
  }

  lines.push("", "Next:");
  plan.nextSteps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step}`);
  });

  if (plan.warnings.length > 0) {
    lines.push("", "Read these:");
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join("\n");
}
