import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYAML } from "yaml";
import {
  buildInitPlan,
  buildLearnWorkflow,
  detectProject,
  detectProvider,
  renderInitPlan,
  type InitAnswers,
} from "../../../src/v4/cli/init.js";

let root: string;

const write = (relative: string, content: string): void => {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yama-init-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const answers = (overrides: Partial<InitAnswers> = {}): InitAnswers => ({
  provider: "github",
  tokenEnv: "YAMA_GITHUB_TOKEN",
  aiProvider: ["vertex", "litellm"],
  aiModel: ["claude-sonnet-4-6", "glm-4.6"],
  dryRunFirst: true,
  enabledChecks: [],
  importCodeowners: false,
  ...overrides,
});

describe("detectProvider", () => {
  it.each([
    ["git@github.com:o/r.git", "github"],
    ["https://bitbucket.example.net/scm/o/r.git", "bitbucket"],
    ["git@gitlab.com:o/r.git", "gitlab"],
    ["https://git.internal/o/r.git", "unknown"],
  ])("%s → %s", (url, expected) => {
    expect(detectProvider(url)).toBe(expected);
  });

  it("returns undefined with no remote", () => {
    expect(detectProvider(undefined)).toBeUndefined();
  });
});

describe("detectProject", () => {
  it("detects the stack from manifests", () => {
    write("package.json", "{}");
    write("go.mod", "module x");
    expect(detectProject(root).stacks.sort()).toEqual(["go", "node"]);
  });

  it("offers known scripts as candidate checks with the right runner", () => {
    write(
      "package.json",
      JSON.stringify({
        scripts: { lint: "eslint .", "type-check": "tsc", test: "jest" },
      }),
    );
    write("pnpm-lock.yaml", "");

    const detected = detectProject(root);
    expect(detected.candidateChecks).toEqual([
      { id: "lint", run: "pnpm lint", parse: "eslint" },
      { id: "typecheck", run: "pnpm type-check", parse: "tsc" },
      { id: "test", run: "pnpm test", parse: "junit" },
    ]);
  });

  it("uses npm run when there is no pnpm lockfile", () => {
    write("package.json", JSON.stringify({ scripts: { lint: "x" } }));
    expect(detectProject(root).candidateChecks[0].run).toBe("npm run lint");
  });

  it("survives a malformed package.json rather than failing onboarding", () => {
    write("package.json", "{ not json");
    expect(() => detectProject(root)).not.toThrow();
    expect(detectProject(root).candidateChecks).toEqual([]);
  });

  it("finds CODEOWNERS wherever it lives", () => {
    write(".github/CODEOWNERS", "* @team");
    const detected = detectProject(root);
    expect(detected.hasCodeowners).toBe(true);
    expect(detected.codeownersPath).toBe(".github/CODEOWNERS");
  });

  it("detects the CI system", () => {
    write(".github/workflows/ci.yml", "");
    expect(detectProject(root).ci).toBe("github-actions");
  });

  it("flags an existing v3 config so init redirects to migrate", () => {
    write("yama.config.yaml", "version: 2");
    expect(detectProject(root).legacyConfigPath).toBe("yama.config.yaml");
  });
});

describe("buildInitPlan", () => {
  it("writes exactly the two required files by default", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    expect(plan.files.map((file) => file.path)).toEqual([
      ".yama/yama.yaml",
      ".yama/mcp.yaml",
    ]);
  });

  it("writes model chains as lists, not single values", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    const config = parseYAML(
      plan.files.find((file) => file.path === ".yama/yama.yaml")?.content ?? "",
    ) as { ai: { provider: string[]; model: string[] } };

    expect(config.ai.provider).toEqual(["vertex", "litellm"]);
    expect(config.ai.model).toEqual(["claude-sonnet-4-6", "glm-4.6"]);
  });

  it("references the token by env var name, never by value", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    const mcp =
      plan.files.find((file) => file.path === ".yama/mcp.yaml")?.content ?? "";
    expect(mcp).toMatch(/\$\{YAMA_GITHUB_TOKEN\}/);
  });

  it("disables learning until it is deliberately configured", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    const config = parseYAML(
      plan.files.find((file) => file.path === ".yama/yama.yaml")?.content ?? "",
    ) as { learn: { trigger: string } };
    expect(config.learn.trigger).toBe("disabled");
  });

  it("configures learning on the merge event when a strategy is known", () => {
    const plan = buildInitPlan(
      detectProject(root),
      answers({ mergeStrategy: "squash" }),
    );
    const config = parseYAML(
      plan.files.find((file) => file.path === ".yama/yama.yaml")?.content ?? "",
    ) as { learn: { trigger: string; mergeStrategy: string } };

    expect(config.learn.trigger).toBe("merge-event");
    expect(config.learn.mergeStrategy).toBe("squash");
    expect(plan.requiredSecrets).toContain("YAMA_SSH_KEY");
  });

  it("warns that a rebase repository must learn on the merge event", () => {
    const plan = buildInitPlan(
      detectProject(root),
      answers({ mergeStrategy: "rebase" }),
    );
    expect(plan.warnings.join(" ")).toMatch(/carry no pull request number/);
  });

  describe("checks are offered, never imposed", () => {
    beforeEach(() => {
      write(
        "package.json",
        JSON.stringify({ scripts: { lint: "x", test: "y" } }),
      );
    });

    it("writes every candidate COMMENTED OUT when none were chosen", () => {
      const plan = buildInitPlan(detectProject(root), answers());
      const checks =
        plan.files.find((file) => file.path === ".yama/checks.yaml")?.content ??
        "";

      expect(checks).toMatch(/#\s+- id: lint/);
      expect(checks).toMatch(/#\s+- id: test/);
      expect(checks).not.toMatch(/^ {2}- id:/m);
    });

    it("enables only what the operator picked, leaving the rest commented", () => {
      const plan = buildInitPlan(
        detectProject(root),
        answers({ enabledChecks: ["lint"] }),
      );
      const checks =
        plan.files.find((file) => file.path === ".yama/checks.yaml")?.content ??
        "";

      expect(checks).toMatch(/^ {2}- id: lint/m);
      expect(checks).toMatch(/enabled: true/);
      expect(checks).toMatch(/#\s+- id: test/);
    });

    it("never marks a check blocking on day one", () => {
      const plan = buildInitPlan(
        detectProject(root),
        answers({ enabledChecks: ["lint"] }),
      );
      const checks =
        plan.files.find((file) => file.path === ".yama/checks.yaml")?.content ??
        "";
      expect(checks).not.toMatch(/blocking: true/);
    });

    it("keeps forks off and says why", () => {
      const plan = buildInitPlan(
        detectProject(root),
        answers({ enabledChecks: ["lint"] }),
      );
      const checks =
        plan.files.find((file) => file.path === ".yama/checks.yaml")?.content ??
        "";

      expect(checks).toMatch(/allowForks: false/);
      expect(checks).toMatch(/read from the BASE\n# branch/);
      expect(plan.warnings.join(" ")).toMatch(/off for forks by default/);
    });
  });

  it("warns that a CODEOWNERS import does not change what can merge", () => {
    write(".github/CODEOWNERS", "* @team");
    const plan = buildInitPlan(
      detectProject(root),
      answers({ importCodeowners: true }),
    );
    expect(plan.warnings.join(" ")).toMatch(/NON-blocking/);
  });

  it("puts doctor before the first review in the next steps", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    const doctorIndex = plan.nextSteps.findIndex((step) =>
      step.includes("yama doctor"),
    );
    const reviewIndex = plan.nextSteps.findIndex((step) =>
      step.includes("yama review"),
    );
    expect(doctorIndex).toBeGreaterThanOrEqual(0);
    expect(doctorIndex).toBeLessThan(reviewIndex);
  });

  it("puts bootstrap last — it is unreachable until connections work", () => {
    const plan = buildInitPlan(detectProject(root), answers());
    expect(plan.nextSteps[plan.nextSteps.length - 1]).toMatch(/bootstrap/);
  });
});

describe("learn workflow", () => {
  const workflow = buildLearnWorkflow("yama-bot");

  it("runs only on a MERGED pull request", () => {
    expect(workflow).toMatch(/merged == true/);
  });

  it("guards against Yama's own commits — [skip ci] is not enough alone", () => {
    expect(workflow).toMatch(/user\.login != 'yama-bot'/);
  });

  it("fetches full history, which correction linking needs", () => {
    expect(workflow).toMatch(/fetch-depth: 0/);
  });

  it("passes the pull request number from the event, the only exact source", () => {
    expect(workflow).toMatch(
      /--pr \$\{\{ github\.event\.pull_request\.number \}\}/,
    );
  });

  it("takes the write credential from secrets", () => {
    expect(workflow).toMatch(/YAMA_SSH_KEY: \$\{\{ secrets\.YAMA_SSH_KEY \}\}/);
  });
});

describe("renderInitPlan", () => {
  it("redirects to migrate when a v3 config exists", () => {
    write("yama.config.yaml", "version: 2");
    const detected = detectProject(root);
    const output = renderInitPlan(detected, buildInitPlan(detected, answers()));
    expect(output).toMatch(/run `yama migrate` instead of `init`/);
  });

  it("lists what will be written and what to do next", () => {
    const detected = detectProject(root);
    const output = renderInitPlan(detected, buildInitPlan(detected, answers()));
    expect(output).toMatch(/\.yama\/yama\.yaml/);
    expect(output).toMatch(/1\. Set YAMA_GITHUB_TOKEN/);
  });
});
