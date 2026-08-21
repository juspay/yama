import {
  assembleRun,
  buildRunMessage,
  resolveBranch,
} from "../../../src/v4/core/RunAssembly.js";
import {
  emptyArtifact,
  recordRun,
} from "../../../src/v4/artifacts/PrArtifact.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import type {
  ExistingComment,
  PostedFinding,
  RuleEntry,
  RunIdentity,
} from "../../../src/v4/types/index.js";

const identity: RunIdentity = {
  provider: "github",
  owner: "juspay",
  repo: "yama",
  pullRequestId: 7,
};

const posted = (id: string): PostedFinding => ({
  id,
  severity: "MAJOR",
  title: `finding ${id}`,
  source: "agent",
  postedCommentId: `c-${id}`,
  postedAt: new Date(0).toISOString(),
});

const artifactWith = (ids: string[], sha = "sha1") =>
  recordRun(emptyArtifact(7), {
    sha,
    at: "t",
    ledger: {
      submitted: ids.length,
      accepted: ids.map(posted),
      rejected: [],
      posted: ids.map(posted),
      unposted: [],
    },
    degradedStages: [],
  });

const botComment = (findingId: string): ExistingComment => ({
  id: `c-${findingId}`,
  author: "yama-bot",
  body: `something\n<!-- yama:finding:${findingId} -->`,
});

const changeSet = buildChangeSet({
  diff: `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,1 +1,3 @@
 a
+b
+c
`,
  excludePatterns: [],
  maxFiles: 100,
});

describe("first run", () => {
  it("has nothing already reported", () => {
    const assembly = assembleRun({
      identity,
      comments: [],
      artifact: emptyArtifact(7),
      rules: [],
      botIdentity: "yama-bot",
    });

    expect(assembly.isRerun).toBe(false);
    expect(assembly.runNumber).toBe(1);
    expect(assembly.alreadyReported.size).toBe(0);
    expect(assembly.warnings).toEqual([]);
  });
});

describe("markers are the authority", () => {
  it("uses comment markers as already-reported", () => {
    const assembly = assembleRun({
      identity,
      comments: [botComment("f1"), botComment("f2")],
      artifact: artifactWith(["f1", "f2"]),
      rules: [],
      botIdentity: "yama-bot",
    });

    expect([...assembly.alreadyReported].sort()).toEqual(["f1", "f2"]);
    expect(assembly.isRerun).toBe(true);
    expect(assembly.runNumber).toBe(2);
  });

  it("RAISES AGAIN a finding the artifact claims posted but the PR does not show", () => {
    const assembly = assembleRun({
      identity,
      comments: [botComment("f1")],
      artifact: artifactWith(["f1", "f2"]),
      rules: [],
      botIdentity: "yama-bot",
    });

    // f2 never landed. Believing the artifact would silence it forever.
    expect(assembly.alreadyReported.has("f2")).toBe(false);
    expect(assembly.warnings.join(" ")).toMatch(
      /no comment on the pull request/,
    );
  });

  it("survives a lost artifact entirely, working from the pull request", () => {
    const assembly = assembleRun({
      identity,
      comments: [botComment("f1")],
      artifact: emptyArtifact(7),
      rules: [],
      botIdentity: "yama-bot",
    });

    expect([...assembly.alreadyReported]).toEqual(["f1"]);
    expect(assembly.isRerun).toBe(true);
    expect(assembly.warnings.join(" ")).toMatch(/no artifact/);
  });

  it("ignores a marker quoted by a human and says it did", () => {
    const assembly = assembleRun({
      identity,
      comments: [
        {
          id: "x",
          author: "alice",
          body: "as Yama said <!-- yama:finding:f9 -->",
        },
      ],
      artifact: emptyArtifact(7),
      rules: [],
      botIdentity: "yama-bot",
    });

    expect(assembly.alreadyReported.has("f9")).toBe(false);
    expect(assembly.warnings.join(" ")).toMatch(
      /must never suppress a finding/,
    );
  });
});

describe("recall entries", () => {
  const rules: RuleEntry[] = [
    { id: "conv.a", title: "A", summary: "s" },
    { id: "suppress.f9", title: "Noisy", summary: "s", status: "suppressed" },
  ];

  it("includes rules and this pull request's own history", () => {
    const assembly = assembleRun({
      identity,
      comments: [],
      artifact: artifactWith(["f1"]),
      rules,
      botIdentity: "yama-bot",
    });

    const ids = assembly.entries.map((entry) => entry.id);
    expect(ids).toContain("conv.a");
    expect(ids).toContain("pr-7");
  });

  it("strips the suppress prefix so suppression matches finding ids", () => {
    const assembly = assembleRun({
      identity,
      comments: [],
      artifact: emptyArtifact(7),
      rules,
      botIdentity: "yama-bot",
    });
    expect([...assembly.suppressed]).toEqual(["f9"]);
  });

  it("carries the previous sha for an incremental diff", () => {
    const assembly = assembleRun({
      identity,
      comments: [],
      artifact: artifactWith(["f1"], "abc123"),
      rules: [],
      botIdentity: "yama-bot",
    });
    expect(assembly.previousSha).toBe("abc123");
  });
});

describe("run message", () => {
  it("states the size of the change on a first run", () => {
    const message = buildRunMessage(
      assembleRun({
        identity,
        comments: [],
        artifact: emptyArtifact(7),
        rules: [],
      }),
      changeSet,
    );
    expect(message).toMatch(/1 file\(s\) changed, \+2\/-0 lines/);
    expect(message).not.toMatch(/Run 2/);
  });

  it("points a re-run at the delta and forbids repeating itself", () => {
    const message = buildRunMessage(
      assembleRun({
        identity,
        comments: [botComment("f1")],
        artifact: artifactWith(["f1"], "abc123"),
        rules: [],
        botIdentity: "yama-bot",
      }),
      changeSet,
    );

    expect(message).toMatch(/Run 2 on this pull request/);
    expect(message).toMatch(/Last reviewed abc123/);
    expect(message).toMatch(/do not repeat/);
    expect(message).toMatch(/whether each is now fixed/);
  });

  it("tells the agent to disclose a truncated scope", () => {
    const truncated = buildChangeSet({
      diff: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n x\n+y\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,3 @@\n x\n+y\n+z\n`,
      excludePatterns: [],
      maxFiles: 1,
    });
    const message = buildRunMessage(
      assembleRun({
        identity,
        comments: [],
        artifact: emptyArtifact(7),
        rules: [],
      }),
      truncated,
    );
    expect(message).toMatch(/file limit was reached/);
    expect(message).toMatch(/Say so in your summary/);
  });
});

describe("branch resolution", () => {
  it("resolves a single match", () => {
    expect(
      resolveBranch("feat/x", [
        { id: 7, sourceBranch: "feat/x", state: "open" },
      ]),
    ).toEqual({ resolved: true, pullRequestId: 7 });
  });

  it("prefers open pull requests over closed ones", () => {
    expect(
      resolveBranch("feat/x", [
        { id: 6, sourceBranch: "feat/x", state: "closed" },
        { id: 7, sourceBranch: "feat/x", state: "open" },
      ]),
    ).toEqual({ resolved: true, pullRequestId: 7 });
  });

  it("REFUSES to choose between several, naming them", () => {
    const result = resolveBranch("feat/x", [
      { id: 7, sourceBranch: "feat/x", title: "First", state: "open" },
      { id: 8, sourceBranch: "feat/x", title: "Second", state: "open" },
    ]);

    expect(result.resolved).toBe(false);
    expect(result.resolved === false && result.reason).toMatch(
      /#7 \(First\), #8 \(Second\)/,
    );
    expect(result.resolved === false && result.candidates).toHaveLength(2);
  });

  it("reports plainly when nothing matches", () => {
    const result = resolveBranch("feat/missing", []);
    expect(result.resolved).toBe(false);
    expect(result.resolved === false && result.reason).toMatch(
      /No open pull request/,
    );
  });

  it("narrows to an exact branch match when the provider returns extras", () => {
    expect(
      resolveBranch("feat/x", [
        { id: 7, sourceBranch: "feat/x", state: "open" },
        { id: 8, sourceBranch: "feat/x-other", state: "open" },
      ]),
    ).toEqual({ resolved: true, pullRequestId: 7 });
  });
});
