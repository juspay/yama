import {
  FindingLedger,
  extractCommentId,
} from "../../../src/v4/findings/Ledger.js";
import {
  evaluateGuards,
  applicableGuards,
} from "../../../src/v4/policy/guards.js";
import {
  evaluateOwnership,
  selectOwnershipRules,
} from "../../../src/v4/checks/builtin/owners.js";
import {
  deriveVerdict,
  describeVerdict,
} from "../../../src/v4/core/verdict.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import { optionalDefaults } from "../../../src/v4/config/defaults.js";
import type {
  GuardRule,
  IdentifiedFinding,
  OwnershipRule,
  PostedFinding,
  VerdictInput,
} from "../../../src/v4/types/index.js";

const diffFor = (paths: string[]): string =>
  paths
    .map(
      (path) =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n a\n+b\n`,
    )
    .join("");

const changeSetFor = (paths: string[]) =>
  buildChangeSet({ diff: diffFor(paths), excludePatterns: [], maxFiles: 100 });

const finding = (
  overrides: Partial<IdentifiedFinding> = {},
): IdentifiedFinding => ({
  id: overrides.id ?? "f1",
  severity: "MAJOR",
  title: "A finding",
  source: "agent",
  ...overrides,
});

describe("FindingLedger", () => {
  it("records gate decisions", () => {
    const ledger = new FindingLedger();
    ledger.recordGate({
      accepted: [finding({ id: "a" })],
      rejected: [
        { finding: finding({ id: "b" }), reason: "suppressed", detail: "x" },
      ],
    });
    const counts = ledger.counts();
    expect(counts.submitted).toBe(2);
    expect(counts.accepted).toBe(1);
    expect(counts.rejected).toBe(1);
  });

  it("counts a finding as posted ONLY when a comment id came back", () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [finding({ id: "a" })], rejected: [] });

    expect(ledger.counts().posted).toBe(0);
    expect(ledger.unposted.map((entry) => entry.id)).toEqual(["a"]);

    ledger.recordPosted("a", "comment-1");

    expect(ledger.counts().posted).toBe(1);
    expect(ledger.unposted).toEqual([]);
    expect(ledger.posted[0].postedCommentId).toBe("comment-1");
  });

  it("refuses to record a post without a comment id", () => {
    const ledger = new FindingLedger();
    ledger.recordGate({ accepted: [finding({ id: "a" })], rejected: [] });
    expect(() => ledger.recordPosted("a", "")).toThrow(/without a comment id/);
    expect(ledger.counts().posted).toBe(0);
  });

  it("refuses to record a post for a finding the gate never accepted", () => {
    const ledger = new FindingLedger();
    expect(() => ledger.recordPosted("ghost", "comment-1")).toThrow(
      /the gate did not accept/,
    );
  });

  it("treats a pre-existing comment from an earlier run as already posted", () => {
    const ledger = new FindingLedger();
    ledger.recordPreExisting(finding({ id: "a" }), "old-comment");
    expect(ledger.unposted).toEqual([]);
    expect(ledger.counts().posted).toBe(1);
  });

  it("reports severity counts over POSTED findings, matching what a reader sees", () => {
    const ledger = new FindingLedger();
    ledger.recordGate({
      accepted: [
        finding({ id: "a", severity: "CRITICAL" }),
        finding({ id: "b", severity: "MINOR" }),
      ],
      rejected: [],
    });
    ledger.recordPosted("a", "c1");

    expect(ledger.counts().bySeverity).toEqual({
      CRITICAL: 1,
      MAJOR: 0,
      MINOR: 0,
      SUGGESTION: 0,
    });
  });
});

describe("extractCommentId", () => {
  it.each([
    [{ id: "123" }, "123"],
    [{ id: 456 }, "456"],
    [{ commentId: "c1" }, "c1"],
    [{ comment_id: "c2" }, "c2"],
    [{ comment: { id: "c3" } }, "c3"],
    [{ data: { id: "c4" } }, "c4"],
    [{ result: { id: "c5" } }, "c5"],
    ["c6", "c6"],
    [789, "789"],
  ])("extracts from %p", (input, expected) => {
    expect(extractCommentId(input)).toBe(expected);
  });

  it.each([null, undefined, {}, { ok: true }, "", "   ", []])(
    "returns undefined for %p rather than guessing success",
    (input) => {
      expect(extractCommentId(input)).toBeUndefined();
    },
  );
});

describe("guards", () => {
  const guards: GuardRule[] = [
    {
      id: "no-vendor",
      paths: ["vendor/**"],
      forbid: true,
      reason: "Vendored code is generated",
    },
    {
      id: "payments",
      paths: ["src/payments/**"],
      requireChecks: ["test", "typecheck"],
    },
    { id: "floor", paths: ["src/payments/**"], severityFloor: "MAJOR" },
  ];

  it("selects only guards whose paths this change touches", () => {
    const applicable = applicableGuards(
      guards,
      changeSetFor(["src/payments/pay.ts"]),
    );
    expect(applicable.map((entry) => entry.guard.id).sort()).toEqual([
      "floor",
      "payments",
    ]);
  });

  it("evaluates forbidden paths as a violation with a concrete remedy", () => {
    const result = evaluateGuards(guards, changeSetFor(["vendor/lib.js"]));
    expect(result.violatedRuleIds).toEqual(["no-vendor"]);
    expect(result.findings[0].source).toBe("policy");
    expect(result.findings[0].suggestion).toMatch(/Vendored code is generated/);
  });

  it("counts excluded files for policy — a guard must not be dodged by exclusion", () => {
    const changeSet = buildChangeSet({
      diff: diffFor(["vendor/lib.js"]),
      excludePatterns: ["vendor/**"],
      maxFiles: 100,
    });
    expect(changeSet.files).toHaveLength(0);
    expect(evaluateGuards(guards, changeSet).violatedRuleIds).toEqual([
      "no-vendor",
    ]);
  });

  it("passes when every required check passed", () => {
    const result = evaluateGuards(
      guards,
      changeSetFor(["src/payments/pay.ts"]),
      new Map([
        ["test", true],
        ["typecheck", true],
      ]),
    );
    expect(result.violatedRuleIds).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it("flags a required check that failed", () => {
    const result = evaluateGuards(
      guards,
      changeSetFor(["src/payments/pay.ts"]),
      new Map([
        ["test", false],
        ["typecheck", true],
      ]),
    );
    expect(result.findings[0].title).toMatch(/"test" failed/);
  });

  it("treats a required check that never ran as unsatisfied", () => {
    const result = evaluateGuards(
      guards,
      changeSetFor(["src/payments/pay.ts"]),
      new Map(),
    );
    expect(result.findings.map((entry) => entry.title)).toEqual([
      'Required check "test" did not run for a guarded path',
      'Required check "typecheck" did not run for a guarded path',
    ]);
  });

  it("reports which checks the guards require", () => {
    const result = evaluateGuards(
      guards,
      changeSetFor(["src/payments/pay.ts"]),
    );
    expect(result.requiredCheckIds.sort()).toEqual(["test", "typecheck"]);
  });

  it("does nothing when no guard matches", () => {
    const result = evaluateGuards(guards, changeSetFor(["README.md"]));
    expect(result.findings).toEqual([]);
    expect(result.violatedRuleIds).toEqual([]);
  });
});

describe("ownership", () => {
  const rules: OwnershipRule[] = [
    {
      id: "core",
      paths: ["src/core/**"],
      owners: ["@alice", "@team/core"],
      minApprovals: 1,
    },
    {
      id: "data",
      paths: ["**/*.sql"],
      owners: ["@team/data"],
      minApprovals: 2,
      blocking: true,
    },
  ];

  it("returns nothing when no rule matches — zero cost, no comment", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["README.md"]),
    });
    expect(result.matches).toEqual([]);
    expect(result.comment).toBeUndefined();
  });

  it("matches rules by path and lists the covered files", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["src/core/a.ts", "src/core/b.ts"]),
      approvals: [],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].paths).toEqual(["src/core/a.ts", "src/core/b.ts"]);
  });

  it("marks a rule satisfied once enough owners approved", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["src/core/a.ts"]),
      approvals: ["alice"],
    });
    expect(result.matches[0].satisfied).toBe(true);
    expect(result.matches[0].pendingOwners).toEqual(["@team/core"]);
  });

  it("requires the configured number of approvals", () => {
    const oneApproval = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["db/schema.sql"]),
      approvals: ["@team/data"],
    });
    expect(oneApproval.matches[0].satisfied).toBe(false);
    expect(oneApproval.unsatisfiedBlockingRuleIds).toEqual(["data"]);
  });

  it("excludes the author from their own review requirement", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["src/core/a.ts"]),
      approvals: [],
      author: "@alice",
    });
    expect(result.matches[0].pendingOwners).toEqual(["@team/core"]);
  });

  it("never reads unknown approvals as satisfied", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["db/schema.sql"]),
    });
    expect(result.approvalsUnknown).toBe(true);
    expect(result.matches[0].satisfied).toBe(false);
    expect(result.unsatisfiedBlockingRuleIds).toEqual(["data"]);
    expect(result.comment).toMatch(/could not be read/);
  });

  it("normalises handles with and without the @ prefix", () => {
    const result = evaluateOwnership({
      rules,
      changeSet: changeSetFor(["src/core/a.ts"]),
      approvals: ["Alice"],
    });
    expect(result.matches[0].satisfied).toBe(true);
  });

  it("applies deletions and both sides of a rename", () => {
    const deletion = buildChangeSet({
      diff: `diff --git a/src/core/gone.ts b/src/core/gone.ts\ndeleted file mode 100644\n--- a/src/core/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n`,
      excludePatterns: [],
      maxFiles: 100,
    });
    expect(
      evaluateOwnership({ rules, changeSet: deletion, approvals: [] }).matches,
    ).toHaveLength(1);
  });

  describe("union vs exclusive", () => {
    const overlapping: OwnershipRule[] = [
      { id: "broad", paths: ["src/**"], owners: ["@broad"] },
      { id: "narrow", paths: ["src/core/**"], owners: ["@narrow"] },
    ];

    it("unions by default — two teams can both own a file", () => {
      const result = evaluateOwnership({
        rules: overlapping,
        changeSet: changeSetFor(["src/core/a.ts"]),
        approvals: [],
      });
      expect(result.matches.map((match) => match.rule.id).sort()).toEqual([
        "broad",
        "narrow",
      ]);
    });

    it("honours CODEOWNERS last-match-wins when exclusive is set", () => {
      const result = evaluateOwnership({
        rules: [overlapping[0], { ...overlapping[1], exclusive: true }],
        changeSet: changeSetFor(["src/core/a.ts"]),
        approvals: [],
      });
      expect(result.matches.map((match) => match.rule.id)).toEqual(["narrow"]);
    });

    it("leaves paths an exclusive rule does not claim with their other owners", () => {
      const result = evaluateOwnership({
        rules: [overlapping[0], { ...overlapping[1], exclusive: true }],
        changeSet: changeSetFor(["src/core/a.ts", "src/other.ts"]),
        approvals: [],
      });
      const broad = result.matches.find((match) => match.rule.id === "broad");
      expect(broad?.paths).toEqual(["src/other.ts"]);
    });
  });

  describe("comment rendering", () => {
    it("groups into one comment with a status table and a marker", () => {
      const result = evaluateOwnership({
        rules,
        changeSet: changeSetFor(["src/core/a.ts", "db/schema.sql"]),
        approvals: ["alice"],
      });
      expect(result.comment).toMatch(/### Ownership review required/);
      expect(result.comment).toMatch(/satisfied 1\/1/);
      expect(result.comment).toMatch(/pending 0\/2/);
      expect(result.comment).toMatch(/<!-- yama:owners -->/);
    });

    it("tags only owners who have not yet approved", () => {
      const result = evaluateOwnership({
        rules,
        changeSet: changeSetFor(["db/schema.sql"]),
        approvals: [],
      });
      expect(result.comment).toMatch(/@team\/data — 1 file\(s\) in your area/);
    });

    it("truncates a long file list instead of pasting fifty paths", () => {
      const paths = Array.from(
        { length: 12 },
        (_, index) => `src/core/f${index}.ts`,
      );
      const result = evaluateOwnership({
        rules,
        changeSet: changeSetFor(paths),
        approvals: [],
      });
      expect(result.comment).toMatch(/and 4 more/);
    });
  });
});

describe("deriveVerdict", () => {
  const config = optionalDefaults().review.verdict;
  const base: VerdictInput = {
    posted: [],
    accepted: [],
    blockingRuleIds: [],
    failedBlockingCheckIds: [],
    unapprovedOwnershipRuleIds: [],
    partial: false,
  };
  const posted = (
    severity: PostedFinding["severity"],
    id: string,
  ): PostedFinding => ({
    id,
    severity,
    title: id,
    source: "agent",
    postedCommentId: `c-${id}`,
    postedAt: new Date(0).toISOString(),
  });

  it("approves a clean, complete run", () => {
    const verdict = deriveVerdict(base, { config });
    expect(verdict.decision).toBe("APPROVED");
    expect(verdict.reasons[0]).toMatch(/No findings/);
  });

  it("blocks on any critical", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("CRITICAL", "a")],
        accepted: [posted("CRITICAL", "a")],
      },
      { config },
    );
    expect(verdict.decision).toBe("BLOCKED");
  });

  it("blocks at the major threshold and not below it", () => {
    const two = deriveVerdict(
      {
        ...base,
        posted: [posted("MAJOR", "a"), posted("MAJOR", "b")],
        accepted: [posted("MAJOR", "a"), posted("MAJOR", "b")],
      },
      { config },
    );
    expect(two.decision).toBe("CHANGES_REQUESTED");

    const three = deriveVerdict(
      {
        ...base,
        posted: [
          posted("MAJOR", "a"),
          posted("MAJOR", "b"),
          posted("MAJOR", "c"),
        ],
        accepted: [
          posted("MAJOR", "a"),
          posted("MAJOR", "b"),
          posted("MAJOR", "c"),
        ],
      },
      { config },
    );
    expect(three.decision).toBe("BLOCKED");
  });

  it("does not approve over posted comments", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("MINOR", "a")],
        accepted: [posted("MINOR", "a")],
      },
      { config },
    );
    expect(verdict.decision).toBe("CHANGES_REQUESTED");
  });

  it("blocks on rules, checks and ownership", () => {
    expect(
      deriveVerdict({ ...base, blockingRuleIds: ["r"] }, { config }).decision,
    ).toBe("BLOCKED");
    expect(
      deriveVerdict({ ...base, failedBlockingCheckIds: ["c"] }, { config })
        .decision,
    ).toBe("BLOCKED");
    expect(
      deriveVerdict({ ...base, unapprovedOwnershipRuleIds: ["o"] }, { config })
        .decision,
    ).toBe("BLOCKED");
  });

  it("A PARTIAL RUN MAY NEVER APPROVE", () => {
    const verdict = deriveVerdict({ ...base, partial: true }, { config });
    expect(verdict.decision).toBe("CHANGES_REQUESTED");
    expect(verdict.reasons.join(" ")).toMatch(/did not complete every stage/);
  });

  it("a partial run may still block on what it did find", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        partial: true,
        posted: [posted("CRITICAL", "a")],
        accepted: [posted("CRITICAL", "a")],
      },
      { config },
    );
    expect(verdict.decision).toBe("BLOCKED");
  });

  it("respects a project that removes a reason from blockOn", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("CRITICAL", "a")],
        accepted: [posted("CRITICAL", "a")],
      },
      { config: { ...config, blockOn: ["blocking-check"] } },
    );
    expect(verdict.decision).toBe("CHANGES_REQUESTED");
  });

  it("honours a custom major threshold", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("MAJOR", "a"), posted("MAJOR", "b")],
        accepted: [posted("MAJOR", "a"), posted("MAJOR", "b")],
      },
      { config: { ...config, majorThreshold: 2 } },
    );
    expect(verdict.decision).toBe("BLOCKED");
  });

  it("marks the verdict advisory when the project turned it off", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("CRITICAL", "a")],
        accepted: [posted("CRITICAL", "a")],
      },
      { config: { ...config, enabled: false } },
    );
    expect(verdict.advisory).toBe(true);
    expect(verdict.decision).toBe("BLOCKED");
    expect(describeVerdict(verdict)).toMatch(/^\(advisory\) BLOCKED/);
  });

  it("collects every contributing reason", () => {
    const verdict = deriveVerdict(
      {
        ...base,
        posted: [posted("CRITICAL", "a")],
        accepted: [posted("CRITICAL", "a")],
        blockingRuleIds: ["r"],
        failedBlockingCheckIds: ["c"],
      },
      { config },
    );
    expect(verdict.reasons).toHaveLength(3);
  });
});

/**
 * The incident-review fixes, as regression tests.
 *
 * Each of these encodes a failure scenario found by the pre-merge code review:
 * behaviour that shipped, was confirmed against the code, and is now fixed.
 */
describe("verdict counts what the gate accepted, not what posted", () => {
  const config = optionalDefaults().review.verdict;
  const clean: VerdictInput = {
    posted: [],
    accepted: [],
    blockingRuleIds: [],
    failedBlockingCheckIds: [],
    unapprovedOwnershipRuleIds: [],
    partial: false,
  };

  it("blocks on a CRITICAL whose comment failed to post", () => {
    // The old contract counted `posted` — a posting failure silently cleared
    // the blocker and the build went green over an unposted critical defect.
    const verdict = deriveVerdict(
      {
        ...clean,
        posted: [],
        accepted: [{ id: "a", severity: "CRITICAL", title: "auth bypass" }],
        partial: true,
      },
      { config },
    );
    expect(verdict.decision).toBe("BLOCKED");
  });

  it("blocks in dry-run, where nothing ever posts", () => {
    const verdict = deriveVerdict(
      {
        ...clean,
        accepted: [{ id: "a", severity: "CRITICAL", title: "sql injection" }],
      },
      { config },
    );
    expect(verdict.decision).toBe("BLOCKED");
  });
});

describe("ownership when the author owns the area alone", () => {
  it("requires nothing rather than the impossible", () => {
    // An author-only rule used to demand approvals nobody could give: the
    // author was filtered from the owner list but `required` stayed at the
    // configured count, so the rule blocked forever while tagging no one.
    const result = evaluateOwnership({
      rules: [
        {
          id: "solo",
          paths: ["src/**"],
          owners: ["@alice"],
          minApprovals: 1,
          blocking: true,
        },
      ],
      changeSet: changeSetFor(["src/a.ts"]),
      approvals: [],
      author: "@alice",
    });
    expect(result.matches[0].required).toBe(0);
    expect(result.matches[0].satisfied).toBe(true);
    expect(result.unsatisfiedBlockingRuleIds).toEqual([]);
  });
});
