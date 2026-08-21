import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCI, loadLocalEnv, parseEnvFile } from "../../../src/v4/cli/env.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yama-env-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isCI", () => {
  it.each(["CI", "GITHUB_ACTIONS", "JENKINS_URL", "BITBUCKET_BUILD_NUMBER"])(
    "detects %s",
    (marker) => {
      expect(isCI({ [marker]: "true" })).toBe(true);
    },
  );

  it("treats an empty or false marker as not CI", () => {
    expect(isCI({ CI: "" })).toBe(false);
    expect(isCI({ CI: "false" })).toBe(false);
    expect(isCI({ CI: "0" })).toBe(false);
  });

  it("is false with no markers", () => {
    expect(isCI({})).toBe(false);
  });
});

describe("parseEnvFile", () => {
  it("parses assignments, ignoring comments and blanks", () => {
    expect(
      parseEnvFile("# comment\n\nA=1\nB = two \nexport C=three\n"),
    ).toEqual({ A: "1", B: "two", C: "three" });
  });

  it("strips matched quotes", () => {
    expect(parseEnvFile(`A="x"\nB='y'\nC="mismatched'\n`)).toEqual({
      A: "x",
      B: "y",
      C: `"mismatched'`,
    });
  });

  it("skips lines that are not assignments", () => {
    expect(parseEnvFile("not an assignment\n1BAD=x\nGOOD=y\n")).toEqual({
      GOOD: "y",
    });
  });

  it("keeps a value containing =", () => {
    expect(parseEnvFile("URL=https://x?a=b\n")).toEqual({
      URL: "https://x?a=b",
    });
  });
});

describe("loadLocalEnv", () => {
  it("loads a local .env", () => {
    writeFileSync(join(root, ".env"), "TOKEN=abc\n", "utf-8");
    const env: NodeJS.ProcessEnv = {};

    const result = loadLocalEnv(root, env);

    expect(result.loaded).toBe(true);
    expect(result.applied).toEqual(["TOKEN"]);
    expect(env.TOKEN).toBe("abc");
  });

  it("REFUSES in CI — the checkout is the pull request", () => {
    writeFileSync(
      join(root, ".env"),
      "LITELLM_BASE_URL=https://evil.invalid\n",
      "utf-8",
    );
    const env: NodeJS.ProcessEnv = { CI: "true" };

    const result = loadLocalEnv(root, env);

    expect(result.loaded).toBe(false);
    expect(env.LITELLM_BASE_URL).toBeUndefined();
    expect(result.reason).toMatch(/written by someone outside the team/);
  });

  it("never overrides a variable the environment already set", () => {
    writeFileSync(join(root, ".env"), "TOKEN=from-file\n", "utf-8");
    const env: NodeJS.ProcessEnv = { TOKEN: "from-secret-store" };

    const result = loadLocalEnv(root, env);

    expect(env.TOKEN).toBe("from-secret-store");
    expect(result.applied).toEqual([]);
  });

  it("reports NAMES only, never values", () => {
    writeFileSync(join(root, ".env"), "SECRET=super-secret-value\n", "utf-8");
    const result = loadLocalEnv(root, {});
    expect(JSON.stringify(result)).not.toMatch(/super-secret-value/);
  });

  it("is a no-op with no .env", () => {
    expect(loadLocalEnv(root, {}).loaded).toBe(false);
  });
});
