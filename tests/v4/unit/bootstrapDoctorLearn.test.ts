import {
  BOOTSTRAP_INSTRUCTIONS,
  buildBootstrapPlan,
  hasEnoughHistory,
  type BootstrapDraft,
  type BootstrapInput,
} from "../../../src/v4/learn/Bootstrap.js";
import { inspectLearnWrite, runDoctor } from "../../../src/v4/core/Doctor.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type { ResolvedConfig } from "../../../src/v4/types/index.js";

const pullRequest = (id: number, comments = 2) => ({
  id,
  title: `PR ${id}`,
  comments: Array.from({ length: comments }, (_, index) => ({
    author: `@dev${index}`,
    body: "Wrap this error with context before rethrowing.",
  })),
  changedPaths: ["src/app.ts"],
});

const input = (overrides: Partial<BootstrapInput> = {}): BootstrapInput => ({
  mergedPullRequests: [pullRequest(1), pullRequest(2), pullRequest(3)],
  topLevelPaths: ["src", "tests"],
  docs: [{ path: "CLAUDE.md", excerpt: "conventions" }],
  ...overrides,
});

const draft: BootstrapDraft = {
  rules: [
    {
      id: "conv.error-wrapping",
      title: "Wrap errors with context",
      summary: "A bare rethrow loses the call site",
      status: "active",
      evidence: ["PR#1", "PR#2"],
    },
  ],
  capabilities: [
    {
      id: "review.posting",
      name: "Posting",
      paths: ["src/posting/**"],
      failureMode: "fails silently",
    },
  ],
  profile: "TypeScript, tests in tests/, pnpm.",
};

describe("hasEnoughHistory", () => {
  it("needs several commented pull requests to see a pattern", () => {
    expect(hasEnoughHistory(input())).toBe(true);
    expect(
      hasEnoughHistory(
        input({ mergedPullRequests: [pullRequest(1), pullRequest(2)] }),
      ),
    ).toBe(false);
  });

  it("ignores pull requests nobody commented on", () => {
    expect(
      hasEnoughHistory(
        input({
          mergedPullRequests: [
            pullRequest(1, 0),
            pullRequest(2, 0),
            pullRequest(3, 0),
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("buildBootstrapPlan", () => {
  it("FORCES every mined rule to candidate, whatever the draft claimed", () => {
    const plan = buildBootstrapPlan(input(), draft);
    expect(
      plan.files.some((file) => file.content.includes("status: candidate")),
    ).toBe(true);
    expect(
      plan.files.some((file) => file.content.includes("status: active")),
    ).toBe(false);
  });

  it("writes rules, capabilities and the profile", () => {
    const paths = buildBootstrapPlan(input(), draft).files.map(
      (file) => file.path,
    );
    expect(paths).toContain(".yama/rules/conv.error-wrapping.yaml");
    expect(paths).toContain(".yama/product/capabilities.yaml");
    expect(paths).toContain(".yama/profile.md");
  });

  it("warns loudly when there is too little history to trust", () => {
    const plan = buildBootstrapPlan(
      input({ mergedPullRequests: [pullRequest(1)] }),
      draft,
    );
    expect(plan.warnings.join(" ")).toMatch(/too little history/);
    expect(plan.pullRequestBody).toMatch(/Read this first/);
  });

  it("records what it actually examined so a reviewer can judge the basis", () => {
    const plan = buildBootstrapPlan(input(), draft);
    expect(plan.evidence).toEqual({
      pullRequestsExamined: 3,
      humanCommentsExamined: 6,
      docsFound: ["CLAUDE.md"],
    });
  });

  it("explains in the pull request that nothing is enforced yet", () => {
    const body = buildBootstrapPlan(input(), draft).pullRequestBody;
    expect(body).toMatch(/Every one is a \*\*candidate\*\*/);
    expect(body).toMatch(/not enforced until/);
    expect(body).toMatch(/Delete anything that is not/);
  });

  it("draws attention to silent failure modes", () => {
    expect(buildBootstrapPlan(input(), draft).pullRequestBody).toMatch(
      /fails \*silently\*/,
    );
  });

  it("tells the team it will maintain itself after merge", () => {
    expect(buildBootstrapPlan(input(), draft).pullRequestBody).toMatch(
      /updates these files itself on every merge/,
    );
  });

  it("produces a minimal plan when the draft is empty", () => {
    const plan = buildBootstrapPlan(input(), {
      rules: [],
      capabilities: [],
      profile: "",
    });
    expect(plan.files).toEqual([]);
  });
});

describe("bootstrap instructions", () => {
  it("asks for what cannot be inferred, not for restating a linter", () => {
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(/real and unwritten/);
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(
      /not for restating what a linter enforces/,
    );
  });

  it("warns against padding the rulebook", () => {
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(/Do not pad the list/);
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(
      /every wrong rule costs an author time/,
    );
  });

  it("caps the profile so it stays cheap on every review", () => {
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(/under 2000 characters/);
  });

  it("asks it to name its gaps", () => {
    expect(BOOTSTRAP_INSTRUCTIONS).toMatch(/Say what you could not determine/);
  });
});

describe("doctor --learn", () => {
  function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return {
      version: 4,
      ai: { provider: "vertex" },
      mcp: { servers: {} },
      projectRoot: "/repo",
      notices: [],
      ...optionalDefaults(),
      ...overrides,
    } as ResolvedConfig;
  }

  it("says nothing is needed when learning is off", () => {
    const checks = inspectLearnWrite(config(), {});
    expect(checks[0].status).toBe("warn");
    expect(checks[0].detail).toMatch(/no write credential is needed/);
  });

  it("FAILS when learning is on but learn.git is missing", () => {
    const checks = inspectLearnWrite(
      config({ learn: { trigger: "merge-event", mode: "commit" } }),
      {},
    );
    expect(checks[0].status).toBe("fail");
    expect(checks[0].remedy).toMatch(/cannot record it/);
  });

  it("fails when the ssh key env var is unset, and says it wants the key BODY", () => {
    const checks = inspectLearnWrite(
      config({
        learn: {
          trigger: "merge-event",
          mode: "commit",
          git: { auth: "ssh", sshKeyEnv: "MY_KEY", remote: "git@h:o/r.git" },
        },
      }),
      {},
    );
    const credential = checks.find((check) =>
      check.name.includes("credential"),
    );
    expect(credential?.status).toBe("fail");
    expect(credential?.remedy).toMatch(/private key BODY \(not a path\)/);
  });

  it("passes when the credential and remote are present", () => {
    const checks = inspectLearnWrite(
      config({
        learn: {
          trigger: "merge-event",
          mode: "pull-request",
          git: { auth: "ssh", sshKeyEnv: "MY_KEY", remote: "git@h:o/r.git" },
        },
      }),
      { MY_KEY: "-----BEGIN-----" },
    );
    expect(checks.every((check) => check.status !== "fail")).toBe(true);
  });

  it("warns that a direct push will fail on a protected branch", () => {
    const checks = inspectLearnWrite(
      config({
        learn: {
          trigger: "merge-event",
          mode: "commit",
          git: { auth: "ssh", sshKeyEnv: "K", remote: "r", branch: "main" },
        },
      }),
      { K: "key" },
    );
    const branch = checks.find((check) => check.name === "learn:branch");
    expect(branch?.remedy).toMatch(/set learn\.mode to 'pull-request'/i);
  });

  it("is omitted entirely unless --learn was asked for", () => {
    const withoutLearn = runDoctor({ config: config(), mode: "dry-run" });
    expect(
      withoutLearn.checks.some((check) => check.name.startsWith("learn:")),
    ).toBe(false);

    const withLearn = runDoctor({
      config: config(),
      mode: "dry-run",
      checkLearn: true,
      env: {},
    });
    expect(
      withLearn.checks.some((check) => check.name.startsWith("learn:")),
    ).toBe(true);
  });
});
