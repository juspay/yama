import {
  describePrompts,
  localCatalog,
  localPrompt,
  requestedIds,
  resolvePrompts,
} from "../../../src/v4/prompts/PromptStore.js";
import {
  LOCAL_PROMPTS,
  PROMPT_IDS,
  promptIdForSubAgent,
} from "../../../src/v4/prompts/local.js";
import { SUB_AGENTS } from "../../../src/v4/agents/subAgents.js";
import type {
  PromptFetcher,
  PromptId,
  PromptsConfig,
} from "../../../src/v4/types/index.js";

const env = {} as NodeJS.ProcessEnv;

describe("the local catalog", () => {
  it("ships text for every declared prompt id", () => {
    for (const id of PROMPT_IDS) {
      expect(LOCAL_PROMPTS[id].trim().length).toBeGreaterThan(50);
    }
  });

  it("contains no template expression in any prompt", () => {
    // The same invariant the system instruction is held to, applied to every
    // prompt: a prompt is a constant, and anything interpolated into one is
    // context that belongs in a tool result.
    for (const id of PROMPT_IDS) {
      expect(LOCAL_PROMPTS[id]).not.toMatch(/\$\{/);
      expect(LOCAL_PROMPTS[id]).not.toMatch(/\{\{/);
    }
  });

  it("maps every specialist to a prompt id", () => {
    for (const agent of SUB_AGENTS) {
      const id = promptIdForSubAgent(agent.id);
      expect(id).toBeDefined();
      expect(LOCAL_PROMPTS[id as PromptId]).toBe(agent.instructions);
    }
  });

  it("returns nothing for an unknown specialist", () => {
    expect(promptIdForSubAgent("investigate_nothing")).toBeUndefined();
  });
});

describe("resolvePrompts", () => {
  it("never touches the platform when prompts are disabled", async () => {
    const fetcher = jest.fn();
    const catalog = await resolvePrompts({
      config: { enabled: false },
      env,
      fetcher: fetcher as unknown as PromptFetcher,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(catalog.get("yama-review")).toBe(LOCAL_PROMPTS["yama-review"]);
    expect(catalog.warnings).toEqual([]);
    expect(catalog.resolved.every((entry) => entry.source === "local")).toBe(
      true,
    );
  });

  it("falls back to local text with a warning when credentials are absent", async () => {
    const catalog = await resolvePrompts({
      config: { enabled: true, provider: "langfuse" },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(catalog.get("yama-review")).toBe(LOCAL_PROMPTS["yama-review"]);
    expect(catalog.warnings.join(" ")).toMatch(/not both set/);
    // The run is explicitly said to be unaffected — this is a degradation, not
    // a failure, and the message has to make that clear.
    expect(catalog.warnings.join(" ")).toMatch(/review is unaffected/);
  });

  it("uses the platform's text when it returns one", async () => {
    const fetcher: PromptFetcher = async (id) => ({
      text: `remote text for ${id}`,
      version: "7",
    });

    const catalog = await resolvePrompts({
      config: { enabled: true, only: ["yama-review"] },
      env,
      fetcher,
    });

    expect(catalog.get("yama-review")).toBe("remote text for yama-review");
    // Everything not requested stays local.
    expect(catalog.get("yama-judge")).toBe(LOCAL_PROMPTS["yama-judge"]);

    const review = catalog.resolved.find((entry) => entry.id === "yama-review");
    expect(review?.source).toBe("remote");
    expect(review?.version).toBe("7");
  });

  it("treats an echoed fallback as unmanaged, not as remote", async () => {
    // The platform SDK returns the fallback we handed it when it holds no entry.
    // Recording that as "remote" would claim a prompt is managed when it is not.
    const fetcher: PromptFetcher = async (_id, fallback) => ({
      text: fallback,
    });

    const catalog = await resolvePrompts({
      config: { enabled: true },
      env,
      fetcher,
    });

    expect(catalog.resolved.every((entry) => entry.source === "local")).toBe(
      true,
    );
    // Nothing managed at all is worth one line: the SDK cannot tell "no such
    // prompt" from "could not connect", and a team believing their published
    // edits are live when they are not is the failure worth catching.
    expect(catalog.warnings.join(" ")).toMatch(
      /every prompt resolved to the text Yama ships/,
    );
  });

  it("stays quiet when at least one prompt is managed", async () => {
    const fetcher: PromptFetcher = async (id, fallback) =>
      id === "yama-review" ? { text: "managed" } : { text: fallback };
    const catalog = await resolvePrompts({
      config: { enabled: true },
      env,
      fetcher,
    });
    expect(catalog.warnings).toEqual([]);
  });

  it("treats an empty remote answer as unmanaged", async () => {
    const fetcher: PromptFetcher = async () => ({ text: "   " });
    const catalog = await resolvePrompts({
      config: { enabled: true },
      env,
      fetcher,
    });
    expect(catalog.get("yama-judge")).toBe(LOCAL_PROMPTS["yama-judge"]);
  });

  it("isolates a single failing prompt from the rest", async () => {
    const fetcher: PromptFetcher = async (id) => {
      if (id === "yama-judge") {
        throw new Error("404 not found");
      }
      return { text: `remote ${id}` };
    };

    const catalog = await resolvePrompts({
      config: { enabled: true },
      env,
      fetcher,
    });

    expect(catalog.get("yama-judge")).toBe(LOCAL_PROMPTS["yama-judge"]);
    expect(catalog.get("yama-review")).toBe("remote yama-review");
    expect(catalog.warnings.join(" ")).toMatch(/yama-judge.*404 not found/);
  });

  it("never throws when every prompt fails", async () => {
    const fetcher: PromptFetcher = async () => {
      throw new Error("connection refused");
    };
    const catalog = await resolvePrompts({
      config: { enabled: true },
      env,
      fetcher,
    });

    for (const id of PROMPT_IDS) {
      expect(catalog.get(id)).toBe(LOCAL_PROMPTS[id]);
    }
    expect(catalog.warnings.length).toBe(PROMPT_IDS.length);
  });
});

describe("requestedIds", () => {
  const cases: Array<[string, PromptsConfig, number]> = [
    ["no filter means all", { enabled: true }, PROMPT_IDS.length],
    [
      "an empty filter means all",
      { enabled: true, only: [] },
      PROMPT_IDS.length,
    ],
    ["a filter narrows", { enabled: true, only: ["yama-review"] }, 1],
    [
      "a filter of two narrows to two",
      { enabled: true, only: ["yama-review", "yama-judge"] },
      2,
    ],
  ];

  it.each(cases)("%s", (_name, config, expected) => {
    expect(requestedIds(config)).toHaveLength(expected);
  });
});

describe("reporting", () => {
  it("names the source of every prompt", () => {
    const lines = describePrompts({
      get: localPrompt,
      resolved: [
        { id: "yama-review", text: "x", source: "remote", version: "3" },
        { id: "yama-judge", text: "y", source: "local", reason: "timeout" },
      ],
      warnings: [],
    });

    expect(lines[0]).toMatch(/yama-review\s+platform v3/);
    expect(lines[1]).toMatch(/yama-judge\s+built in \(timeout\)/);
  });

  it("reports a fully local catalog", () => {
    expect(describePrompts(localCatalog())).toHaveLength(PROMPT_IDS.length);
  });
});
