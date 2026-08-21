import { extractFindings } from "../../../src/v4/checks/extract.js";
import {
  deriveImpactReport,
  renderImpactReport,
} from "../../../src/v4/product/Capabilities.js";
import { entriesFromProduct } from "../../../src/v4/tools/recall.js";
import { createRunContext } from "../../../src/v4/core/RunContext.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  ChangeSet,
  CheckConfig,
  CheckRunResult,
  GenerateHost,
  ImpactLogEntry,
  ModelChain,
  ProductCapability,
  ResolvedConfig,
  RunContext,
} from "../../../src/v4/types/index.js";

const chain: ModelChain = {
  members: [{ provider: "alpha", model: "cheap" }],
  pool: { strategy: "priority", cooldownMs: 0, maxAttempts: 1 },
};

function context(): RunContext {
  const config = {
    ...optionalDefaults(),
    version: 4,
    ai: { provider: "alpha" },
    mcp: { servers: {} },
    projectRoot: "/repo",
    notices: [],
  } as unknown as ResolvedConfig;
  return createRunContext({
    config,
    identity: { provider: "test", owner: "acme", repo: "api" },
    mode: "dry-run",
  });
}

function host(response: Record<string, unknown> | Error): {
  host: GenerateHost;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    host: {
      generate: async (options: Record<string, unknown>) => {
        calls.push(options);
        if (response instanceof Error) {
          throw response;
        }
        return response as never;
      },
    },
  };
}

const check: CheckConfig = {
  id: "migrations",
  run: "./scripts/check-migrations.sh",
  parse: "agent",
  hint: "offending file is column 2",
};

const ran = (output: string): CheckRunResult => ({
  checkId: "migrations",
  status: "passed",
  durationMs: 10,
  findings: [],
  droppedFindings: 0,
  output,
});

describe("parse: agent extraction", () => {
  it("turns raw output into findings", async () => {
    const { host: h, calls } = host({
      content: "ok",
      structuredData: {
        findings: [
          {
            severity: "MAJOR",
            message: "migration 0042 has no down step",
            filePath: "db/0042.sql",
            line: 3,
          },
        ],
      },
    });

    const { result } = await extractFindings(
      ran("0042 FAIL db/0042.sql"),
      check,
      {
        host: h,
        chain,
        context: context(),
        instruction: "you are a parser",
      },
    );

    expect(result.findings).toEqual([
      {
        checkId: "migrations",
        severity: "MAJOR",
        message: "migration 0042 has no down step",
        filePath: "db/0042.sql",
        line: 3,
      },
    ]);
    // The project's hint reaches the extractor, and it sees the command it ran.
    const sent = (calls[0].input as { text: string }).text;
    expect(sent).toContain("offending file is column 2");
    expect(sent).toContain("./scripts/check-migrations.sh");
    // A parser, not a reviewer: no tools.
    expect(calls[0].disableTools).toBe(true);
  });

  it("records the check FAILED when extraction cannot answer", async () => {
    // The important one. "No findings" from a broken extraction reads exactly
    // like a clean check, which is the silence this architecture exists to
    // remove.
    const { host: h } = host(new Error("503 unavailable"));

    const { result } = await extractFindings(ran("some output"), check, {
      host: h,
      chain,
      context: context(),
      instruction: "i",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/could not be parsed into findings/);
    expect(result.findings).toEqual([]);
  });

  it("leaves a check with no output alone", async () => {
    const { host: h, calls } = host({});
    const { result } = await extractFindings(ran("   "), check, {
      host: h,
      chain,
      context: context(),
      instruction: "i",
    });

    expect(calls).toHaveLength(0);
    expect(result.status).toBe("passed");
  });

  it("applies the check's own severity mapping", async () => {
    const { host: h } = host({
      content: "ok",
      structuredData: {
        findings: [{ severity: "MAJOR", message: "noisy" }],
      },
    });

    const { result } = await extractFindings(
      ran("output"),
      { ...check, severity: { MAJOR: "MINOR" } },
      { host: h, chain, context: context(), instruction: "i" },
    );

    expect(result.findings[0].severity).toBe("MINOR");
  });

  it("says so when it only read part of the output", async () => {
    const { host: h } = host({
      content: "ok",
      structuredData: { findings: [] },
    });

    const { warnings } = await extractFindings(ran("x".repeat(30_000)), check, {
      host: h,
      chain,
      context: context(),
      instruction: "i",
    });

    expect(warnings.join(" ")).toMatch(/only the first 24000 were read/);
  });
});

describe("the product model", () => {
  const capabilities: ProductCapability[] = [
    {
      id: "checkout",
      name: "Checkout",
      paths: ["src/checkout/**"],
      userVisible: true,
      failureMode: "accepts the order but never charges the card",
      criticality: "high",
    },
    {
      id: "receipts",
      name: "Receipts",
      paths: ["src/receipts/**"],
      dependsOn: ["checkout"],
    },
    { id: "admin", name: "Admin", paths: ["src/admin/**"] },
  ];

  const log: ImpactLogEntry[] = [
    {
      pullRequestId: 10,
      mergedAt: "2026-01-01",
      capabilities: ["checkout"],
      changeKind: "behavior-change",
      summary: "reworked the charge path",
      laterCorrectedBy: [12],
    },
    {
      pullRequestId: 12,
      mergedAt: "2026-01-05",
      capabilities: ["checkout"],
      changeKind: "fix",
      summary: "fixed the double charge",
      corrects: [10],
    },
  ];

  const changeSet = {
    files: [{ path: "src/checkout/charge.ts" }],
    excluded: [],
  } as unknown as ChangeSet;

  it("names what the change touches and what depends on it", () => {
    const report = deriveImpactReport(capabilities, log, changeSet)!;

    expect(report.capabilities.map((entry) => entry.id)).toEqual(["checkout"]);
    expect(report.blastRadius).toContain("Receipts");
    expect(report.userVisibleEffect).toBe("Checkout");
    expect(report.silentFailureModes[0]).toMatch(/never charges the card/);
    expect(report.historicalRisk?.corrected).toBeGreaterThan(0);
  });

  it("returns nothing when the repository has no map", () => {
    expect(deriveImpactReport([], log, changeSet)).toBeUndefined();
  });

  it("returns nothing when the change touches nothing mapped", () => {
    const elsewhere = {
      files: [{ path: "docs/readme.md" }],
      excluded: [],
    } as unknown as ChangeSet;
    expect(deriveImpactReport(capabilities, log, elsewhere)).toBeUndefined();
  });

  it("renders a report a reviewer can read", () => {
    const rendered = renderImpactReport(
      deriveImpactReport(capabilities, log, changeSet)!,
    );
    expect(rendered).toContain("**Touches:** Checkout (high)");
    expect(rendered).toContain("**Fails silently:**");
    expect(rendered).toContain("**Historical risk:**");
  });

  it("makes capabilities retrievable, with their failure mode up front", () => {
    const entries = entriesFromProduct(capabilities, log);
    const checkout = entries.find((entry) => entry.id === "product.checkout")!;

    expect(checkout.kind).toBe("product");
    expect(checkout.paths).toEqual(["src/checkout/**"]);
    expect(checkout.summary).toMatch(/Fails by: accepts the order/);
    expect(checkout.summary).toMatch(/needed a follow-up fix/);
    expect(checkout.body).toMatch(/#12: fixed the double charge/);
    // A high-criticality capability outranks the rest at recall time.
    expect(checkout.weight).toBe(3);
  });

  it("describes a capability with nothing recorded about it", () => {
    const entries = entriesFromProduct(capabilities, []);
    const admin = entries.find((entry) => entry.id === "product.admin")!;
    expect(admin.summary).toBe("Implemented by src/admin/**.");
  });
});
