import {
  formatDoctorReport,
  inspectCapabilities,
  inspectConfig,
  inspectModelSlots,
  inspectRegistrations,
  runDoctor,
} from "../../../src/v4/core/Doctor.js";
import { resolveModelChains } from "../../../src/v4/core/NeurolinkFactory.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  CapabilityReport,
  McpServerConfig,
  ResolvedConfig,
} from "../../../src/v4/types/index.js";

function configWith(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    version: 4,
    ai: { provider: "vertex", model: "big" },
    mcp: {
      servers: {
        vcs: {
          url: "u",
          capabilities: { readPullRequest: "get_pr" },
        } as McpServerConfig,
      },
    },
    projectRoot: "/repo",
    notices: [],
    ...optionalDefaults(),
    ...overrides,
  } as ResolvedConfig;
}

const find = (checks: Array<{ name: string }>, name: string) =>
  checks.find((check) => check.name === name);

describe("inspectConfig", () => {
  it("fails when no server is enabled", () => {
    const checks = inspectConfig(configWith({ mcp: { servers: {} } }));
    expect(find(checks, "connections")?.status).toBe("fail");
    expect(find(checks, "connections")?.remedy).toMatch(
      /cannot read a pull request/,
    );
  });

  it("warns when no server declares capabilities", () => {
    const checks = inspectConfig(
      configWith({ mcp: { servers: { vcs: { url: "u" } } } }),
    );
    expect(find(checks, "capability map")?.status).toBe("warn");
  });

  it("warns loudly when checks are allowed to run on forks", () => {
    const checks = inspectConfig(
      configWith({
        checks: {
          enabled: true,
          allowForks: true,
          checks: [{ id: "lint", run: "pnpm lint" }],
        },
      }),
    );
    expect(find(checks, "checks")?.status).toBe("warn");
    expect(find(checks, "checks")?.remedy).toMatch(/arbitrary code execution/);
  });

  it("is content when command checks are blocked for forks", () => {
    const checks = inspectConfig(
      configWith({
        checks: {
          enabled: true,
          allowForks: false,
          checks: [{ id: "lint", run: "pnpm lint" }],
        },
      }),
    );
    expect(find(checks, "checks")?.status).toBe("ok");
  });

  it("notes that blocking ownership needs approval reads", () => {
    const checks = inspectConfig(
      configWith({
        ownership: [
          { id: "core", paths: ["src/**"], owners: ["@a"], blocking: true },
        ],
      }),
    );
    expect(find(checks, "ownership")?.detail).toMatch(
      /listApprovals is required/,
    );
  });

  it("warns that a project with learning off never improves", () => {
    const checks = inspectConfig(configWith());
    expect(find(checks, "learning")?.status).toBe("warn");
    expect(find(checks, "learning")?.remedy).toMatch(/never improve/);
  });

  it("fails a rebase repo that learns on push instead of the merge event", () => {
    const checks = inspectConfig(
      configWith({
        learn: { trigger: "push", mergeStrategy: "rebase", mode: "commit" },
      }),
    );
    expect(find(checks, "learning")?.status).toBe("fail");
    expect(find(checks, "learning")?.remedy).toMatch(/wrong pull request/);
  });

  it("accepts a rebase repo that learns on the merge event", () => {
    const checks = inspectConfig(
      configWith({
        learn: {
          trigger: "merge-event",
          mergeStrategy: "rebase",
          mode: "commit",
        },
      }),
    );
    expect(find(checks, "learning")?.status).toBe("ok");
  });
});

describe("inspectRegistrations", () => {
  it("fails a server that could not register and says where to look", () => {
    const [check] = inspectRegistrations([
      { id: "vcs", ok: false, tools: [], error: "401" },
    ]);
    expect(check.status).toBe("fail");
    expect(check.remedy).toMatch(/credentials/);
  });

  it("warns on a server that connected but exposed nothing", () => {
    const [check] = inspectRegistrations([{ id: "vcs", ok: true, tools: [] }]);
    expect(check.status).toBe("warn");
    expect(check.remedy).toMatch(/credential or scope/);
  });

  it("reports allowlist enforcement", () => {
    const [check] = inspectRegistrations([
      { id: "vcs", ok: true, tools: ["a"], allowlistEnforced: true },
    ]);
    expect(check.detail).toMatch(/allowlist enforced/);
  });
});

describe("inspectCapabilities", () => {
  const report: CapabilityReport = {
    resolved: [],
    missing: [
      {
        capability: "postSummary",
        serverId: "vcs",
        declared: "wrong_tool",
        available: ["get_pr", "add_comment"],
      },
    ],
    registrations: [],
  };

  it("fails a live run and names the tools that do exist", () => {
    const checks = inspectCapabilities(report, "live");
    const missing = checks.find(
      (check) => check.name === "capability:postSummary",
    );
    expect(missing?.status).toBe("fail");
    expect(missing?.remedy).toMatch(/get_pr, add_comment/);
  });

  it("only warns in dry-run, where posting is not the point", () => {
    const checks = inspectCapabilities(report, "dry-run");
    expect(checks.every((check) => check.status !== "fail")).toBe(true);
  });

  it("flags every required capability nothing provides", () => {
    const names = inspectCapabilities(
      { resolved: [], missing: [], registrations: [] },
      "live",
    ).map((check) => check.name);

    expect(names).toContain("capability:readPullRequest");
    expect(names).toContain("capability:postInlineComment");
    expect(names).toContain("capability:postSummary");
  });

  it("is satisfied when everything resolves", () => {
    const checks = inspectCapabilities(
      {
        resolved: [
          {
            capability: "readPullRequest",
            serverId: "v",
            toolName: "t",
            stages: [],
            roles: [],
          },
          {
            capability: "postInlineComment",
            serverId: "v",
            toolName: "t",
            stages: [],
            roles: [],
          },
          {
            capability: "postSummary",
            serverId: "v",
            toolName: "t",
            stages: [],
            roles: [],
          },
        ],
        missing: [],
        registrations: [],
      },
      "live",
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ok");
  });
});

describe("inspectModelSlots", () => {
  it("says nothing extra when probe-only slots have a single member", () => {
    const checks = inspectModelSlots(
      resolveModelChains(
        configWith({ ai: { provider: "vertex", model: "big" } }),
      ),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ok");
  });

  it("warns that a multi-member chain on a probe-only slot cannot pool", () => {
    const checks = inspectModelSlots(
      resolveModelChains(
        configWith({
          ai: {
            provider: "vertex",
            model: "big",
            compaction: { provider: ["vertex", "litellm"], model: ["a", "b"] },
          },
        }),
      ),
    );
    const warning = checks.find((check) => /probe-only/.test(check.name));
    expect(warning?.status).toBe("warn");
    expect(warning?.remedy).toMatch(/between runs but not mid-run/);
  });
});

describe("runDoctor", () => {
  it("rolls up to the worst status", () => {
    const report = runDoctor({
      config: configWith({ mcp: { servers: {} } }),
      mode: "live",
    });
    expect(report.status).toBe("fail");
  });

  it("reports every model slot", () => {
    const report = runDoctor({ config: configWith(), mode: "dry-run" });
    expect(report.slots).toHaveLength(8);
  });

  it("surfaces loader notices as checks", () => {
    const report = runDoctor({
      config: configWith({
        notices: [{ level: "warn", message: 'Duplicate rule id "dup"' }],
      }),
      mode: "dry-run",
    });
    expect(
      report.checks.some((check) => /Duplicate rule id/.test(check.detail)),
    ).toBe(true);
  });
});

describe("formatDoctorReport", () => {
  it("renders remedies and distinguishes pooled from probe-only slots", () => {
    const output = formatDoctorReport(
      runDoctor({ config: configWith({ mcp: { servers: {} } }), mode: "live" }),
    );
    expect(output).toMatch(/✗ connections/);
    expect(output).toMatch(/→ Add at least one server/);
    expect(output).toMatch(/review .*fails over mid-run/);
    expect(output).toMatch(/compaction .*resolved at startup/);
    expect(output).toMatch(/Not ready/);
  });
});
