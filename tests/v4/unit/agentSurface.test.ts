import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYSTEM_INSTRUCTION,
  buildTaskMessage,
} from "../../../src/v4/agents/systemInstruction.js";
import {
  defaultPathScope,
  entriesFromRules,
  entryFromPrContext,
  recall,
  scoreEntry,
  tokenize,
  type RecallEntry,
} from "../../../src/v4/tools/recall.js";
import {
  isMutatingGitTool,
  parseGitCommand,
} from "../../../src/v4/tools/gitSafe.js";
import { resolveInSandbox } from "../../../src/v4/tools/sandbox.js";
import { buildChangeSet } from "../../../src/v4/changes/ChangeSet.js";
import type { RuleEntry } from "../../../src/v4/types/index.js";

describe("system instruction", () => {
  it("contains NO template expression — it is a constant, not a builder", () => {
    expect(SYSTEM_INSTRUCTION).not.toMatch(/\$\{/);
    expect(SYSTEM_INSTRUCTION).not.toMatch(/\{\{/);
  });

  it("stays small enough to be cheap on every turn", () => {
    expect(SYSTEM_INSTRUCTION.length).toBeLessThan(5_000);
  });

  it("states the gate rule and the fix requirement", () => {
    expect(SYSTEM_INSTRUCTION).toMatch(/submit_finding/);
    expect(SYSTEM_INSTRUCTION).toMatch(/refused without a concrete fix/);
  });

  it("carries the false-positive taxonomy", () => {
    expect(SYSTEM_INSTRUCTION).toMatch(
      /linter, type checker, or compiler already catches/,
    );
    expect(SYSTEM_INSTRUCTION).toMatch(/Pre-existing issues/);
  });

  it("is byte-identical across imports, so prompt caching applies", () => {
    expect(SYSTEM_INSTRUCTION).toBe(SYSTEM_INSTRUCTION);
  });
});

describe("task message", () => {
  it("is three lines of identity, not assembled context", () => {
    const message = buildTaskMessage({
      owner: "juspay",
      repo: "yama",
      pullRequestId: 142,
      headSha: "abc",
    });
    expect(message.split("\n").filter(Boolean)).toHaveLength(4);
    expect(message).toMatch(/Pull request: #142/);
  });

  it("asks the agent to resolve a branch when no number is known", () => {
    expect(
      buildTaskMessage({ owner: "o", repo: "r", branch: "feat/x" }),
    ).toMatch(/Branch: feat\/x — find its pull request/);
  });
});

describe("recall ranking", () => {
  const entries: RecallEntry[] = [
    {
      id: "conv.error-wrapping",
      title: "Wrap errors with context before rethrowing",
      summary: "Bare rethrow loses the call site",
      kind: "convention",
      aliases: ["error handling"],
      weight: 9,
    },
    {
      id: "sec.no-eval",
      title: "Never eval external input",
      summary: "eval on request data is remote code execution",
      kind: "rule",
      paths: ["src/**"],
      severity: "CRITICAL",
      blocking: true,
      weight: 2,
    },
    {
      id: "style.naming",
      title: "Use camelCase for locals",
      summary: "Consistent naming across the codebase",
      kind: "convention",
      paths: ["src/**"],
      weight: 1,
    },
  ];

  it("tokenizes, dropping stop words and single characters", () => {
    expect(tokenize("The eval of a request")).toEqual(["eval", "request"]);
  });

  it("ranks a title match above a body-only match", () => {
    const titled = scoreEntry(entries[1], tokenize("eval"));
    const bodied = scoreEntry(
      { ...entries[2], body: "never use eval anywhere" },
      tokenize("eval"),
    );
    expect(titled).toBeGreaterThan(bodied);
  });

  it("lets an exact id win — that is a citation lookup", () => {
    const result = recall(entries, { query: "sec.no-eval" });
    expect(result.entries[0].id).toBe("sec.no-eval");
  });

  it("uses weight to rank but never to gate", () => {
    const result = recall(entries, { query: "naming camelCase" });
    expect(result.entries.map((entry) => entry.id)).toContain("style.naming");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(recall(entries, { query: "kubernetes helm chart" }).entries).toEqual(
      [],
    );
  });

  it("tells the agent NOT to invent a convention when nothing matched", () => {
    expect(recall(entries, { query: "nothing here" }).text).toMatch(
      /do not invent a convention/,
    );
  });

  it("orders by blocking then weight when there is no query", () => {
    const result = recall(entries, { paths: ["src/app.ts"] });
    expect(result.entries[0].id).toBe("sec.no-eval");
  });

  it("scopes by path, keeping repo-wide entries", () => {
    const result = recall(entries, { paths: ["docs/readme.md"] });
    const ids = result.entries.map((entry) => entry.id);
    expect(ids).toContain("conv.error-wrapping");
    expect(ids).not.toContain("sec.no-eval");
  });

  it("scopes by kind", () => {
    const result = recall(entries, { scope: "rule", paths: ["src/app.ts"] });
    expect(result.entries.map((entry) => entry.id)).toEqual(["sec.no-eval"]);
  });

  it("respects the limit and reports what it omitted", () => {
    // Three entries apply to src/app.ts: two path-scoped plus one repo-wide.
    const result = recall(entries, { paths: ["src/app.ts"], limit: 1 });
    expect(result.entries).toHaveLength(1);
    expect(result.omitted).toBe(2);
    expect(result.text).toMatch(/2 further entries matched/);
  });

  it("renders citation ids and flags blocking rules", () => {
    const result = recall(entries, { query: "eval" });
    expect(result.text).toMatch(/\[sec\.no-eval\]/);
    expect(result.text).toMatch(/BLOCKING/);
  });

  it("stays bounded — recall must not become the giant prompt again", () => {
    const huge: RecallEntry[] = Array.from({ length: 50 }, (_, index) => ({
      id: `r${index}`,
      title: `Rule ${index} about eval`,
      summary: "x".repeat(2_000),
      kind: "rule",
    }));
    const result = recall(huge, { query: "eval", limit: 50 });
    expect(result.text.length).toBeLessThan(15_000);
  });
});

describe("recall sources", () => {
  it("builds entries from rules, carrying severity and blocking", () => {
    const rules: RuleEntry[] = [
      {
        id: "r1",
        title: "T",
        summary: "S",
        severity: "MAJOR",
        blocking: true,
        example: "const x = 1;",
        occurrences: 4,
      },
    ];
    const [entry] = entriesFromRules(rules);
    expect(entry).toMatchObject({
      id: "r1",
      kind: "rule",
      severity: "MAJOR",
      blocking: true,
      weight: 4,
    });
    expect(entry.body).toMatch(/Example:/);
  });

  it("marks a suppressed rule as a suppression, not a rule", () => {
    const [entry] = entriesFromRules([
      { id: "s1", title: "T", summary: "S", status: "suppressed" },
    ]);
    expect(entry.kind).toBe("suppression");
  });

  it("drops dormant rules entirely", () => {
    expect(
      entriesFromRules([
        { id: "d", title: "T", summary: "S", status: "dormant" },
      ]),
    ).toEqual([]);
  });

  it("wraps PR context as a recallable entry", () => {
    const entry = entryFromPrContext(7, "Run 2. Found the gate bug.");
    expect(entry?.kind).toBe("pr-context");
    expect(entry?.id).toBe("pr-7");
  });

  it("returns nothing for empty PR context", () => {
    expect(entryFromPrContext(7, "   ")).toBeUndefined();
  });

  it("derives a default path scope from the change set", () => {
    const changeSet = buildChangeSet({
      diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n`,
      excludePatterns: [],
      maxFiles: 10,
    });
    expect(defaultPathScope(changeSet)).toEqual(["src/a.ts"]);
  });
});

describe("git safety — fail closed", () => {
  it.each([
    "git log --oneline -5",
    "git show abc123",
    "git blame src/app.ts",
    "git diff HEAD~1",
    "git rev-parse HEAD",
    "git merge-base main HEAD",
  ])("allows the read-only command: %s", (command) => {
    expect(parseGitCommand(command).allowed).toBe(true);
  });

  it.each([
    "git commit -m x",
    "git push origin main",
    "git reset --hard",
    "git checkout main",
    "git clean -fd",
    "git remote add evil https://evil.invalid",
  ])("refuses the mutating command: %s", (command) => {
    const check = parseGitCommand(command);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.reason).toMatch(
      /read-only allow-list/,
    );
  });

  it("refuses a subcommand it has never heard of — unknown means unsafe", () => {
    expect(parseGitCommand("git some-future-subcommand").allowed).toBe(false);
  });

  it.each([
    "git log; rm -rf /",
    "git log && curl evil.invalid",
    "git log | sh",
    "git log `whoami`",
    "git log $(id)",
    "git log > /tmp/out",
  ])("refuses shell metacharacters: %s", (command) => {
    const check = parseGitCommand(command);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.reason).toMatch(/metacharacter/);
  });

  it("refuses -c, which can point core.pager at any command", () => {
    const check = parseGitCommand("git -c core.pager=sh log");
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.reason).toMatch(/global flag/);
  });

  it("refuses flags that write files", () => {
    expect(parseGitCommand("git diff --output=/tmp/x").allowed).toBe(false);
    expect(parseGitCommand("git log --ext-diff").allowed).toBe(false);
  });

  it("refuses anything that is not git", () => {
    const check = parseGitCommand("curl https://evil.invalid");
    expect(check.allowed === false && check.reason).toMatch(
      /only git is available/,
    );
  });

  it("refuses an empty command", () => {
    expect(parseGitCommand("   ").allowed).toBe(false);
  });

  it("classifies mutating git tool names fail-closed", () => {
    expect(isMutatingGitTool("git_status")).toBe(false);
    expect(isMutatingGitTool("git_log")).toBe(false);
    expect(isMutatingGitTool("git_commit")).toBe(true);
    expect(isMutatingGitTool("git_push")).toBe(true);
    expect(isMutatingGitTool("git_some_new_thing")).toBe(true);
    expect(isMutatingGitTool("server:git_diff")).toBe(false);
    expect(isMutatingGitTool("read_file")).toBe(false);
  });
});

describe("filesystem sandbox", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yama-sandbox-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.ts"), "code", "utf-8");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "secrets", "utf-8");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows a file inside the repository", () => {
    const check = resolveInSandbox("src/app.ts", root);
    expect(check.allowed).toBe(true);
  });

  it("refuses traversal above the root", () => {
    const check = resolveInSandbox("../../../etc/passwd", root);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.reason).toMatch(
      /outside the repository/,
    );
  });

  it("refuses an absolute path elsewhere", () => {
    expect(resolveInSandbox("/etc/passwd", root).allowed).toBe(false);
  });

  it("refuses .git, which holds credentials and every past secret", () => {
    const check = resolveInSandbox(".git/config", root);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.reason).toMatch(
      /protected location/,
    );
  });

  it.each([".env", ".env.production", ".npmrc", "id_rsa"])(
    "refuses the credential file %s",
    (name) => {
      writeFileSync(join(root, name), "secret", "utf-8");
      expect(resolveInSandbox(name, root).allowed).toBe(false);
    },
  );

  it("follows symlinks to their real target rather than trusting the prefix", () => {
    const outside = mkdtempSync(join(tmpdir(), "yama-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));
      expect(resolveInSandbox("src/link.txt", root).allowed).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a null byte in the path", () => {
    expect(resolveInSandbox("src/app.ts\0.png", root).allowed).toBe(false);
  });

  it("allows a not-yet-existing path inside the root, so callers can report ENOENT", () => {
    expect(resolveInSandbox("src/new.ts", root).allowed).toBe(true);
  });
});

describe("the system instruction, against architecture §5", () => {
  it("is a static constant with no interpolation", () => {
    // Ground rule 2: Yama never concatenates config, rules or docs into a
    // prompt. A template expression here would be the first crack in that.
    expect(SYSTEM_INSTRUCTION).not.toMatch(/\$\{/);
  });

  it("carries every element §5 requires", () => {
    for (const required of [
      "submit_finding", // the gate rule
      "report_progress", // the harness contract
      "CRITICAL",
      "MAJOR",
      "MINOR",
      "SUGGESTION", // the severity ladder
      "concrete fix", // the finding contract
      "check_results", // the false-positive taxonomy's first line
      "recall",
    ]) {
      expect(SYSTEM_INSTRUCTION).toContain(required);
    }
  });

  it("tells the agent it is uncapped, because it is", () => {
    // Rule 13: no turn, step or token budget anywhere. An instruction implying
    // one would make the agent self-limit against a harness that never asked.
    expect(SYSTEM_INSTRUCTION).toMatch(/no limit on how many turns/i);
  });

  it("names no provider, server or VCS", () => {
    // Rule 7 applies to the prompt as much as to the code: an instruction that
    // says "GitHub" is wrong the moment someone points Yama at Bitbucket.
    for (const forbidden of [
      "GitHub",
      "Bitbucket",
      "GitLab",
      "vertex",
      "litellm",
      "OpenAI",
      "Claude",
    ]) {
      expect(SYSTEM_INSTRUCTION).not.toContain(forbidden);
    }
  });

  it("stays small enough for a small model to hold", () => {
    // §5 budgets ~1.5 KB. This is the whole reason there is no prompt assembly;
    // a regression here is a design regression, not a style one.
    expect(SYSTEM_INSTRUCTION.length).toBeLessThan(4_000);
  });
});
