import {
  buildChangeSet,
  changedPaths,
  fileInChangeSet,
  findFile,
  lineWasChanged,
  parseUnifiedDiff,
} from "../../../src/v4/changes/ChangeSet.js";
import {
  globToRegExp,
  looksGenerated,
  matchesAnyPath,
  matchesPath,
} from "../../../src/v4/policy/paths.js";

const MODIFY = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ export function handler() {
   const a = 1;
-  const b = 2;
+  const b = 3;
+  const c = 4;
   return a + b;
 }
`;

const ADD = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const one = 1;
+export const two = 2;
+export const three = 3;
`;

const DELETE = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = true;
`;

const RENAME = `diff --git a/src/before.ts b/src/after.ts
similarity index 92%
rename from src/before.ts
rename to src/after.ts
index 5555555..6666666 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 4;
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("path globs", () => {
  it.each([
    ["src/a.ts", "src/*.ts", true],
    ["src/nested/a.ts", "src/*.ts", false],
    ["src/nested/a.ts", "src/**/*.ts", true],
    ["src/a.ts", "src/**/*.ts", true],
    ["src/a.ts", "**/*.ts", true],
    ["a.ts", "**/*.ts", true],
    ["src/a.tsx", "src/*.{ts,tsx}", true],
    ["src/a.js", "src/*.{ts,tsx}", false],
    ["src/ab.ts", "src/?.ts", false],
    ["src/a.ts", "src/?.ts", true],
    ["dist/x/y.js", "dist/**", true],
    ["distant/x.js", "dist/**", false],
  ])("%s vs %s → %s", (path, glob, expected) => {
    expect(matchesPath(path, glob)).toBe(expected);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(matchesPath("a+b.ts", "a+b.ts")).toBe(true);
    expect(matchesPath("axb.ts", "a+b.ts")).toBe(false);
  });

  it("normalises windows separators and leading ./", () => {
    expect(matchesPath("src\\a.ts", "src/*.ts")).toBe(true);
    expect(matchesPath("./src/a.ts", "src/*.ts")).toBe(true);
  });

  it("matchesAnyPath is false for an empty or missing list", () => {
    expect(matchesAnyPath("a.ts", [])).toBe(false);
    expect(matchesAnyPath("a.ts", undefined)).toBe(false);
  });

  it("compiles anchored patterns", () => {
    const regex = globToRegExp("src/*.ts");
    expect(regex.source.startsWith("^")).toBe(true);
    expect(regex.source.endsWith("$")).toBe(true);
    expect(regex.test("src/a.ts")).toBe(true);
    expect(regex.test("x/src/a.ts")).toBe(false);
  });

  it("detects generated files regardless of language", () => {
    expect(looksGenerated("api/types.generated.ts")).toBe(true);
    expect(looksGenerated("pkg/model.pb.go")).toBe(true);
    expect(looksGenerated("gen/schema_pb2.py")).toBe(true);
    expect(looksGenerated("lib/user.g.dart")).toBe(true);
    expect(looksGenerated("src/handwritten.ts")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("records added lines by their NEW-side line number", () => {
    const [file] = parseUnifiedDiff(MODIFY);
    expect(file.path).toBe("src/app.ts");
    expect(file.kind).toBe("modified");
    expect([...file.addedLines].sort((a, b) => a - b)).toEqual([11, 12]);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("records removed lines by their OLD-side line number", () => {
    const [file] = parseUnifiedDiff(MODIFY);
    expect([...file.removedLines]).toEqual([11]);
  });

  it("marks an added file and captures every line", () => {
    const [file] = parseUnifiedDiff(ADD);
    expect(file.kind).toBe("added");
    expect([...file.addedLines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("marks a deleted file", () => {
    const [file] = parseUnifiedDiff(DELETE);
    expect(file.kind).toBe("deleted");
    expect(file.path).toBe("src/old.ts");
    expect(file.deletions).toBe(2);
  });

  it("captures both sides of a rename", () => {
    const [file] = parseUnifiedDiff(RENAME);
    expect(file.kind).toBe("renamed");
    expect(file.path).toBe("src/after.ts");
    expect(file.previousPath).toBe("src/before.ts");
  });

  it("marks binary files rather than mangling them", () => {
    const [file] = parseUnifiedDiff(BINARY);
    expect(file.kind).toBe("binary");
  });

  it("parses several files in one diff", () => {
    expect(parseUnifiedDiff([MODIFY, ADD, DELETE].join(""))).toHaveLength(3);
  });

  it("handles a single-line hunk header with no count", () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -5 +5 @@\n-old\n+new\n`,
    );
    expect([...file.addedLines]).toEqual([5]);
    expect([...file.removedLines]).toEqual([5]);
  });

  it("ignores the no-newline marker without consuming a line", () => {
    const [file] = parseUnifiedDiff(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n line\n-old\n\\ No newline at end of file\n+new\n`,
    );
    expect([...file.addedLines]).toEqual([2]);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("skips an unrecognised header rather than failing the run", () => {
    const files = parseUnifiedDiff(
      `diff --git a/x.ts b/x.ts\nold mode 100644\nnew mode 100755\n`,
    );
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toEqual([]);
  });
});

describe("buildChangeSet", () => {
  const base = {
    diff: [MODIFY, ADD, BINARY].join(""),
    excludePatterns: [] as string[],
    maxFiles: 100,
  };

  it("keeps reviewable files and reports what it excluded", () => {
    const changeSet = buildChangeSet(base);
    expect(changeSet.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "src/new.ts",
    ]);
    expect(changeSet.excluded.map((file) => file.excludedReason)).toEqual([
      "binary",
    ]);
  });

  it("enforces excludePatterns IN CODE, not as a prompt request", () => {
    const changeSet = buildChangeSet({
      ...base,
      excludePatterns: ["src/new.*"],
    });
    expect(changeSet.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(
      changeSet.excluded.find((file) => file.path === "src/new.ts")
        ?.excludedReason,
    ).toBe("excludePatterns");
  });

  it("excludes generated files without needing them in config", () => {
    const generated = `diff --git a/api/types.generated.ts b/api/types.generated.ts
--- a/api/types.generated.ts
+++ b/api/types.generated.ts
@@ -1,1 +1,1 @@
-a
+b
`;
    const changeSet = buildChangeSet({ ...base, diff: generated });
    expect(changeSet.files).toEqual([]);
    expect(changeSet.excluded[0].excludedReason).toBe("generated");
  });

  it("keeps the LARGEST changes when maxFiles truncates — risk lives in big files", () => {
    const tiny = `diff --git a/tiny.ts b/tiny.ts
--- a/tiny.ts
+++ b/tiny.ts
@@ -1,1 +1,1 @@
-a
+b
`;
    const changeSet = buildChangeSet({
      diff: [tiny, ADD].join(""),
      excludePatterns: [],
      maxFiles: 1,
    });

    expect(changeSet.truncated).toBe(true);
    expect(changeSet.files).toHaveLength(1);
    // ADD changes 3 lines; tiny changes 2. The bigger change survives.
    expect(changeSet.files[0].path).toBe("src/new.ts");
    expect(
      changeSet.excluded.find((file) => file.path === "tiny.ts")
        ?.excludedReason,
    ).toBe("maxFiles");
  });

  it("does not flag truncation when everything fits", () => {
    expect(buildChangeSet(base).truncated).toBe(false);
  });

  it("totals additions and deletions across reviewed files only", () => {
    const changeSet = buildChangeSet(base);
    expect(changeSet.totalAdditions).toBe(5);
    expect(changeSet.totalDeletions).toBe(1);
  });
});

describe("change-set lookups", () => {
  const changeSet = buildChangeSet({
    diff: [MODIFY, RENAME, DELETE].join(""),
    excludePatterns: [],
    maxFiles: 100,
  });

  it("finds a file by its current path", () => {
    expect(findFile(changeSet, "src/app.ts")?.kind).toBe("modified");
  });

  it("finds a renamed file by EITHER path", () => {
    expect(findFile(changeSet, "src/after.ts")?.kind).toBe("renamed");
    expect(findFile(changeSet, "src/before.ts")?.kind).toBe("renamed");
  });

  it("normalises the lookup path", () => {
    expect(fileInChangeSet(changeSet, "./src/app.ts")).toBe(true);
    expect(fileInChangeSet(changeSet, "src\\app.ts")).toBe(true);
  });

  it("reports a file outside the change set", () => {
    expect(fileInChangeSet(changeSet, "src/untouched.ts")).toBe(false);
  });

  it("lineWasChanged is true only for lines the PR actually added", () => {
    expect(lineWasChanged(changeSet, "src/app.ts", 11)).toBe(true);
    expect(lineWasChanged(changeSet, "src/app.ts", 12)).toBe(true);
    expect(lineWasChanged(changeSet, "src/app.ts", 10)).toBe(false);
    expect(lineWasChanged(changeSet, "src/app.ts", 99)).toBe(false);
  });

  it("treats any line of a deleted file as changed — the deletion is the finding", () => {
    expect(lineWasChanged(changeSet, "src/old.ts", 1)).toBe(true);
    expect(lineWasChanged(changeSet, "src/old.ts", 500)).toBe(true);
  });

  it("returns false for a file that is not in the change set at all", () => {
    expect(lineWasChanged(changeSet, "nope.ts", 1)).toBe(false);
  });

  it("changedPaths includes both sides of a rename", () => {
    const paths = changedPaths(changeSet);
    expect(paths).toContain("src/after.ts");
    expect(paths).toContain("src/before.ts");
  });

  it("changedPaths can include excluded files for policy evaluation", () => {
    const withBinary = buildChangeSet({
      diff: [MODIFY, BINARY].join(""),
      excludePatterns: [],
      maxFiles: 100,
    });
    expect(changedPaths(withBinary)).not.toContain("logo.png");
    expect(changedPaths(withBinary, { includeExcluded: true })).toContain(
      "logo.png",
    );
  });
});

/**
 * The deletions policy.
 *
 * On a refactor-heavy pull request, deletions can be a third of the change —
 * 93 of 280 files on this repository's own v4 PR, pushing 81 live files out of
 * a 200-file scope. "ignore" reclaims that budget without hiding the deletions
 * from policy: excluded files are still read by ownership and guards.
 */
describe("deletions policy", () => {
  const base = {
    diff: [MODIFY, ADD, DELETE].join(""),
    excludePatterns: [] as string[],
    maxFiles: 100,
  };

  it("reviews deleted content by default — existing behaviour is unchanged", () => {
    const changeSet = buildChangeSet(base);
    expect(changeSet.files.map((file) => file.path)).toContain("src/old.ts");
  });

  it("moves deletions to excluded under ignore, with a named reason", () => {
    const changeSet = buildChangeSet({ ...base, deletions: "ignore" });
    expect(changeSet.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "src/new.ts",
    ]);
    const dropped = changeSet.excluded.find(
      (file) => file.path === "src/old.ts",
    );
    expect(dropped?.excludedReason).toBe("deleted");
  });

  it("does not let deletions consume the maxFiles budget under ignore", () => {
    // One slot, two live files plus a deletion. Under "content" the deletion
    // competes for the slot; under "ignore" only live files do.
    const ignored = buildChangeSet({
      ...base,
      deletions: "ignore",
      maxFiles: 2,
    });
    expect(ignored.files.map((file) => file.path).sort()).toEqual([
      "src/app.ts",
      "src/new.ts",
    ]);
    expect(ignored.truncated).toBe(false);
  });

  it("keeps ignored deletions visible to policy via changedPaths", () => {
    const changeSet = buildChangeSet({ ...base, deletions: "ignore" });
    expect(changedPaths(changeSet, { includeExcluded: true })).toContain(
      "src/old.ts",
    );
  });
});

describe("hunk content that looks like a file header", () => {
  it("treats a deleted SQL comment as a deletion, not a header", () => {
    // `-- drop old index` deleted from a .sql file appears in the diff as
    // `--- drop old index`. The parser used to swallow it as a file header:
    // the deletion vanished and every later line number in the hunk shifted.
    const diff = `diff --git a/db/migrate.sql b/db/migrate.sql
--- a/db/migrate.sql
+++ b/db/migrate.sql
@@ -1,3 +1,2 @@
 CREATE INDEX idx_a ON t(a);
--- drop old index
 CREATE INDEX idx_b ON t(b);
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("db/migrate.sql");
    expect(files[0].deletions).toBe(1);
    expect(files[0].removedLines.has(2)).toBe(true);
  });

  it("treats an added ++ line as an addition, not a path change", () => {
    // Added content `++ x` appears as `+++ x` and used to re-key the whole
    // file to the garbage path "x", misattributing every later added line.
    const diff = `diff --git a/inc.c b/inc.c
--- a/inc.c
+++ b/inc.c
@@ -1,2 +1,3 @@
 int main() {
+++counter;
 }
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("inc.c");
    expect(files[0].additions).toBe(1);
    expect(files[0].addedLines.has(2)).toBe(true);
  });
});
