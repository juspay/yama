import {
  buildYamaTools,
  submitFindingTool,
  toolsForStage,
  type ToolDependencies,
} from "../../../src/v4/tools/registry.js";
import { parseGitCommand } from "../../../src/v4/tools/gitSafe.js";
import {
  excludedToolsForStage,
  looksMutating,
} from "../../../src/v4/core/ToolExposure.js";
import { FindingLedger } from "../../../src/v4/findings/Ledger.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import type { RecallEntry } from "../../../src/v4/tools/recall.js";

const changeSet = buildChangeSet({
  diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,1 +10,2 @@
 const a = 1;
+const b = eval(input);
`,
  excludePatterns: [],
  maxFiles: 10,
});

const entries: RecallEntry[] = [
  {
    id: "sec.no-eval",
    title: "Never eval external input",
    summary: "eval on request data is remote code execution",
    kind: "rule",
    severity: "CRITICAL",
    blocking: true,
  },
];

function dependencies(
  overrides: Partial<ToolDependencies> = {},
): ToolDependencies {
  return {
    entries,
    changeSet,
    ledger: new FindingLedger(),
    guards: [],
    ownership: [],
    checkResults: [],
    alreadyReported: new Set(),
    suppressed: new Set(),
    checkFlagged: new Set(),
    confidenceThreshold: 80,
    changedLinesOnly: true,
    dryRun: false,
    ...overrides,
  };
}

const toolNamed = (deps: ToolDependencies, name: string) =>
  buildYamaTools(deps).find((tool) => tool.name === name)!;

describe("stage scoping is a security control", () => {
  const tools = buildYamaTools(dependencies());

  it("does not expose the gate during orientation", () => {
    expect(
      toolsForStage(tools, "orient", "main").map((tool) => tool.name),
    ).not.toContain("submit_finding");
  });

  it("exposes the gate during review", () => {
    expect(
      toolsForStage(tools, "review", "main").map((tool) => tool.name),
    ).toContain("submit_finding");
  });

  it("never lets a sub-agent reach the gate — only the main agent decides", () => {
    expect(
      toolsForStage(tools, "review", "sub").map((tool) => tool.name),
    ).not.toContain("submit_finding");
  });

  it("gives sub-agents the read-only context tools", () => {
    const names = toolsForStage(tools, "review", "sub").map(
      (tool) => tool.name,
    );
    expect(names).toContain("recall");
    expect(names).toContain("check_results");
  });

  it("exposes nothing during the verdict stage", () => {
    expect(toolsForStage(tools, "verdict", "main")).toEqual([]);
  });
});

describe("recall tool", () => {
  it("returns rendered text with citation ids", async () => {
    const result = (await toolNamed(dependencies(), "recall").execute({
      query: "eval",
    })) as { text: string; count: number };
    expect(result.count).toBe(1);
    expect(result.text).toMatch(/\[sec\.no-eval\]/);
  });

  it("reports zero matches without inventing anything", async () => {
    const result = (await toolNamed(dependencies(), "recall").execute({
      query: "kubernetes",
    })) as { count: number; text: string };
    expect(result.count).toBe(0);
    expect(result.text).toMatch(/do not invent/);
  });
});

describe("policy_check tool", () => {
  it("reports owners, approval state and required checks", async () => {
    const result = (await toolNamed(
      dependencies({
        ownership: [
          {
            id: "core",
            paths: ["src/**"],
            owners: ["@alice"],
            minApprovals: 1,
          },
        ],
        guards: [{ id: "g", paths: ["src/**"], requireChecks: ["test"] }],
        approvals: [],
      }),
      "policy_check",
    ).execute({})) as {
      ownership: Array<{ rule: string; satisfied: boolean }>;
      requiredChecks: string[];
    };

    expect(result.ownership[0]).toMatchObject({
      rule: "core",
      satisfied: false,
    });
    expect(result.requiredChecks).toEqual(["test"]);
  });

  it("says plainly when there is no change set yet", async () => {
    const result = (await toolNamed(
      dependencies({ changeSet: undefined }),
      "policy_check",
    ).execute({})) as { note?: string };
    expect(result.note).toMatch(/No change set/);
  });
});

describe("check_results tool", () => {
  const deps = dependencies({
    checkResults: [
      {
        checkId: "lint",
        status: "failed",
        durationMs: 1,
        droppedFindings: 3,
        findings: [
          {
            filePath: "src/app.ts",
            line: 11,
            severity: "MAJOR",
            message: "no-eval",
          },
          {
            filePath: "other.ts",
            line: 1,
            severity: "MINOR",
            message: "elsewhere",
          },
        ],
      },
    ],
  });

  it("exposes what the project's own tools reported", async () => {
    const result = (await toolNamed(deps, "check_results").execute({})) as {
      checks: Array<{
        checkId: string;
        status: string;
        dropped: number;
        findings: unknown[];
      }>;
    };
    expect(result.checks[0]).toMatchObject({
      checkId: "lint",
      status: "failed",
      dropped: 3,
    });
    expect(result.checks[0].findings).toHaveLength(2);
  });

  it("filters to requested files", async () => {
    const result = (await toolNamed(deps, "check_results").execute({
      files: ["src/app.ts"],
    })) as { checks: Array<{ findings: unknown[] }> };
    expect(result.checks[0].findings).toHaveLength(1);
  });
});

describe("submit_finding tool", () => {
  const good = {
    severity: "MAJOR",
    title: "Unsafe eval",
    filePath: "src/app.ts",
    line: 11,
    suggestion: "Use JSON.parse instead.",
    impact: "Remote code execution",
  };

  it("accepts a well-formed finding and records it in the ledger", async () => {
    const deps = dependencies();
    const result = (await toolNamed(deps, "submit_finding").execute({
      findings: [good],
    })) as { accepted: unknown[]; instruction: string };

    expect(result.accepted).toHaveLength(1);
    expect(result.instruction).toMatch(/Post exactly one inline comment/);
    expect(deps.ledger.counts().accepted).toBe(1);
  });

  it("refuses a MAJOR with no fix, and says what to add", async () => {
    const result = (await toolNamed(dependencies(), "submit_finding").execute({
      findings: [{ ...good, suggestion: undefined }],
    })) as { rejected: Array<{ reason: string; detail: string }> };

    expect(result.rejected[0].reason).toBe("missing-fix");
    expect(result.rejected[0].detail).toMatch(/showing the corrected code/);
  });

  it("refuses a finding on a line the pull request did not touch", async () => {
    const result = (await toolNamed(dependencies(), "submit_finding").execute({
      findings: [{ ...good, line: 10 }],
    })) as { rejected: Array<{ reason: string }> };
    expect(result.rejected[0].reason).toBe("line-not-changed");
  });

  it("refuses a finding already posted in an earlier run", async () => {
    const deps = dependencies();
    const first = (await toolNamed(deps, "submit_finding").execute({
      findings: [good],
    })) as { accepted: Array<{ id: string }> };

    const again = (await toolNamed(
      dependencies({ alreadyReported: new Set([first.accepted[0].id]) }),
      "submit_finding",
    ).execute({ findings: [good] })) as { rejected: Array<{ reason: string }> };

    expect(again.rejected[0].reason).toBe("already-reported");
  });

  it("ignores malformed submissions instead of failing the turn", async () => {
    const result = (await toolNamed(dependencies(), "submit_finding").execute({
      findings: [
        { title: "no severity" },
        { severity: "NOPE", title: "bad" },
        good,
      ],
    })) as { accepted: unknown[] };
    expect(result.accepted).toHaveLength(1);
  });

  it("tells a dry run not to post", async () => {
    const result = (await toolNamed(
      dependencies({ dryRun: true }),
      "submit_finding",
    ).execute({
      findings: [good],
    })) as { instruction: string };
    expect(result.instruction).toMatch(/dry run/);
  });

  it("accumulates across calls so the second submission sees the first", async () => {
    const deps = dependencies();
    const tool = toolNamed(deps, "submit_finding");
    await tool.execute({ findings: [good] });
    const second = (await tool.execute({ findings: [good] })) as {
      rejected: Array<{ reason: string }>;
    };
    expect(second.rejected[0].reason).toBe("already-accepted");
  });
});

describe("incident-review regressions", () => {
  it("gitSafe refuses protected files, including through history", () => {
    // `git show HEAD:.env` reads the same bytes read_file refuses. The git
    // door must enforce the filesystem door's denials.
    const cases: Array<[string, boolean]> = [
      ["git show HEAD:.env", false],
      ["git show HEAD:config/.env.production", false],
      ["git log -p -- .npmrc", false],
      ["git show HEAD:deploy/id_rsa", false],
      ["git diff HEAD~1 -- .netrc", false],
      ["git show HEAD:src/app.ts", true],
      ["git log --oneline -5", true],
      ["git blame src/environment.ts", true],
    ];
    for (const [command, allowed] of cases) {
      expect({ command, allowed: parseGitCommand(command).allowed }).toEqual({
        command,
        allowed,
      });
    }
  });

  it("looksMutating flags write verbs without flagging pull-request reads", () => {
    const mutating = [
      "git_commit",
      "git_push",
      "git_reset",
      "create_or_update_file",
      "delete_branch",
      "merge_pull_request",
      "git_pull",
    ];
    const readOnly = [
      "pull_request_read",
      "list_pull_requests",
      "git_log",
      "git_diff",
      "git_status",
      "search_code",
      "get_file_contents",
    ];
    for (const name of mutating) {
      expect({ name, mutating: looksMutating(name) }).toEqual({
        name,
        mutating: true,
      });
    }
    for (const name of readOnly) {
      expect({ name, mutating: looksMutating(name) }).toEqual({
        name,
        mutating: false,
      });
    }
  });

  it("excludes unmapped mutating tools during review turns", () => {
    // A git MCP server connected without an allowlist used to leave
    // git_commit/git_push callable while the agent read an
    // attacker-controlled diff.
    const excluded = excludedToolsForStage(
      [
        {
          capability: "readPullRequest",
          serverId: "vcs",
          toolName: "pull_request_read",
          stages: ["review"],
          roles: ["main"],
        } as never,
      ],
      "review",
      "main",
      ["pull_request_read", "git_log", "git_commit", "git_push", "git_diff"],
    );
    expect(excluded.sort()).toEqual(["git_commit", "git_push"]);
  });

  it("strips a model-supplied id so identity stays content-derived", async () => {
    const ledger = new FindingLedger();
    const tool = submitFindingTool({
      entries: [],
      ledger,
      guards: [],
      ownership: [],
      checkResults: [],
      alreadyReported: new Set(),
      suppressed: new Set(),
      checkFlagged: new Set(),
      confidenceThreshold: 0,
      changedLinesOnly: false,
      dryRun: true,
    });

    const result = (await tool.execute({
      findings: [
        {
          id: "finding-1",
          severity: "MINOR",
          title: "model invented this id",
        },
      ],
    })) as { accepted: Array<{ id: string }> };

    expect(result.accepted).toHaveLength(1);
    // Content-derived, never the model's label — a per-run invented id would
    // defeat cross-run dedup and can be unscannable in a marker.
    expect(result.accepted[0].id).not.toBe("finding-1");
  });
});
