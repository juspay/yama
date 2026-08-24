import { existsSync, readFileSync } from "node:fs";
import {
  detectMergeStrategy,
  renderLearningDisabled,
  resolveMergedPullRequest,
  validateLearnTrigger,
  type CommitInfo,
} from "../../../src/v4/learn/MergeResolver.js";
import {
  GitWriteError,
  assertScopedPaths,
  commitAndPush,
  learnCommitMessage,
  prepareCredentials,
  type GitRunner,
} from "../../../src/v4/learn/GitWriter.js";
import {
  PROMOTION,
  applyHumanComments,
  applyYamaOutcomes,
  computePrecision,
  renderLearningSummary,
  retireDormantRules,
  type TriagedHumanComment,
} from "../../../src/v4/learn/Triage.js";
import type { RuleEntry } from "../../../src/v4/types/index.js";

const commit = (overrides: Partial<CommitInfo> = {}): CommitInfo => ({
  sha: "abcdef1234",
  subject: "feat: add impact analysis",
  parentCount: 1,
  ...overrides,
});

describe("merge strategy detection", () => {
  it("detects merge commits", () => {
    expect(
      detectMergeStrategy([
        commit({ parentCount: 2, subject: "Merge pull request #1 from x" }),
        commit(),
        commit(),
      ]),
    ).toBe("merge");
  });

  it("detects squash merges from the subject", () => {
    expect(
      detectMergeStrategy([
        commit({ subject: "feat: thing (#142)" }),
        commit({ subject: "fix: other (#143)" }),
        commit(),
      ]),
    ).toBe("squash");
  });

  it("falls back to rebase when nothing carries a marker", () => {
    expect(detectMergeStrategy([commit(), commit(), commit()])).toBe("rebase");
  });

  it("returns unknown with no history to sample", () => {
    expect(detectMergeStrategy([])).toBe("unknown");
  });
});

describe("resolving the merged pull request", () => {
  it("trusts the CI trigger above everything — it is exact", () => {
    const result = resolveMergedPullRequest(
      commit({ subject: "feat: x (#999)" }),
      {
        triggerPullRequestId: 142,
      },
    );
    expect(result).toEqual({
      resolved: true,
      pullRequestId: 142,
      via: "trigger",
    });
  });

  it("reads a merge-commit subject", () => {
    const result = resolveMergedPullRequest(
      commit({
        parentCount: 2,
        subject: "Merge pull request #142 from feat/x",
      }),
    );
    expect(result).toMatchObject({ pullRequestId: 142, via: "merge-subject" });
  });

  it("reads a squash subject in both spellings", () => {
    expect(
      resolveMergedPullRequest(commit({ subject: "feat: thing (#142)" })),
    ).toMatchObject({ pullRequestId: 142, via: "squash-subject" });
    expect(
      resolveMergedPullRequest(
        commit({ subject: "feat: thing (pull request #142)" }),
      ),
    ).toMatchObject({ pullRequestId: 142, via: "squash-subject" });
  });

  it("reads an explicit trailer", () => {
    expect(
      resolveMergedPullRequest(commit({ body: "Some body\n\nPR: #142\n" })),
    ).toMatchObject({ pullRequestId: 142, via: "trailer" });
  });

  it("accepts an API reverse lookup as a last resort", () => {
    expect(
      resolveMergedPullRequest(commit(), { apiLookup: 142 }),
    ).toMatchObject({
      pullRequestId: 142,
      via: "api",
    });
  });

  it("REFUSES rather than guessing on a rebase repository", () => {
    const result = resolveMergedPullRequest(commit(), { strategy: "rebase" });
    expect(result.resolved).toBe(false);
    expect(result.resolved === false && result.reason).toMatch(
      /cannot be recovered from git history/,
    );
    expect(result.resolved === false && result.remedy).toMatch(/merge event/);
  });

  it("renders a loud disabled message with all three remedies", () => {
    const result = resolveMergedPullRequest(commit(), { strategy: "rebase" });
    const message = renderLearningDisabled(
      result as { reason: string; remedy: string },
    );
    expect(message).toMatch(/Learning is DISABLED/);
    expect(message).toMatch(/\(a\)/);
    expect(message).toMatch(/\(b\)/);
    expect(message).toMatch(/\(c\)/);
    expect(message).toMatch(/Review is unaffected/);
  });
});

describe("learn trigger validation", () => {
  it("accepts merge-event for any strategy", () => {
    expect(validateLearnTrigger("merge-event", "rebase").ok).toBe(true);
  });

  it("REJECTS push on a rebase repository — feedback would be misattributed", () => {
    const result = validateLearnTrigger("push", "rebase");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/wrong pull request/);
  });

  it("accepts push where commits carry a number", () => {
    expect(validateLearnTrigger("push", "squash").ok).toBe(true);
  });

  it("accepts disabled", () => {
    expect(validateLearnTrigger("disabled", "rebase").ok).toBe(true);
  });
});

describe("git credentials never leak", () => {
  it("writes an ssh key to a 0600 file OUTSIDE the workspace", () => {
    const setup = prepareCredentials(
      { auth: "ssh", sshKeyEnv: "KEY" },
      { KEY: "-----BEGIN KEY-----\nabc\n-----END KEY-----" },
    );
    try {
      const command = String(setup.env.GIT_SSH_COMMAND);
      const path = /-i (\S+)/.exec(command)?.[1] as string;

      expect(existsSync(path)).toBe(true);
      expect(path.startsWith("/tmp") || path.includes("Temp")).toBe(true);
      expect(command).toMatch(/IdentitiesOnly=yes/);
      // The key VALUE is never in the command line, only its path.
      expect(command).not.toMatch(/BEGIN KEY/);
    } finally {
      setup.cleanup();
    }
  });

  it("removes the key file on cleanup", () => {
    const setup = prepareCredentials(
      { auth: "ssh", sshKeyEnv: "KEY" },
      { KEY: "k" },
    );
    const path = /-i (\S+)/.exec(
      String(setup.env.GIT_SSH_COMMAND),
    )?.[1] as string;
    setup.cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it("uses an askpass helper for https — never a token in the URL", () => {
    const setup = prepareCredentials(
      { auth: "https", userEnv: "U", tokenEnv: "T" },
      { U: "bot", T: "secret-token" },
    );
    try {
      const script = readFileSync(String(setup.env.GIT_ASKPASS), "utf-8");
      // The script references the variable; the secret itself is not in the file.
      expect(script).toMatch(/\$T/);
      expect(script).not.toMatch(/secret-token/);
      expect(setup.env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      setup.cleanup();
    }
  });

  it("fails loudly when the credential is unset", () => {
    expect(() =>
      prepareCredentials({ auth: "ssh", sshKeyEnv: "NOPE" }, {}),
    ).toThrow(/unset or empty/);
    expect(() =>
      prepareCredentials({ auth: "https", tokenEnv: "NOPE" }, {}),
    ).toThrow(/unset or empty/);
  });
});

describe("scoped staging", () => {
  it("allows .yama paths", () => {
    expect(() =>
      assertScopedPaths([
        ".yama/knowledge/a.md",
        ".yama/product/impact-log/b.yaml",
      ]),
    ).not.toThrow();
  });

  it("REFUSES anything outside .yama", () => {
    expect(() => assertScopedPaths([".yama/a.md", "src/index.ts"])).toThrow(
      GitWriteError,
    );
    expect(() => assertScopedPaths(["package.json"])).toThrow(/outside \.yama/);
  });
});

describe("commitAndPush", () => {
  const runnerFor =
    (
      responses: Record<
        string,
        { stdout?: string; stderr?: string; exitCode?: number }
      >,
      log: string[] = [],
    ): GitRunner =>
    async (command) => {
      log.push(command);
      const key = Object.keys(responses).find((prefix) =>
        command.includes(prefix),
      );
      const response = key ? responses[key] : {};
      return {
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
        exitCode: response.exitCode ?? 0,
      };
    };

  const base = {
    cwd: "/repo",
    config: {
      auth: "ssh" as const,
      sshKeyEnv: "KEY",
      remote: "git@host:o/r.git",
      branch: "main",
    },
    env: { KEY: "k" },
    botIdentity: "yama-bot",
    message: "chore(yama): learn from #1 [skip ci]",
    paths: [".yama/knowledge/a.md"],
  };

  it("commits and pushes without --force", async () => {
    const log: string[] = [];
    const result = await commitAndPush({
      ...base,
      runner: runnerFor(
        {
          "diff --cached": { stdout: ".yama/knowledge/a.md" },
          "rev-parse": { stdout: "sha1" },
        },
        log,
      ),
    });

    expect(result).toMatchObject({
      committed: true,
      pushed: true,
      sha: "sha1",
    });
    expect(log.some((command) => command.includes("--force"))).toBe(false);
    expect(log.some((command) => command.includes("push"))).toBe(true);
  });

  it("does nothing when there is nothing to commit", async () => {
    const result = await commitAndPush({
      ...base,
      runner: runnerFor({ "diff --cached": { stdout: "" } }),
    });
    expect(result.committed).toBe(false);
    expect(result.reason).toBe("nothing to commit");
  });

  it("REFUSES when something outside .yama got staged", async () => {
    await expect(
      commitAndPush({
        ...base,
        runner: runnerFor({
          "diff --cached": { stdout: ".yama/a.md\nsrc/secret.ts" },
        }),
      }),
    ).rejects.toThrow(/outside \.yama/);
  });

  it("rebases and retries a rejected push instead of forcing", async () => {
    const log: string[] = [];
    let pushes = 0;
    const runner: GitRunner = async (command) => {
      log.push(command);
      if (command.includes("diff --cached")) {
        return { stdout: ".yama/knowledge/a.md", stderr: "", exitCode: 0 };
      }
      if (command.includes("rev-parse")) {
        return { stdout: "sha1", stderr: "", exitCode: 0 };
      }
      if (command.includes("push")) {
        pushes += 1;
        return pushes === 1
          ? { stdout: "", stderr: "rejected: non-fast-forward", exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await commitAndPush({ ...base, runner });

    expect(result.pushed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(log.some((command) => command.includes("rebase FETCH_HEAD"))).toBe(
      true,
    );
    expect(log.some((command) => command.includes("--force"))).toBe(false);
  });

  it("fails loudly rather than forcing after repeated rejection", async () => {
    const runner: GitRunner = async (command) => {
      if (command.includes("diff --cached")) {
        return { stdout: ".yama/a.md", stderr: "", exitCode: 0 };
      }
      if (command.includes("push")) {
        return { stdout: "", stderr: "rejected", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await expect(
      commitAndPush({
        ...base,
        runner,
        paths: [".yama/a.md"],
        maxPushAttempts: 2,
      }),
    ).rejects.toThrow(/never force-pushes/);
  });

  it("requires a remote", async () => {
    await expect(
      commitAndPush({
        ...base,
        config: { auth: "ssh", sshKeyEnv: "KEY" },
        runner: runnerFor({}),
      }),
    ).rejects.toThrow(/remote is not configured/);
  });

  it("marks the commit with [skip ci]", () => {
    expect(learnCommitMessage(142)).toBe(
      "chore(yama): learn from #142 [skip ci]",
    );
  });
});

describe("learning from human comments", () => {
  const comment = (
    overrides: Partial<TriagedHumanComment> = {},
  ): TriagedHumanComment => ({
    classification: "missed-convention",
    conventionKey: "wrap errors with context",
    title: "Wrap errors with context before rethrowing",
    summary: "A bare rethrow loses the call site",
    ...overrides,
  });

  it("records a first sighting as a candidate", () => {
    const update = applyHumanComments([], [comment({ author: "@alice" })], 1);
    expect(update.rules[0]).toMatchObject({
      id: "conv.wrap-errors-with-context",
      status: "candidate",
      occurrences: 1,
      weight: 1,
    });
    expect(update.changes[0]).toMatch(/candidate convention/);
  });

  it("PROMOTES a convention at two occurrences, regardless of author", () => {
    const first = applyHumanComments([], [comment({ author: "@alice" })], 1);
    const second = applyHumanComments(
      first.rules,
      [comment({ author: "@alice" })],
      2,
    );

    expect(second.rules[0].status).toBe("active");
    expect(second.rules[0].occurrences).toBe(2);
    expect(second.changes[0]).toMatch(/Promoted/);
  });

  it("makes a preference wait longer than a convention", () => {
    let rules: RuleEntry[] = [];
    for (let round = 0; round < 3; round += 1) {
      rules = applyHumanComments(
        rules,
        [
          comment({
            classification: "preference",
            conventionKey: "prefer arrow fns",
          }),
        ],
        round,
      ).rules;
    }
    expect(rules[0].status).toBe("candidate");
    expect(PROMOTION.preferenceOccurrences).toBeGreaterThan(
      PROMOTION.conventionOccurrences,
    );
  });

  it("never records a context-specific comment as a rule", () => {
    const update = applyHumanComments(
      [],
      [comment({ classification: "context-specific" })],
      1,
    );
    expect(update.rules).toEqual([]);
  });

  it("accumulates evidence without duplicating it", () => {
    const first = applyHumanComments([], [comment({ evidence: "c1" })], 1);
    const second = applyHumanComments(
      first.rules,
      [comment({ evidence: "c1" })],
      2,
    );
    expect(second.rules[0].evidence).toEqual(["c1"]);
  });

  it("weights by occurrence so frequency drives prominence", () => {
    let rules = applyHumanComments([], [comment()], 1).rules;
    rules = applyHumanComments(rules, [comment()], 2).rules;
    rules = applyHumanComments(rules, [comment()], 3).rules;
    expect(rules[0].weight).toBe(3);
  });
});

describe("learning from Yama's own outcomes", () => {
  it("SUPPRESSES ONLY after repeated dismissal — slower than promotion", () => {
    let rules: RuleEntry[] = [];
    for (let round = 1; round <= PROMOTION.suppressionOccurrences; round += 1) {
      rules = applyYamaOutcomes(
        rules,
        [
          {
            findingId: "f1",
            outcome: "dismissed-no-change",
            title: "Naming nit",
          },
        ],
        round,
      ).rules;
      if (round < PROMOTION.suppressionOccurrences) {
        expect(rules[0].status).toBe("candidate");
      }
    }
    expect(rules[0].status).toBe("suppressed");
    expect(PROMOTION.suppressionOccurrences).toBeGreaterThan(
      PROMOTION.conventionOccurrences,
    );
  });

  it("ignores findings that were acted on", () => {
    const update = applyYamaOutcomes(
      [],
      [{ findingId: "f1", outcome: "acted-on", title: "Real bug" }],
      1,
    );
    expect(update.rules).toEqual([]);
  });
});

describe("dormancy", () => {
  it("retires a long-unseen candidate without deleting its evidence", () => {
    const update = retireDormantRules(
      [
        {
          id: "conv.x",
          title: "X",
          summary: "s",
          status: "candidate",
          occurrences: 1,
          evidence: ["PR#1"],
        },
      ],
      new Map([["conv.x", PROMOTION.dormantAfterMerges]]),
    );
    expect(update.rules[0].status).toBe("dormant");
    expect(update.rules[0].evidence).toEqual(["PR#1"]);
    expect(update.changes[0]).toMatch(/Retired/);
  });

  it("never retires an established rule", () => {
    const update = retireDormantRules(
      [
        {
          id: "conv.x",
          title: "X",
          summary: "s",
          status: "active",
          occurrences: 9,
        },
      ],
      new Map([["conv.x", 500]]),
    );
    expect(update.rules[0].status).toBe("active");
  });
});

describe("precision", () => {
  it("measures acted-on against judged comments, not all of them", () => {
    const precision = computePrecision([
      { findingId: "a", outcome: "acted-on", title: "" },
      { findingId: "b", outcome: "acted-on", title: "" },
      { findingId: "c", outcome: "dismissed-no-change", title: "" },
      { findingId: "d", outcome: "unresolved", title: "" },
    ]);
    expect(precision.posted).toBe(4);
    // Unresolved is excluded: nobody has judged it yet.
    expect(precision.precision).toBeCloseTo(2 / 3);
  });

  it("is zero, not NaN, when nothing has been judged", () => {
    expect(computePrecision([]).precision).toBe(0);
  });

  it("renders a readable commit body", () => {
    const summary = renderLearningSummary(
      142,
      ['Promoted "Wrap errors" to active.'],
      computePrecision([
        { findingId: "a", outcome: "acted-on", title: "" },
        { findingId: "b", outcome: "dismissed-no-change", title: "" },
      ]),
    );
    expect(summary).toMatch(/Learned from pull request #142/);
    expect(summary).toMatch(/Promoted "Wrap errors"/);
    expect(summary).toMatch(/precision 50%/);
  });

  it("says plainly when nothing was learned", () => {
    expect(renderLearningSummary(1, [], computePrecision([]))).toMatch(
      /No changes to the knowledge base/,
    );
  });
});

describe("learn commit skip-ci marker", () => {
  it("carries [skip ci] by default", () => {
    expect(learnCommitMessage(42)).toBe(
      "chore(yama): learn from #42 [skip ci]",
    );
    expect(learnCommitMessage(42, true)).toBe(
      "chore(yama): learn from #42 [skip ci]",
    );
  });

  it("omits [skip ci] when a repository bans skip directives", () => {
    // For repos whose CI fails any commit containing a skip-ci directive: the
    // marker is dropped and loop-prevention rests on the actor guard,
    // paths-ignore, and the built-in token not triggering workflows.
    expect(learnCommitMessage(42, false)).toBe("chore(yama): learn from #42");
  });
});
