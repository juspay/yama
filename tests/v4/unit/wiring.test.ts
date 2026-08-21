import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Is every capability actually reachable from an entry point?
 *
 * Nine plan deliverables once shipped as modules that existed, exported cleanly
 * from `src/v4/index.ts`, and had passing unit tests — while nothing in the
 * review or learn path ever called them. The tests were green, the boxes were
 * ticked, and the features did not exist at runtime. Re-exporting a module from
 * the SDK barrel is not wiring: it makes a module importable by a consumer, not
 * reached by a run.
 *
 * So this walks the real import graph from each entry point, deliberately
 * ignoring `index.ts`, and asserts the modules that carry a user-visible
 * promise are on it.
 */

const SRC = resolve(__dirname, "..", "..", "..", "src", "v4");

/** Every module reachable from a root, following relative imports only. */
function reachableFrom(...roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = roots.map((root) => resolve(SRC, root));

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      // A specifier that does not resolve to a file on disk is not a module of
      // ours — an external package, or a type-only path. Nothing to walk.
      continue;
    }

    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1].replace(/\.js$/, ".ts");
      const resolved = resolve(dirname(file), specifier);
      queue.push(resolved);
    }
  }

  return seen;
}

const relativeToSrc = (files: Set<string>): Set<string> =>
  new Set([...files].map((file) => relative(SRC, file).replace(/\\/g, "/")));

const review = relativeToSrc(reachableFrom("core/ReviewRunner.ts"));
const learn = relativeToSrc(reachableFrom("learn/LearnRunner.ts"));
const cli = relativeToSrc(reachableFrom("cli/cli.ts"));
const everything = new Set([...review, ...learn, ...cli]);

describe("the review path reaches what a review promises", () => {
  const required: Array<[string, string]> = [
    ["judge/inline.ts", "confidenceThreshold has no effect without it"],
    ["judge/scorecard.ts", "the run report carries no metrics without it"],
    ["prompts/PromptStore.ts", "prompts would never come from the platform"],
    ["prompts/local.ts", "the shipped prompt text would never be read"],
    ["core/StructuredCall.ts", "no schema-bound pass would run"],
    ["agents/turnContract.ts", "turns would carry no output schema"],
    ["checks/extract.ts", "parse: agent would report nothing, as a stub"],
    ["product/Capabilities.ts", "the capability map would never be used"],
    ["core/ToolExposure.ts", "posting tools would stay in reach during review"],
    ["findings/Gate.ts", "nothing would be gated"],
    ["findings/Ledger.ts", "posted-versus-accepted would go unaccounted"],
    ["artifacts/PrArtifact.ts", "re-runs would not be incremental"],
  ];

  it.each(required)("%s is on the review path — %s", (module) => {
    expect(review.has(module)).toBe(true);
  });
});

describe("the learn path reaches what learning promises", () => {
  const required: Array<[string, string]> = [
    ["learn/Triage.ts", "nothing would be classified"],
    ["learn/KnowledgeWriter.ts", "nothing would be written"],
    ["learn/GitWriter.ts", "nothing would be committed"],
    ["judge/scorecard.ts", "precision and recall would never be measured"],
    ["artifacts/PrArtifact.ts", "the PR artifact would never be consumed"],
    ["product/Capabilities.ts", "the impact log would never be written"],
    ["prompts/PromptStore.ts", "the triage prompt could not be managed"],
  ];

  it.each(required)("%s is on the learn path — %s", (module) => {
    expect(learn.has(module)).toBe(true);
  });
});

describe("every command the docs promise exists", () => {
  const source = readFileSync(join(SRC, "cli", "cli.ts"), "utf-8");
  const commands = [...source.matchAll(/\.command\("([a-z]+)"\)/g)].map(
    (match) => match[1],
  );

  it.each([
    "doctor",
    "init",
    "migrate",
    "learn",
    "review",
    "bootstrap",
    "config",
  ])("yama %s", (name) => {
    expect(commands).toContain(name);
  });

  it("reaches the bootstrap runner, not only the pure planner", () => {
    // `Bootstrap.ts` was reachable through a test the whole time it had no
    // command. Reaching the runner is what proves a user can invoke it.
    expect(cli.has("learn/BootstrapRunner.ts")).toBe(true);
  });
});

describe("no module is stranded", () => {
  /** Every .ts file under src/v4, except types and the SDK barrel. */
  function allModules(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "types") {
          allModules(path, found);
        }
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        found.push(relative(SRC, path).replace(/\\/g, "/"));
      }
    }
    return found;
  }

  it("every module is reached by an entry point, not only by the barrel", () => {
    const stranded = allModules(SRC)
      .filter((module) => module !== "index.ts")
      .filter((module) => !everything.has(module));

    // A module only the barrel exports is a module no run executes. If this
    // fails, either wire it up or delete it — do not add it to an exception
    // list, because that is precisely how nine of them accumulated.
    expect(stranded).toEqual([]);
  });
});
