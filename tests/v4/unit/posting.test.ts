import { mkdtempSync, rmSync } from "node:fs";
import { extractCommentId } from "../../../src/v4/findings/Ledger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  postInlineComment,
  postMissingFindings,
  postOwnersComment,
  postSummary,
  setReviewStatus,
  type PostingContext,
} from "../../../src/v4/tools/posting.js";
import {
  renderFindingComment,
  renderSummaryComment,
} from "../../../src/v4/tools/commentFormat.js";
import {
  compactContext,
  emptyArtifact,
  lastReviewedSha,
  loadArtifact,
  recordRun,
  reportedIds,
  saveArtifact,
  summarizeForRecall,
} from "../../../src/v4/artifacts/PrArtifact.js";
import { FindingLedger } from "../../../src/v4/findings/Ledger.js";
import { CapabilityResolver } from "../../../src/v4/connections/Capabilities.js";
import type {
  CapabilityReport,
  ExistingComment,
  IdentifiedFinding,
  PostedFinding,
  Verdict,
} from "../../../src/v4/types/index.js";

const report: CapabilityReport = {
  resolved: [
    {
      capability: "postInlineComment",
      serverId: "vcs",
      toolName: "add_comment",
      stages: ["post"],
      roles: ["main"],
    },
    {
      capability: "postSummary",
      serverId: "vcs",
      toolName: "add_summary",
      stages: ["post"],
      roles: ["main"],
    },
    {
      capability: "updateComment",
      serverId: "vcs",
      toolName: "edit_comment",
      stages: ["post"],
      roles: ["main"],
    },
    {
      capability: "setStatus",
      serverId: "vcs",
      toolName: "set_status",
      stages: ["verdict"],
      roles: ["main"],
    },
  ],
  missing: [],
  registrations: [],
};

function contextWith(
  invoke: PostingContext["invoke"],
  overrides: Partial<PostingContext> = {},
): PostingContext {
  return {
    resolver: new CapabilityResolver(report),
    invoke,
    mode: "live",
    stage: "post",
    botIdentity: "yama-bot",
    target: { owner: "o", repo: "r", pull_number: 1 },
    ...overrides,
  };
}

const finding = (
  overrides: Partial<IdentifiedFinding> = {},
): IdentifiedFinding => ({
  id: "f1",
  severity: "MAJOR",
  title: "Unsafe eval",
  description: "eval on request input",
  impact: "Remote code execution",
  suggestion: "const x = JSON.parse(input);",
  filePath: "src/app.ts",
  line: 11,
  source: "agent",
  ...overrides,
});

describe("renderFindingComment", () => {
  it("carries what is wrong, what it costs, and how to fix it", () => {
    const body = renderFindingComment(finding());
    expect(body).toMatch(/^⚠️ MAJOR: Unsafe eval/);
    expect(body).toMatch(/\*\*Why it matters:\*\* Remote code execution/);
    expect(body).toMatch(/\*\*Fix:\*\*/);
    expect(body).toMatch(/```\nconst x = JSON\.parse\(input\);\n```/);
  });

  it("does not double-fence a suggestion that already has one", () => {
    const body = renderFindingComment(
      finding({ suggestion: "```ts\nconst x = 1;\n```" }),
    );
    expect(body).not.toMatch(/```\n```/);
    expect((body.match(/```/g) ?? []).length).toBe(2);
  });

  it("leaves prose guidance unfenced", () => {
    const body = renderFindingComment(
      finding({ suggestion: "Move this call behind the feature flag." }),
    );
    expect(body).not.toMatch(/```/);
  });

  it("cites the rule and the check when present", () => {
    const body = renderFindingComment(
      finding({ ruleId: "conv.no-eval", checkId: "lint" }),
    );
    expect(body).toMatch(/_Rule: `conv\.no-eval`_/);
    expect(body).toMatch(/_Reported by `lint`_/);
  });

  it("does not repeat the title as the description", () => {
    const body = renderFindingComment(finding({ description: "Unsafe eval" }));
    expect((body.match(/Unsafe eval/g) ?? []).length).toBe(1);
  });

  it("uses the right marker per severity", () => {
    expect(renderFindingComment(finding({ severity: "CRITICAL" }))).toMatch(
      /🔒 CRITICAL/,
    );
    expect(renderFindingComment(finding({ severity: "MINOR" }))).toMatch(
      /💡 MINOR/,
    );
    expect(renderFindingComment(finding({ severity: "SUGGESTION" }))).toMatch(
      /💬 SUGGESTION/,
    );
  });
});

describe("posting", () => {
  const posted = (id: string): IdentifiedFinding =>
    finding({ id, title: `t-${id}` });

  it("embeds the finding marker so re-runs can dedup from the PR itself", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await postInlineComment(
      contextWith(async (_tool, params) => {
        calls.push(params);
        return { id: "c1" };
      }),
      finding(),
    );
    expect(String(calls[0].body)).toMatch(/<!-- yama:finding:f1 -->/);
  });

  it("posts every accepted finding that has no confirmed comment", async () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [posted("a"), posted("b")], rejected: [] });

    const outcome = await postMissingFindings(
      contextWith(async () => ({ id: "c-new" })),
      ledger,
    );

    expect(outcome.posted).toHaveLength(2);
    expect(ledger.unposted).toEqual([]);
  });

  it("does not re-post a finding already confirmed this run", async () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [posted("a"), posted("b")], rejected: [] });
    ledger.recordPosted("a", "c1");

    let calls = 0;
    await postMissingFindings(
      contextWith(async () => {
        calls += 1;
        return { id: "c2" };
      }),
      ledger,
    );
    expect(calls).toBe(1);
  });

  it("treats a result with no comment id as UNPOSTED, never as success", async () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [posted("a")], rejected: [] });

    const outcome = await postMissingFindings(
      contextWith(async () => ({ ok: true })),
      ledger,
    );

    expect(outcome.posted).toEqual([]);
    expect(outcome.failures[0].error).toMatch(/cannot be confirmed/);
    expect(ledger.unposted).toHaveLength(1);
  });

  it("records a failure per finding without abandoning the rest", async () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [posted("a"), posted("b")], rejected: [] });

    let call = 0;
    const outcome = await postMissingFindings(
      contextWith(async () => {
        call += 1;
        if (call === 1) {
          throw new Error("rate limited");
        }
        return { id: "c2" };
      }),
      ledger,
    );

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.posted).toHaveLength(1);
  });

  it("writes nothing in dry-run", async () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [posted("a")], rejected: [] });

    let calls = 0;
    const outcome = await postMissingFindings(
      contextWith(
        async () => {
          calls += 1;
          return { id: "c" };
        },
        { mode: "dry-run" },
      ),
      ledger,
    );

    expect(calls).toBe(0);
    expect(outcome.skipped).toBe(1);
  });
});

describe("summary comment", () => {
  const existing: ExistingComment[] = [
    {
      id: "c9",
      author: "yama-bot",
      body: "old summary\n<!-- yama:summary -->",
    },
  ];

  it("creates a summary when none exists", async () => {
    const result = await postSummary(
      contextWith(async () => ({ id: "c1" })),
      "body",
      [],
    );
    expect(result.status).toBe("created");
  });

  it("updates in place rather than duplicating", async () => {
    const tools: string[] = [];
    const result = await postSummary(
      contextWith(async (tool) => {
        tools.push(tool);
        return { id: "c9" };
      }),
      "body",
      existing,
    );
    expect(result.status).toBe("updated");
    expect(tools).toEqual(["edit_comment"]);
  });

  it("never edits a comment Yama did not author, even with a marker", async () => {
    const tools: string[] = [];
    await postSummary(
      contextWith(async (tool) => {
        tools.push(tool);
        return { id: "new" };
      }),
      "body",
      [{ id: "c9", author: "alice", body: "<!-- yama:summary -->" }],
    );
    expect(tools).toEqual(["add_summary"]);
  });

  it("falls back to creating when there is no update capability", async () => {
    const noUpdate = new CapabilityResolver({
      ...report,
      resolved: report.resolved.filter(
        (entry) => entry.capability !== "updateComment",
      ),
    });
    const result = await postSummary(
      contextWith(async () => ({ id: "c1" }), { resolver: noUpdate }),
      "body",
      existing,
    );
    expect(result.status).toBe("created");
  });

  it("reports a failure rather than claiming success without a comment id", async () => {
    const result = await postSummary(
      contextWith(async () => ({})),
      "body",
      [],
    );
    expect(result.status).toBe("failed");
  });

  it("appends the summary marker", async () => {
    let body = "";
    await postSummary(
      contextWith(async (_tool, params) => {
        body = String(params.body);
        return { id: "c" };
      }),
      "body",
      [],
    );
    expect(body).toMatch(/<!-- yama:summary -->/);
  });

  it("skips in dry-run", async () => {
    const result = await postSummary(
      contextWith(async () => ({ id: "c" }), { mode: "dry-run" }),
      "body",
      [],
    );
    expect(result.status).toBe("skipped");
  });
});

describe("owners comment and status", () => {
  it("does not double-append an owners marker the body already carries", async () => {
    let body = "";
    await postOwnersComment(
      contextWith(async (_tool, params) => {
        body = String(params.body);
        return { id: "c" };
      }),
      "table\n<!-- yama:owners -->",
      [],
    );
    expect((body.match(/yama:owners/g) ?? []).length).toBe(1);
  });

  it("sets the review status through the capability", async () => {
    const calls: string[] = [];
    const result = await setReviewStatus(
      contextWith(
        async (tool) => {
          calls.push(tool);
          return {};
        },
        { stage: "verdict" },
      ),
      "BLOCKED",
    );
    expect(result.status).toBe("set");
    expect(calls).toEqual(["set_status"]);
  });

  it("skips silently when no status capability is configured", async () => {
    const result = await setReviewStatus(
      contextWith(async () => ({}), { stage: "post" }),
      "APPROVED",
    );
    expect(result.status).toBe("skipped");
  });
});

describe("renderSummaryComment", () => {
  const verdict: Verdict = {
    decision: "BLOCKED",
    reasons: ["1 critical finding(s)."],
    advisory: false,
  };
  const postedFinding: PostedFinding = {
    id: "a",
    severity: "CRITICAL",
    title: "Unsafe eval",
    filePath: "src/app.ts",
    line: 11,
    source: "agent",
    postedCommentId: "c1",
    postedAt: new Date(0).toISOString(),
  };

  const base = {
    verdict,
    posted: [postedFinding],
    unposted: [],
    checks: [],
    filesReviewed: 3,
    filesExcluded: 1,
    truncated: false,
    degradedStages: [],
  };

  it("leads with the decision and its reasons", () => {
    const body = renderSummaryComment(base);
    expect(body).toMatch(/\*\*BLOCKED\*\*/);
    expect(body).toMatch(/- 1 critical finding/);
  });

  it("marks an advisory verdict as advisory", () => {
    const body = renderSummaryComment({
      ...base,
      verdict: { ...verdict, advisory: true },
    });
    expect(body).toMatch(/advisory — verdict enforcement is off/);
  });

  it("SURFACES unposted findings rather than implying a clean review", () => {
    const body = renderSummaryComment({
      ...base,
      unposted: [
        { id: "b", severity: "MAJOR", title: "Missed one", source: "agent" },
      ],
    });
    expect(body).toMatch(/could not be posted as inline comments/);
    expect(body).toMatch(/Missed one/);
  });

  it("reports scope, including truncation", () => {
    expect(renderSummaryComment(base)).toMatch(
      /3 file\(s\) reviewed, 1 excluded/,
    );
    expect(renderSummaryComment({ ...base, truncated: true })).toMatch(
      /file limit reached/,
    );
  });

  it("says when the review did not complete every stage", () => {
    expect(
      renderSummaryComment({ ...base, degradedStages: ["checks"] }),
    ).toMatch(/did not complete every stage \(checks\)/);
  });

  it("renders a check table including dropped findings", () => {
    const body = renderSummaryComment({
      ...base,
      checks: [
        { checkId: "lint", status: "failed", findings: 25, dropped: 12 },
      ],
    });
    expect(body).toMatch(/\| `lint` \| failed \| 25 \(\+12 not shown\) \|/);
  });

  it("says plainly when there are no findings", () => {
    expect(renderSummaryComment({ ...base, posted: [] })).toMatch(
      /No findings\./,
    );
  });

  it("includes the impact narrative when one exists", () => {
    expect(
      renderSummaryComment({ ...base, impact: "Touches the posting path." }),
    ).toMatch(/### Impact/);
  });
});

describe("PR artifact", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yama-artifact-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ledgerSnapshot = (
    posted: PostedFinding[],
    rejected: FindingLedger["rejected"] = [],
  ) => ({
    submitted: posted.length,
    accepted: posted as IdentifiedFinding[],
    rejected,
    posted,
    unposted: [],
  });

  const postedFinding = (id: string): PostedFinding => ({
    id,
    severity: "MAJOR",
    title: `finding ${id}`,
    filePath: "src/app.ts",
    line: 11,
    source: "agent",
    postedCommentId: `c-${id}`,
    postedAt: new Date(0).toISOString(),
  });

  it("returns an empty artifact when none exists — absence is not an error", async () => {
    const { artifact, existed } = await loadArtifact(root, 42);
    expect(existed).toBe(false);
    expect(artifact.pullRequestId).toBe(42);
  });

  it("round-trips through disk", async () => {
    const artifact = recordRun(emptyArtifact(42), {
      sha: "abc",
      at: new Date(0).toISOString(),
      decision: "BLOCKED",
      ledger: ledgerSnapshot([postedFinding("a")]),
      degradedStages: [],
    });
    await saveArtifact(root, artifact);

    const loaded = await loadArtifact(root, 42);
    expect(loaded.existed).toBe(true);
    expect(loaded.artifact.findings.posted).toHaveLength(1);
    expect(lastReviewedSha(loaded.artifact)).toBe("abc");
  });

  it("degrades to empty on a corrupt artifact and says why", async () => {
    const artifact = emptyArtifact(42);
    await saveArtifact(root, artifact);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(root, "artifacts", "pr-42", "artifact.json"),
      "{ broken",
      "utf-8",
    );

    const loaded = await loadArtifact(root, 42);
    expect(loaded.existed).toBe(false);
    expect(loaded.warning).toMatch(/Could not read/);
  });

  it("accumulates across runs without duplicating findings", async () => {
    let artifact = recordRun(emptyArtifact(1), {
      sha: "s1",
      at: "t1",
      ledger: ledgerSnapshot([postedFinding("a")]),
      degradedStages: [],
    });
    artifact = recordRun(artifact, {
      sha: "s2",
      at: "t2",
      ledger: ledgerSnapshot([postedFinding("a"), postedFinding("b")]),
      degradedStages: [],
    });

    expect(artifact.findings.posted.map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
    expect(artifact.reviewedShas).toEqual(["s1", "s2"]);
    expect(artifact.runs).toHaveLength(2);
  });

  it("records ONLY posted findings — an unposted one must not be suppressed later", () => {
    const artifact = recordRun(emptyArtifact(1), {
      sha: "s1",
      at: "t1",
      ledger: {
        submitted: 2,
        accepted: [postedFinding("a"), postedFinding("b")],
        rejected: [],
        posted: [postedFinding("a")],
        unposted: [postedFinding("b")],
      },
      degradedStages: [],
    });

    expect([...reportedIds(artifact)]).toEqual(["a"]);
  });

  it("keeps the newest notes when context grows past the cap", () => {
    const compacted = compactContext(
      `${"old ".repeat(10_000)}\nrecent insight`,
    );
    expect(compacted.length).toBeLessThan(25_000);
    expect(compacted).toMatch(/recent insight/);
    expect(compacted).toMatch(/earlier notes trimmed/);
  });

  it("summarizes prior runs for recall, listing what must not be repeated", () => {
    const artifact = recordRun(emptyArtifact(7), {
      sha: "abc123",
      at: "t1",
      ledger: ledgerSnapshot([postedFinding("a")]),
      degradedStages: [],
      impact: "Touches the gate.",
      contextAppend: "The gate rewrite is the risky part.",
    });

    const summary = summarizeForRecall(artifact, {
      provider: "github",
      owner: "juspay",
      repo: "yama",
      pullRequestId: 7,
    });

    expect(summary).toMatch(/This is run 2/);
    expect(summary).toMatch(/Last reviewed commit: abc123/);
    expect(summary).toMatch(/do not repeat them/);
    expect(summary).toMatch(/finding a/);
    expect(summary).toMatch(/Touches the gate\./);
    expect(summary).toMatch(/gate rewrite is the risky part/);
  });

  it("says nothing on a first run", () => {
    expect(
      summarizeForRecall(emptyArtifact(1), {
        provider: "github",
        owner: "o",
        repo: "r",
      }),
    ).toBe("");
  });
});

describe("comment-id extraction refuses prose", () => {
  it("accepts identifier-shaped values and rejects sentences", () => {
    // A server returning plain text ("Comment added successfully") without an
    // id used to have that sentence accepted AS the id — a failed or
    // unconfirmed post recorded as posted, embedded in a marker that could
    // never be re-scanned.
    const cases: Array<[unknown, string | undefined]> = [
      ["12345", "12345"],
      [67890, "67890"],
      ["c-abc_DEF-123", "c-abc_DEF-123"],
      ["Comment added successfully", undefined],
      ["API rate limit exceeded", undefined],
      ["", undefined],
      [{ id: 42 }, "42"],
      [null, undefined],
    ];
    for (const [input, expected] of cases) {
      expect({ input, id: extractCommentId(input) }).toEqual({
        input,
        id: expected,
      });
    }
  });
});
