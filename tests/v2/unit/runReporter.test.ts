/**
 * RunReporter — the per-run report artifact (markdown + JSON).
 */

import { describe, it, expect } from "@jest/globals";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunReporter } from "../../../src/v2/core/RunReporter.js";
import { ReviewResult } from "../../../src/v2/types/index.js";

const meta = () => ({
  sessionId: "yama-test-1234",
  workspace: "PICAF",
  repository: "curator",
  pullRequestId: 496,
  provider: "bitbucket",
  aiProvider: "vertex",
  aiModel: "claude",
  dryRun: false,
  startedAt: "2026-07-28T08:00:00.000Z",
});

const result = (): ReviewResult => ({
  mode: "pr",
  prId: 496,
  decision: "CHANGES_REQUESTED",
  statistics: {
    filesReviewed: 2,
    issuesFound: { critical: 0, major: 1, minor: 0, suggestions: 0 },
    requirementCoverage: 0,
    codeQualityScore: 0,
    toolCallsMade: 0,
    cacheHits: 0,
    totalComments: 1,
  },
  summary: "One verified finding.",
  duration: 120,
  tokenUsage: { input: 100, output: 200, total: 300 },
  costEstimate: 0.5,
  sessionId: "yama-test-1234",
  completion: {
    stopReason: "step-cap",
    stepsUsed: 100,
    jsonTruncated: false,
    jsonRepaired: false,
    partial: true,
  },
  issues: [
    {
      id: "abc",
      severity: "MAJOR",
      category: "correctness",
      title: "Envelope may still exceed the cap",
      description: "d",
      filePath: "src/features/tara/services/mcp.ts",
      line: 122,
    },
  ],
  ungatedIssues: [
    {
      id: "issue-4",
      severity: "MAJOR",
      category: "conventions",
      title: "Fabricated rule restatement",
      description: "d",
    },
  ],
});

describe("RunReporter", () => {
  it("writes a markdown report containing findings, quarantine, and timeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yama-report-"));
    const reporter = new RunReporter(meta());
    reporter.record({ kind: "bootstrap", chars: 1670 });
    reporter.record({
      kind: "explore",
      task: "Check truncateMCPResult envelope math",
      cached: false,
      summary: "Envelope can exceed maxBytes after per-item shrink.",
    });
    reporter.record({
      kind: "submit",
      mode: "basic",
      accepted: [
        {
          severity: "MAJOR",
          title: "Envelope may still exceed the cap",
          filePath: "src/features/tara/services/mcp.ts",
          line: 122,
        },
      ],
      rejected: [
        {
          severity: "MINOR",
          title: "Weak claim",
          reason: "refuted by verification: no evidence",
        },
      ],
    });
    reporter.record({ kind: "finalization", outcome: "verdict" });

    const path = await reporter.write({ enabled: true, path: dir }, result());
    expect(path).toBe(join(dir, "yama-test-1234.md"));

    const markdown = await readFile(path as string, "utf8");
    expect(markdown).toContain("PICAF/curator PR #496");
    expect(markdown).toContain("**PARTIAL**");
    expect(markdown).toContain("Envelope may still exceed the cap");
    expect(markdown).toContain("Quarantined claims (1)");
    expect(markdown).toContain("Fabricated rule restatement");
    expect(markdown).toContain(
      "🔎 Explore: Check truncateMCPResult envelope math",
    );
    expect(markdown).toContain("1 accepted, 1 rejected");
    expect(markdown).toContain("📮 Finalization: verdict");

    const raw = JSON.parse(
      await readFile(join(dir, "yama-test-1234.json"), "utf8"),
    );
    expect(raw.timeline).toHaveLength(4);
    expect(raw.outcome.decision).toBe("CHANGES_REQUESTED");
  });

  it("is disabled by config and never throws on unwritable paths", async () => {
    const reporter = new RunReporter(meta());
    expect(await reporter.write({ enabled: false }, result())).toBeNull();

    const broken = new RunReporter(meta());
    // Report dir nested under a regular file — mkdir must fail.
    const base = await mkdtemp(join(tmpdir(), "yama-report-"));
    const blocker = join(base, "blocker");
    await writeFile(blocker, "x", "utf8");
    const path = await broken.write(
      { enabled: true, path: join(blocker, "nope") },
      result(),
    );
    expect(path).toBeNull();
  });

  it("writes an error-only report when the run failed before a result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yama-report-"));
    const reporter = new RunReporter(meta());
    reporter.record({ kind: "bootstrap", chars: 10 });
    const path = await reporter.write(
      { enabled: true, path: dir },
      undefined,
      "provider \\| exploded\nwith a stack trace",
    );
    expect(path).toBe(join(dir, "yama-test-1234.md"));
    const markdown = await readFile(path as string, "utf8");
    // Free text is flattened, with backslashes escaped BEFORE pipes — a
    // pre-existing "\|" in the input must not re-arm the pipe and break the
    // table row (CodeQL js/incomplete-sanitization).
    expect(markdown).toContain(
      "| Error | provider \\\\\\| exploded with a stack trace |",
    );
    expect(markdown).toContain("🧭 Bootstrapped repo standards");
  });
});
