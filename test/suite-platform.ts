/**
 * Suite: the platform layer, the checks tool and Delivery (TASKS:Y1.3, Y5.1, Y5.2, Y5.4,
 * Y3.5, Y6.2, Y6.3).
 *
 * The thing under test is a promise: **Yama's code never spells a platform tool name.**
 * `mcp.yaml` says which tool provides which capability, the probe proves that tool is
 * really there, the registry resolves it, and every stage gets exactly the tools its phase
 * allows. So what is pinned here is the resolution, the probe's two failure modes, the
 * stage-scoped exposure, and what Delivery can prove actually landed.
 *
 * Everything runs against the BUILT package. Nothing needs a provider. The one case that
 * needs a live MCP server skips without one.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

import {
  DIST_ENTRY,
  FIXTURES,
  Skip,
  assert,
  assertEqual,
  assertExit,
  assertIncludes,
  defineSuite,
  distModule,
  gitWorkspace,
  isBuilt,
  runCLI,
  runCommand,
  withTempDir,
} from "./run.js";

const { test, section, skipAll } = defineSuite("platform-checks-delivery");

/** Only the parts of a GitHub workflow this suite asserts over. */
type WorkflowStep = {
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, unknown>;
};

type WorkflowFile = { jobs: { review: { steps: WorkflowStep[] } } };

type ToolRecord = {
  description: string;
  inputSchema?: object;
  execute: (params: unknown, context?: unknown) => Promise<unknown>;
};

type ToolResult = Record<string, unknown> & {
  isError?: boolean;
  error?: string;
};

const registry = () => {
  const tools = new Map<string, ToolRecord>();
  return {
    register: (name: string, tool: ToolRecord) => tools.set(name, tool),
    call: async (name: string, params?: unknown): Promise<ToolResult> =>
      (await tools.get(name)?.execute(params ?? {})) as ToolResult,
    has: (name: string) => tools.has(name),
    names: () => [...tools.keys()],
  };
};

/** A capability binding as the loader produces one. */
const binding = (
  capability: string,
  server: string,
  tool: string,
  args: Record<string, string> = {},
) => ({ capability, server, tool, args });

const finding = (
  id: string,
  severity: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  file: "src/auth.ts",
  line: 42,
  severity,
  category: "security",
  summary: `${id} summary`,
  impact: "a token reaches the log",
  evidence: [{ kind: "code", ref: "src/auth.ts:42" }],
  ...extra,
});

const diffOf = (paths: readonly string[]) => ({
  files: paths.map((file) => ({
    path: file,
    status: "modified",
    additions: 1,
    deletions: 0,
  })),
  additions: paths.length,
  deletions: 0,
  patch: "",
  empty: paths.length === 0,
});

/** The mcp.yaml a delivery-capable repository has: long form, with platform coordinates. */
const DELIVERY_MCP = [
  "servers:",
  "  forge:",
  "    transport: stdio",
  "    command: node",
  '    args: ["-e", "0"]',
  "capabilities:",
  "  pr.read:",
  "    tool: forge.read_pr",
  "    args:",
  '      repo: "${YAMA_TEST_REPO}"',
  '      pull: "${pr}"',
  "  pr.diff: forge.read_diff",
  "  comment.list:",
  "    tool: forge.list_comments",
  "    args:",
  '      pull: "${pr}"',
  "  comment.inline.create:",
  "    tool: forge.create_inline",
  "    args:",
  '      pull: "${pr}"',
  "  comment.summary.create: forge.create_summary",
  "  verdict.set: forge.set_state",
  "",
].join("\n");

const DELIVERY_YAMA = [
  "models:",
  "  main:",
  "    provider: google-ai",
  "    model: gemini-2.5-flash",
  "delivery:",
  "  inlineComments: true",
  "  summaryComment: true",
  "  verdict: true",
  "  maxInlineComments: 2",
  "  minSeverity: MAJOR",
  "",
].join("\n");

if (!isBuilt()) {
  skipAll("dist/ is absent — run `pnpm run build` first");
} else {
  section("the capability map: config's vocabulary, never code's");

  await test("the long form carries the platform coordinates, resolved", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("caps", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        DELIVERY_MCP,
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const config = await mod.loadConfig(dir, { mode: "pr", pr: 42 });
      assertEqual(
        config.capabilities["pr.read"].tool,
        "read_pr",
        "the tool name comes out of config",
      );
      assertEqual(
        config.capabilities["pr.read"].args.repo,
        "acme/widgets",
        "an environment reference is expanded",
      );
      assertEqual(
        config.capabilities["pr.read"].args.pull,
        "42",
        "a run placeholder is filled from the target",
      );
      assertEqual(
        Object.keys(config.capabilities["pr.diff"].args).length,
        0,
        "the short form binds a tool and no arguments",
      );
    });
  });

  await test("an unset environment reference in args is loud, not empty", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("caps", async (dir) => {
      await gitWorkspace(dir);
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        [
          "servers:",
          "  forge:",
          "    transport: stdio",
          "    command: node",
          "capabilities:",
          "  pr.read:",
          "    tool: forge.read_pr",
          "    args:",
          '      token: "${YAMA_DEFINITELY_UNSET_VAR}"',
          "",
        ].join("\n"),
        "utf8",
      );
      delete process.env.YAMA_DEFINITELY_UNSET_VAR;
      let message = "";
      try {
        await mod.loadConfig(dir, { mode: "local" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "YAMA_DEFINITELY_UNSET_VAR", "the missing var");
      assertIncludes(message, "capabilities.pr.read.args", "where it is used");
    });
  });

  await test("a pull-request run refuses to start without a way to read its comments", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("caps", async (dir) => {
      await gitWorkspace(dir);
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        [
          "servers:",
          "  forge:",
          "    transport: stdio",
          "    command: node",
          "capabilities:",
          "  pr.read: forge.read_pr",
          "",
        ].join("\n"),
        "utf8",
      );
      // Local mode does not care: there is nothing to dedupe against.
      await mod.loadConfig(dir, { mode: "local" });

      let message = "";
      try {
        await mod.loadConfig(dir, { mode: "pr", pr: 3 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(
        message,
        "comment.list",
        "the capability it cannot do without",
      );
      assertIncludes(
        message,
        "<server>.<tool>",
        "and the shape of the line that fixes it",
      );
    });
  });

  await test("a capability this mode cannot use says so, rather than 'not mapped'", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("caps", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        DELIVERY_MCP,
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const report = await mod.runDoctor({
        root: dir,
        target: { mode: "local" },
        engine: { connectMcp: async () => [] },
      });
      const row = report.checks.find(
        (c: { group: string; name: string }) =>
          c.group === "capabilities" && c.name === "comment.list",
      );
      assertEqual(row.status, "off", "it is off for a local run");
      assertIncludes(
        row.detail,
        "local run has no value for",
        "and the reason is the real one, not 'not mapped'",
      );
    });
  });

  section("the registry resolves capabilities; nothing else knows a tool name");

  await test("a mapped capability resolves, an unmapped one is simply off", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = mod.createCapabilityRegistry({
      "comment.list": binding("comment.list", "forge", "list_comments"),
    });
    assertEqual(reg.toolFor("comment.list"), "list_comments", "resolved tool");
    assertEqual(reg.has("verdict.set"), false, "unmapped capability");
    assertEqual(reg.toolFor("verdict.set"), undefined, "resolves to nothing");
    assertEqual(
      reg.toolsFor(["comment.list", "verdict.set"]).join(","),
      "list_comments",
      "an unmapped capability drops out of a tool list",
    );
  });

  await test("a capability the caller cannot proceed without names its fix", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = mod.createCapabilityRegistry({});
    let message = "";
    try {
      reg.requireTool("comment.inline.create");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(message, "comment.inline.create", "the capability");
    assertIncludes(message, "mcp.yaml", "where to map it");
    assertIncludes(message, "yama doctor", "how to check it");
  });

  await test("delivery tools cover the enabled actions and the reads they depend on", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = mod.createCapabilityRegistry({
      "comment.list": binding("comment.list", "forge", "list_comments"),
      "comment.inline.create": binding(
        "comment.inline.create",
        "forge",
        "create_inline",
      ),
      "verdict.set": binding("verdict.set", "forge", "set_state"),
    });
    const tools = reg.deliveryTools(["inlineComments"]);
    assert(tools.includes("create_inline"), "the posting tool");
    assert(
      tools.includes("list_comments"),
      "and the read it is paired with — posting without reading cannot dedupe",
    );
    assert(
      !tools.includes("set_state"),
      "an action this run is not doing brings no tool with it",
    );
  });

  await test("the pending-review lifecycle rides with inline posting when mapped", async () => {
    const mod = await import(DIST_ENTRY);
    const paired = mod.createCapabilityRegistry({
      "comment.list": binding("comment.list", "forge", "list_comments"),
      "comment.inline.create": binding(
        "comment.inline.create",
        "forge",
        "create_inline",
      ),
      "review.begin": binding("review.begin", "forge", "begin_review"),
      "review.submit": binding("review.submit", "forge", "submit_review"),
    });
    const tools = paired.deliveryTools(["inlineComments"]);
    assert(tools.includes("begin_review"), "begin rides with inline posting");
    assert(tools.includes("submit_review"), "and so does submit");
    const bare = mod.createCapabilityRegistry({
      "comment.list": binding("comment.list", "forge", "list_comments"),
      "comment.inline.create": binding(
        "comment.inline.create",
        "forge",
        "create_inline",
      ),
    });
    assert(
      !bare.deliveryTools(["inlineComments"]).includes("begin_review"),
      "a forge that never mapped the lifecycle is untouched by it",
    );
  });

  await test("half a review lifecycle is refused: the pair is both-or-neither", async () => {
    const mod = await import(DIST_ENTRY);
    const probe = mod.probeCapabilities({
      bindings: {
        "comment.list": binding("comment.list", "forge", "list_comments"),
        "comment.inline.create": binding(
          "comment.inline.create",
          "forge",
          "create_inline",
        ),
        "review.begin": binding("review.begin", "forge", "begin_review"),
      },
      connections: [
        {
          id: "forge",
          tools: ["list_comments", "create_inline", "begin_review"],
        },
      ],
    });
    const begin = probe.entries.find(
      (entry: { capability: string; status: string }) =>
        entry.capability === "review.begin",
    );
    assertEqual(
      begin?.status,
      "pair-missing",
      "begin without submit writes comments nobody can ever see",
    );
  });

  await test("posting tools are delivery-only: the review phase never sees one", async () => {
    const mod = await import(DIST_ENTRY);
    const reg = mod.createCapabilityRegistry({
      "pr.read": binding("pr.read", "forge", "read_pr"),
      "comment.list": binding("comment.list", "forge", "list_comments"),
      "comment.inline.create": binding(
        "comment.inline.create",
        "forge",
        "create_inline",
      ),
    });
    const review: string[] = reg.reviewTools();
    assert(review.includes("read_pr"), "a review-phase capability is exposed");
    assert(
      !review.includes("create_inline"),
      "a posting capability is not, at any stage before Delivery",
    );
    // A worker only ever gets READ_ONLY_TOOLS (TASKS:Y5.1); nothing in it can post.
    const posting = reg.deliveryTools(["inlineComments"]);
    for (const tool of mod.READ_ONLY_TOOLS as string[]) {
      assert(
        !posting.includes(tool),
        "the worker toolset must hold nothing that reaches the platform",
      );
    }
    assert(
      posting.length > 0,
      "and the delivery toolset must not be empty, or the check above proves nothing",
    );
  });

  section("the probe: config said so, the servers say otherwise");

  await test("a tool no connected server exposes is a config error, with the list", async () => {
    const mod = await import(DIST_ENTRY);
    const probe = mod.probeCapabilities({
      bindings: { "pr.read": binding("pr.read", "forge", "read_pr") },
      connections: [{ id: "forge", tools: ["read_diff", "list_comments"] }],
    });
    const entry = probe.entries.find(
      (row: { capability: string }) => row.capability === "pr.read",
    );
    assertEqual(entry.status, "tool-missing", "the probe names the failure");
    assertIncludes(
      entry.detail,
      "read_diff",
      "and what the server does expose",
    );
    assertEqual(
      probe.live["pr.read"],
      undefined,
      "a capability that is not really there is not live",
    );
    assertEqual(
      probe.problems.length,
      1,
      "and it is carried as a problem, which is what doctor calls BROKEN",
    );

    // A capability the run does not need costs that capability, not the review.
    mod.assertProbe(probe, [], "mcp.yaml");

    let message = "";
    try {
      mod.assertProbe(probe, ["pr.read"], "mcp.yaml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(
      message,
      "capability probe failed",
      "but a run that needs it refuses to start",
    );
    assertIncludes(message, "read_diff", "with the tools that ARE served");
    assertIncludes(
      message,
      "yama doctor",
      "and says how to see the whole table",
    );
  });

  await test("a server that did not connect degrades what it backs, and no more", async () => {
    const mod = await import(DIST_ENTRY);
    const probe = mod.probeCapabilities({
      bindings: { "pr.read": binding("pr.read", "forge", "read_pr") },
      connections: [{ id: "forge", tools: [], error: "spawn npx ENOENT" }],
    });
    assertEqual(
      probe.entries.find(
        (row: { capability: string }) => row.capability === "pr.read",
      ).status,
      "server-unavailable",
      "an outage is not a lie",
    );
    assertEqual(probe.problems.length, 0, "so it is not a loud problem…");
    assert(
      probe.degradations.some((d: { what: string }) => d.what === "pr.read"),
      "…it is a degradation",
    );
    // …until a run needs it.
    let message = "";
    try {
      mod.assertProbe(probe, ["pr.read"], "mcp.yaml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertIncludes(
      message,
      "cannot start without",
      "a required capability is fatal",
    );
    assertIncludes(message, "spawn npx ENOENT", "and carries the real reason");
  });

  await test("a pair broken at runtime takes the capability down with it", async () => {
    const mod = await import(DIST_ENTRY);
    const probe = mod.probeCapabilities({
      bindings: {
        "comment.list": binding("comment.list", "reader", "list_comments"),
        "comment.inline.create": binding(
          "comment.inline.create",
          "writer",
          "create_inline",
        ),
      },
      connections: [
        { id: "reader", tools: [], error: "unreachable" },
        { id: "writer", tools: ["create_inline"] },
      ],
    });
    assertEqual(
      probe.live["comment.inline.create"],
      undefined,
      "posting without reading cannot dedupe, so it is not live",
    );
    assertEqual(probe.problems.length, 1, "and the run is told");
    assertIncludes(probe.problems[0], "comment.list", "which pair is missing");
  });

  await test("a server's secrets are needed to CONNECT it, not to load the config", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("secrets", async (dir) => {
      await gitWorkspace(dir);
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        [
          "servers:",
          "  forge:",
          "    transport: stdio",
          "    command: node",
          "    env:",
          '      TOKEN: "${YAMA_DEFINITELY_UNSET_VAR}"',
          "capabilities: {}",
          "",
        ].join("\n"),
        "utf8",
      );
      delete process.env.YAMA_DEFINITELY_UNSET_VAR;

      // A local review never talks to the platform, so it must not be stopped by it.
      const config = await mod.loadConfig(dir, { mode: "local" });
      assertEqual(
        Object.keys(config.mcp.servers).join(","),
        "forge",
        "the server is still declared",
      );

      let started = false;
      const connections = await mod.connectMcpServers(
        {
          connectMcp: async () => {
            started = true;
            return [];
          },
        },
        config.mcp.servers,
        config.paths.mcpFile,
      );
      assertEqual(
        started,
        false,
        "the server is never started without its secret",
      );
      assertIncludes(
        String(connections[0].error),
        "YAMA_DEFINITELY_UNSET_VAR",
        "and the missing variable is named against THAT server",
      );
      assertIncludes(
        String(connections[0].error),
        "servers.forge.env.TOKEN",
        "with the exact line that needs it",
      );
    });
  });

  await test("a server that never answers becomes unavailable, not a hang", async () => {
    const mod = await import(DIST_ENTRY);
    const connections = await mod.connectMcpServers(
      {
        // The failure mode an `npx`-spawned server actually has: it stalls.
        connectMcp: () => new Promise(() => undefined),
      },
      {
        forge: {
          transport: "stdio",
          command: "node",
          args: [],
          env: {},
          timeoutMs: 50,
        },
      },
    );
    assertEqual(connections.length, 1, "the server is still accounted for");
    assertIncludes(
      String(connections[0].error),
      "did not connect within 50ms",
      "and the bound the host held is named",
    );
    assertIncludes(
      String(connections[0].error),
      "timeoutMs",
      "with the knob that raises it",
    );
  });

  await test("a local run connects nothing: no capability of ours is local", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("probe", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        DELIVERY_MCP,
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const config = await mod.loadConfig(dir, { mode: "local" });
      let connects = 0;
      const platform = await mod.connectPlatform({
        engine: {
          connectMcp: async () => {
            connects += 1;
            return [];
          },
        },
        config,
        target: { mode: "local" },
        degradations: config.degradations,
      });
      assertEqual(connects, 0, "no server is started for a local review");
      assertEqual(
        platform.deliveryActions.length,
        0,
        "and nothing is delivered",
      );
      assert(
        config.degradations.some(
          (d: { what: string }) => d.what === "mcp.forge",
        ),
        "the unconnected server is named in the degradation matrix",
      );
    });
  });

  await test("connectPlatform narrows delivery to what the servers can actually do", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("probe", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        DELIVERY_MCP,
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const config = await mod.loadConfig(dir, { mode: "pr", pr: 7 });
      assertEqual(
        config.deliveryActions.join(","),
        "inlineComments,summaryComment,verdict",
        "config asked for three actions",
      );
      const platform = await mod.connectPlatform({
        engine: {
          // The forge is up, but it cannot set a review state.
          connectMcp: async () => [
            "read_pr",
            "read_diff",
            "list_comments",
            "create_inline",
            "create_summary",
          ],
        },
        config,
        target: { mode: "pr", pr: 7 },
        degradations: config.degradations,
      });
      assertEqual(
        platform.deliveryActions.join(","),
        "inlineComments,summaryComment",
        "the action whose tool is not served is dropped",
      );
      assert(
        config.degradations.some(
          (d: { what: string }) => d.what === "delivery.verdict",
        ),
        "and it is named, not silently skipped",
      );
      assertEqual(
        platform.registry.toolFor("comment.inline.create"),
        "create_inline",
        "the registry resolves against the live map",
      );
    });
  });

  await test("exposed extra-server tools ride to review; a lie is a named degradation", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("probe", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        [
          "servers:",
          "  forge:",
          "    transport: stdio",
          "    command: node",
          "    expose: [read_pr, nonexistent_tool]",
          "capabilities:",
          "  comment.list:",
          "    tool: forge.list_comments",
          "",
        ].join("\n"),
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const config = await mod.loadConfig(dir, { mode: "pr", pr: 7 });
      const platform = await mod.connectPlatform({
        engine: {
          connectMcp: async () => ["read_pr", "list_comments"],
        },
        config,
        target: { mode: "pr", pr: 7 },
        degradations: config.degradations,
      });
      assertEqual(
        platform.exposedTools.join(","),
        "forge.read_pr",
        "the advertised exposed tool rides, namespaced by its server",
      );
      assert(
        config.degradations.some(
          (d: { what: string; reason: string }) =>
            d.what === "mcp.forge.expose" &&
            d.reason.includes("nonexistent_tool"),
        ),
        "the tool the server does not advertise is a named degradation",
      );
    });
  });

  section("reading a platform result, whatever shape the forge chose");

  await test("MCP text envelopes, pagination wrappers and plain arrays all read", async () => {
    const mod = await import(DIST_ENTRY);
    const marked = "looks fine\n\n<!-- yama:finding:auth-token-logged -->";
    const cases: [string, unknown][] = [
      ["plain object", { id: 11, body: marked }],
      ["array", [{ comment_id: "11", content: marked }]],
      ["bitbucket values", { values: [{ id: 11, content: { raw: marked } }] }],
      [
        "mcp text envelope",
        {
          content: [
            { type: "text", text: JSON.stringify([{ id: 11, body: marked }]) },
          ],
        },
      ],
    ];
    for (const [label, value] of cases) {
      const comments = mod.readComments(value);
      assertEqual(comments.length, 1, `${label}: one comment read`);
      assertEqual(comments[0].id, "11", `${label}: the comment id`);
      assertEqual(
        mod.scanMarkers(comments[0].body).join(","),
        "auth-token-logged",
        `${label}: the marker survived`,
      );
    }
  });

  await test("a result with no id is not a comment we can bind a finding to", async () => {
    const mod = await import(DIST_ENTRY);
    assertEqual(
      mod.readComments({ body: "no id here" }).length,
      0,
      "an unnameable comment is dropped rather than guessed at",
    );
  });

  await test("GitHub's review-thread envelope: comments inside threads, ids from html_url", async () => {
    const mod = await import(DIST_ENTRY);
    // The live shape (captured from the hosted MCP): threads carry an id and NO body;
    // their comments carry a body and NO id — only an html_url whose anchor names them.
    // The HTML comment markers are STRIPPED from these bodies; the visible token is not.
    const envelope = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            review_threads: [
              {
                id: "PRRT_kwDOPQqz9c6ctXub",
                is_resolved: true,
                comments: [
                  {
                    body: "## CodeQL / something else entirely",
                    path: "src/tools/markers.ts",
                    html_url:
                      "https://github.com/juspay/yama/pull/90#discussion_r3869081884",
                  },
                ],
                total_count: 1,
              },
              {
                id: "PRRT_kwDOPQqz9c6ctXuc",
                is_resolved: false,
                comments: [
                  {
                    body: "**MINOR** — pinned by tag.\n\nEvidence: x.yml:90\n\n`yama:finding:F-CI-3`",
                    path: ".github/workflows/yama-review.yml",
                    html_url:
                      "https://github.com/juspay/yama/pull/90#discussion_r3870995539",
                  },
                ],
                total_count: 1,
              },
            ],
            totalCount: 2,
            pageInfo: { hasNextPage: false },
          }),
        },
      ],
    };
    const comments = mod.readComments(envelope);
    assertEqual(comments.length, 2, "every thread's comments are read");
    assertEqual(
      comments[1].id,
      "3870995539",
      "the id comes from the html_url anchor",
    );
    assertEqual(
      mod.scanMarkers(comments[1].body).join(","),
      "F-CI-3",
      "the visible token scans as a marker after the HTML one was stripped",
    );
    assertEqual(
      mod.scanMarkers(comments[0].body).length,
      0,
      "no false markers",
    );
  });

  section("run_check — the commands come from the base branch (TASKS:Y5.2)");

  const withChecks = async (
    dir: string,
    body: string,
    commit = true,
  ): Promise<void> => {
    await writeFile(path.join(dir, ".yama", "checks.yaml"), body, "utf8");
    if (commit) {
      await runCommand("git", ["add", "-A"], { cwd: dir });
      await runCommand("git", ["commit", "-q", "-m", "checks"], { cwd: dir });
    }
  };

  const CHECKS_YAML = [
    "checks:",
    "  - id: hello",
    '    command: ["node", "scripts/check.js"]',
    "  - id: lint",
    '    command: ["pnpm", "run", "lint"]',
    "",
  ].join("\n");

  await test("checks.yaml is read out of git at the base ref, not off disk", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("checks", async (dir) => {
      await gitWorkspace(dir);
      await withChecks(dir, CHECKS_YAML);
      const committed = await mod.readChecksAtRef({ root: dir, ref: "HEAD" });
      assertEqual(committed.checks.length, 2, "two checks on the base");

      // Now the working tree adds a third. The base ref does not know about it.
      await withChecks(
        dir,
        `${CHECKS_YAML}  - id: sneaky\n    command: ["curl"]\n`,
        false,
      );
      const again = await mod.readChecksAtRef({ root: dir, ref: "HEAD" });
      assertEqual(
        again.checks.length,
        2,
        "a check the change itself adds is not on the base branch",
      );
    });
  });

  await test("a base branch with no checks.yaml declares no checks", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("checks", async (dir) => {
      await gitWorkspace(dir);
      assertEqual(
        await mod.readChecksAtRef({ root: dir, ref: "HEAD" }),
        undefined,
        "absent is absent, not an error",
      );
    });
  });

  await test("a pre-v5 checks.yaml on the base is a named degradation, not a failure", async () => {
    // The state every repository migrating from v3/v4 is in on its FIRST v5 pull
    // request: the base branch still carries the old format. That run must degrade
    // to checks-off with the reason named — while a v5-shaped-but-invalid file
    // still fails loudly.
    const mod = await import(DIST_ENTRY);
    const LEGACY = [
      "enabled: true",
      "allowForks: false",
      "checks:",
      "  - id: lint",
      '    run: "pnpm run lint"',
      "    parse: eslint",
      "",
    ].join("\n");
    await withTempDir("checks", async (dir) => {
      await gitWorkspace(dir);
      await withChecks(dir, LEGACY);
      let legacyError: unknown;
      try {
        await mod.readChecksAtRef({ root: dir, ref: "HEAD" });
      } catch (error) {
        legacyError = error;
      }
      assertEqual(
        legacyError instanceof Error ? legacyError.name : "none",
        "LegacyChecksError",
        "the pre-v5 shape is recognised as legacy",
      );
    });
    await withTempDir("checks", async (dir) => {
      await gitWorkspace(dir);
      await withChecks(
        dir,
        'checks:\n  - id: broken\n    command: "not-an-array"\n',
      );
      let invalidError: unknown;
      try {
        await mod.readChecksAtRef({ root: dir, ref: "HEAD" });
      } catch (error) {
        invalidError = error;
      }
      assertEqual(
        invalidError instanceof Error &&
          invalidError.name !== "LegacyChecksError",
        true,
        "a v5-shaped but invalid file still fails loudly",
      );
    });
  });

  await test("a change that edits checks.yaml may run no check at all", async () => {
    const mod = await import(DIST_ENTRY);
    const guard = mod.guardChecks({
      checks: {
        version: 1,
        checks: [
          {
            id: "hello",
            command: ["node", "x.js"],
            timeoutMs: 1,
            optional: false,
          },
        ],
      },
      diff: diffOf([mod.CHECKS_PATH]),
    });
    assert(guard.allBlocked !== undefined, "every check is refused");
    assertIncludes(guard.allBlocked, mod.CHECKS_PATH, "and the file is named");
  });

  await test("a change that edits a declared script refuses that check by name", async () => {
    const mod = await import(DIST_ENTRY);
    const checks = {
      version: 1,
      checks: [
        {
          id: "hello",
          command: ["node", "scripts/check.js"],
          timeoutMs: 1,
          optional: false,
        },
        {
          id: "lint",
          command: ["pnpm", "run", "lint"],
          timeoutMs: 1,
          optional: false,
        },
      ],
    };
    const guard = mod.guardChecks({
      checks,
      diff: diffOf(["scripts/check.js"]),
    });
    assertEqual(guard.allBlocked, undefined, "the file itself is untouched");
    assertIncludes(
      guard.blocked.hello,
      "scripts/check.js",
      "the check whose script moved is refused, naming the file",
    );
    assertEqual(guard.blocked.lint, undefined, "the other check still runs");

    const manifest = mod.guardChecks({
      checks,
      diff: diffOf(["package.json"]),
    });
    assertIncludes(
      manifest.blocked.lint,
      "package.json",
      "a script runner's manifest is part of the check it runs",
    );
  });

  const checkTools = async (dir: string, guard: unknown, checks: unknown) => {
    const store = await import(DIST_ENTRY);
    const { createBankFallback } = await import(
      distModule("engine/fallback/bank.js")
    );
    const { createCommandFallback } = await import(
      distModule("engine/fallback/command.js")
    );
    const paths = store.storePathsForDir(path.join(dir, ".store"));
    await store.ensureStore(paths);
    const tools = registry();
    const bank = createBankFallback({ register: tools.register, paths });
    const commands = createCommandFallback({
      register: tools.register,
      paths,
      bank,
      policy: { allowedExecutables: ["node"], cwdRoot: dir },
      defaultCwd: dir,
    });
    store.registerCheckTools({
      register: tools.register,
      run: commands.start,
      checks,
      root: dir,
      guard,
    });
    return { tools, paths };
  };

  await test("run_check runs an allowlisted check and banks its output as evidence", async () => {
    await withTempDir("run-check", async (dir) => {
      await mkdir(path.join(dir, "scripts"), { recursive: true });
      await writeFile(
        path.join(dir, "scripts", "check.js"),
        'process.stdout.write("all good\\n");\n',
        "utf8",
      );
      const { tools } = await checkTools(
        dir,
        { blocked: {} },
        {
          version: 1,
          checks: [
            {
              id: "hello",
              command: ["node", "scripts/check.js"],
              timeoutMs: 30000,
              optional: false,
            },
          ],
        },
      );
      assert(tools.has("run_check"), "run_check is registered");
      assertIncludes(
        String(
          (tools.names(), await tools.call("run_check", { id: "nope" })).error,
        ),
        "hello",
        "an unknown id is refused, naming the ids that exist",
      );

      const result = await tools.call("run_check", { id: "hello" });
      assertEqual(result.checkId, "hello", "the check it ran");
      assertEqual(result.exitCode, 0, "and how it went");
      assertIncludes(
        String(result.stdout),
        "retrieve_context",
        "output is banked, not inlined",
      );
      assertIncludes(
        String(result.tailPreview),
        "all good",
        "with a bounded tail",
      );
    });
  });

  await test("run_check refuses a check the change itself modified", async () => {
    await withTempDir("run-check", async (dir) => {
      const { tools } = await checkTools(
        dir,
        {
          blocked: {
            hello:
              'check "hello" is refused: this change modifies "scripts/check.js"',
          },
        },
        {
          version: 1,
          checks: [
            {
              id: "hello",
              command: ["node", "scripts/check.js"],
              timeoutMs: 1000,
              optional: false,
            },
          ],
        },
      );
      const refusal = await tools.call("run_check", { id: "hello" });
      assertEqual(refusal.isError, true, "it is a refusal");
      assertIncludes(
        String(refusal.error),
        "scripts/check.js",
        "naming the file that moved",
      );
    });
  });

  section("Delivery — config decides, the agent executes, the code confirms");

  const RANKED = {
    findings: [
      finding("auth-token-logged", "CRITICAL"),
      finding("weak-hash", "MAJOR"),
      finding("naming-nit", "INFO"),
    ],
  };
  const VERDICT = {
    decision: "block",
    reasons: ["1 CRITICAL: auth-token-logged"],
  };

  const deliveryConfig = async (dir: string) => {
    const mod = await import(DIST_ENTRY);
    await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
    await writeFile(path.join(dir, ".yama", "mcp.yaml"), DELIVERY_MCP, "utf8");
    process.env.YAMA_TEST_REPO = "acme/widgets";
    return mod.loadConfig(dir, { mode: "pr", pr: 7 });
  };

  const deliveryRegistry = async () => {
    const mod = await import(DIST_ENTRY);
    return mod.createCapabilityRegistry({
      "comment.list": binding("comment.list", "forge", "list_comments", {
        pull: "7",
      }),
      "comment.inline.create": binding(
        "comment.inline.create",
        "forge",
        "create_inline",
        { pull: "7" },
      ),
      "comment.summary.create": binding(
        "comment.summary.create",
        "forge",
        "create_summary",
      ),
      "verdict.set": binding("verdict.set", "forge", "set_state"),
    });
  };

  await test("every comment body carries the marker that stops it being posted twice", async () => {
    const mod = await import(DIST_ENTRY);
    const body = mod.renderFindingComment(
      finding("auth-token-logged", "CRITICAL"),
    );
    assertIncludes(body, "CRITICAL", "the severity leads");
    assertIncludes(body, "src/auth.ts:42", "the evidence is cited");
    assertEqual(
      mod.scanMarkers(body).join(","),
      "auth-token-logged",
      "and the finding's marker is on it",
    );
    assertEqual(
      mod.renderFindingComment(finding("auth-token-logged", "CRITICAL")),
      body,
      "rendering is stable, so a re-review posts the same body",
    );
  });

  await test("the plan applies the severity floor, the cap, and the markers already there", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const plan = mod.buildDeliveryPlan({
        config,
        actions: ["inlineComments", "summaryComment"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        comments: [
          { id: "c9", body: "said before <!-- yama:finding:weak-hash -->" },
          { id: "c8", body: "gone now <!-- yama:finding:old-thing -->" },
        ],
        checklistComplete: true,
      });
      assertEqual(
        plan.comments.map((c: { findingId: string }) => c.findingId).join(","),
        "auth-token-logged",
        "INFO is under the floor and weak-hash is already posted",
      );
      assertEqual(
        plan.alreadyPosted[0]?.commentId,
        "c9",
        "the finding already there is bound to the comment holding it",
      );
      assertEqual(
        plan.stale.join(","),
        "old-thing",
        "a marker this run did not find again is reported for Y7.1",
      );
      assert(
        plan.withheld.includes("naming-nit"),
        "and what was held back is named",
      );
      assertIncludes(
        String(plan.summary),
        "yama:run:run-1",
        "the summary carries the run marker",
      );
      assertIncludes(String(plan.summary), "BLOCK", "and the verdict");
    });
  });

  await test("the inline cap is a per-run bound, and the rest go in the summary", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const many = {
        findings: [
          finding("a", "CRITICAL"),
          finding("b", "CRITICAL"),
          finding("c", "MAJOR"),
        ],
      };
      const plan = mod.buildDeliveryPlan({
        config,
        actions: ["inlineComments", "summaryComment"],
        runId: "run-1",
        ranked: many,
        verdict: VERDICT,
        summary: "three problems",
        comments: [],
        checklistComplete: true,
      });
      assertEqual(plan.comments.length, 2, "maxInlineComments is honoured");
      assertEqual(
        plan.withheld.join(","),
        "c",
        "the rest are named as withheld",
      );
      assertIncludes(String(plan.summary), "c", "and appear in the summary");
    });
  });

  await test("the prompt names the resolved tool and its arguments, never a forge", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      const plan = mod.buildDeliveryPlan({
        config,
        actions: ["inlineComments", "summaryComment", "verdict"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        comments: [],
        checklistComplete: false,
      });
      const prompt = mod.buildDeliveryPrompt({ plan, registry: reg });
      assertIncludes(prompt, "create_inline", "the inline tool the map named");
      assertIncludes(
        prompt,
        '"pull":"7"',
        "with the coordinates every call needs",
      );
      assertIncludes(prompt, "create_summary", "the summary tool");
      assertIncludes(prompt, "set_state", "the verdict tool");
      assertIncludes(
        prompt,
        "VERBATIM",
        "the bodies are not the agent's to edit",
      );
      assert(
        !prompt.toLowerCase().includes("github") &&
          !prompt.toLowerCase().includes("bitbucket"),
        "no platform is named anywhere in the instruction",
      );
      assertIncludes(
        String(plan.summary),
        "review is incomplete",
        "an unfinished checklist is said out loud on the pull request",
      );
    });
  });

  /** A session that answers Delivery with a fixed report and a fixed set of tool results. */
  const deliverySession = (options: {
    report: unknown;
    toolResults: { name: string; result: unknown; isError?: boolean }[];
  }) => {
    const seen: { prompt: string; tools?: string[] }[] = [];
    return {
      seen,
      session: {
        sessionId: "run-1",
        checkpoint: async (req: { prompt: string; tools?: string[] }) => {
          seen.push({
            prompt: req.prompt,
            ...(req.tools ? { tools: req.tools } : {}),
          });
          return {
            stage: "delivery",
            data: options.report,
            trusted: true,
            completedAt: new Date().toISOString(),
          };
        },
        metrics: () => [],
        toolResults: () =>
          options.toolResults.map((entry) => ({
            name: entry.name,
            params: {},
            result: entry.result,
            isError: entry.isError === true,
            truncated: false,
          })),
      },
    };
  };

  const CLAIMED_ALL = {
    posted: ["auth-token-logged"],
    failed: [],
    summaryPosted: true,
    verdictSet: true,
    described: false,
    notes: "done",
  };

  await test("a comment id carrying the marker is what makes a finding posted", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      const inline = mod.renderFindingComment(
        finding("auth-token-logged", "CRITICAL"),
      );
      const second = mod.renderFindingComment(finding("weak-hash", "MAJOR"));
      const driver = deliverySession({
        report: CLAIMED_ALL,
        toolResults: [
          { name: "create_inline", result: { id: 101, body: inline } },
          { name: "create_inline", result: { id: 103, body: second } },
          {
            name: "create_summary",
            result: { id: 102, body: "summary <!-- yama:run:run-1 -->" },
          },
          { name: "set_state", result: { state: "CHANGES_REQUESTED" } },
        ],
      });
      const result = await mod.runDelivery({
        session: driver.session,
        engine: { callTool: async () => [] },
        config,
        registry: reg,
        actions: ["inlineComments", "summaryComment", "verdict"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        checklistComplete: true,
        dryRun: false,
      });
      assertEqual(
        result.confirmation.posted.length,
        2,
        "both planned comments are confirmed",
      );
      assertEqual(
        result.confirmation.posted[0].commentId,
        "101",
        "bound to the id the platform returned",
      );
      assertEqual(result.summaryPosted, true, "the summary landed");
      assertEqual(result.verdictSet, true, "the review state was set");
      assertEqual(result.failure, undefined, "nothing to report loudly");

      const stats = mod.deliveryStats(result);
      assertEqual(stats.posted, 2, "the run report carries what landed");
      assertEqual(stats.intended, 2, "against what was intended");
    });
  });

  await test("an agent that says it posted, with no comment id, has proved nothing", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      const driver = deliverySession({
        report: CLAIMED_ALL,
        toolResults: [
          // The marker is echoed back, but nothing names a comment.
          {
            name: "create_inline",
            result: {
              ok: true,
              body: "<!-- yama:finding:auth-token-logged -->",
            },
          },
        ],
      });
      const result = await mod.runDelivery({
        session: driver.session,
        engine: { callTool: async () => [] },
        config,
        registry: reg,
        actions: ["inlineComments", "summaryComment", "verdict"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        checklistComplete: true,
        dryRun: false,
      });
      assertEqual(result.confirmation.posted.length, 0, "nothing is confirmed");
      assertIncludes(
        String(result.failure),
        "auth-token-logged",
        "the unposted finding is named out loud",
      );
      assertIncludes(
        String(result.failure),
        "summary comment",
        "so is the summary",
      );
      assertIncludes(String(result.failure), "review state", "and the verdict");
      assertEqual(
        mod.deliveryStats(result).posted,
        0,
        "and the run report agrees",
      );
    });
  });

  await test("Delivery reads the target itself, and posts only what is new", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      const calls: { name: string; params: unknown }[] = [];
      const driver = deliverySession({ report: CLAIMED_ALL, toolResults: [] });
      await mod.runDelivery({
        session: driver.session,
        engine: {
          callTool: async (name: string, params: unknown) => {
            calls.push({ name, params });
            // Bitbucket's shape, to prove the reader is not GitHub-specific.
            return {
              values: [
                {
                  id: "c9",
                  content: {
                    raw: "already said <!-- yama:finding:auth-token-logged -->",
                  },
                },
                {
                  id: "c8",
                  content: { raw: "and this <!-- yama:finding:weak-hash -->" },
                },
              ],
            };
          },
        },
        config,
        registry: reg,
        actions: ["inlineComments"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        checklistComplete: true,
        dryRun: false,
      });
      assertEqual(
        calls[0]?.name,
        "list_comments",
        "the shell reads the comments itself",
      );
      assertEqual(
        JSON.stringify(calls[0]?.params),
        JSON.stringify({ pull: "7" }),
        "with the coordinates config gave it",
      );
      assertIncludes(
        driver.seen[0].prompt,
        "no new inline comments",
        "every finding above the floor was already posted by an earlier run",
      );
      assertIncludes(
        driver.seen[0].prompt,
        "must NOT be posted again",
        "and the agent is told which comments already hold them",
      );
    });
  });

  await test("Delivery is handed posting tools and nothing that could review again", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      const driver = deliverySession({ report: CLAIMED_ALL, toolResults: [] });
      await mod.runDelivery({
        session: driver.session,
        engine: { callTool: async () => [] },
        config,
        registry: reg,
        actions: ["inlineComments"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        checklistComplete: true,
        dryRun: false,
      });
      const tools = driver.seen[0].tools ?? [];
      assert(tools.includes("create_inline"), "it can post");
      assert(tools.includes("read_file"), "and read the repository");
      assert(!tools.includes("delegate_task"), "it cannot spawn a worker");
      assert(
        !tools.includes("tasks_create"),
        "and it cannot rewrite the checklist",
      );
      assert(
        !tools.includes("set_state"),
        "an action it is not doing brings no tool",
      );
    });
  });

  await test("a dry run delivers nothing and says which flag stopped it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("delivery", async (dir) => {
      const config = await deliveryConfig(dir);
      const reg = await deliveryRegistry();
      let asked = false;
      const result = await mod.runDelivery({
        session: {
          sessionId: "run-1",
          checkpoint: async () => {
            asked = true;
            return {};
          },
          metrics: () => [],
          toolResults: () => [],
        },
        engine: {
          callTool: async () => {
            asked = true;
            return [];
          },
        },
        config,
        registry: reg,
        actions: ["inlineComments"],
        runId: "run-1",
        ranked: RANKED,
        verdict: VERDICT,
        summary: "one real problem",
        checklistComplete: true,
        dryRun: true,
      });
      assertEqual(
        asked,
        false,
        "a dry run touches neither the model nor the platform",
      );
      assertIncludes(String(result.skipped), "dry-run", "and says why");
    });
  });

  section("yama init — a correct .yama/, and never a file you wrote yourself");

  await test("it scaffolds a config that actually loads, for each platform", async () => {
    const mod = await import(DIST_ENTRY);
    for (const platform of ["github", "bitbucket"] as const) {
      await withTempDir(`init-${platform}`, async (dir) => {
        const result = await mod.scaffold({ root: dir, platform });
        assert(
          result.written.length >= 7,
          `${platform}: the scaffold is written`,
        );
        for (const env of [
          "GITHUB_TOKEN",
          "GITHUB_OWNER",
          "GITHUB_REPO",
          "BITBUCKET_USERNAME",
          "BITBUCKET_APP_PASSWORD",
          "BITBUCKET_WORKSPACE",
          "BITBUCKET_REPO",
        ]) {
          process.env[env] = `test-${env.toLowerCase()}`;
        }
        const config = await mod.loadConfig(dir, { mode: "pr", pr: 5 });
        assertEqual(
          config.capabilities["comment.list"] === undefined,
          false,
          `${platform}: the scaffolded map binds comment.list`,
        );
        // Whatever the server calls it — the point is that ${pr} became the number, and
        // that the ARG NAME is the platform's vocabulary rather than Yama's.
        const identifier = Object.values(
          config.capabilities["pr.read"].args as Record<string, string>,
        );
        assertEqual(
          identifier.includes("5"),
          true,
          `${platform}: the run placeholder resolves`,
        );
        const ignore = await readFile(path.join(dir, ".gitignore"), "utf8");
        assertIncludes(
          ignore,
          ".yama/artifacts",
          "the run store is never committed",
        );
      });
    }
  });

  await test("a second init keeps what is already there, and --force replaces it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("init", async (dir) => {
      await mod.scaffold({ root: dir, platform: "github" });
      const yamaFile = path.join(dir, ".yama", "yama.yaml");
      await writeFile(yamaFile, "# mine\n", "utf8");

      const second = await mod.scaffold({ root: dir, platform: "github" });
      assert(
        second.skipped.includes(yamaFile),
        "an existing file is left alone",
      );
      assertEqual(await readFile(yamaFile, "utf8"), "# mine\n", "untouched");

      const forced = await mod.scaffold({
        root: dir,
        platform: "github",
        force: true,
      });
      assert(forced.written.includes(yamaFile), "--force replaces it");
      assertIncludes(
        await readFile(yamaFile, "utf8"),
        "models:",
        "with the template",
      );
    });
  });

  await test("the CI recipes ship, and carry the run store between runs", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("init", async (dir) => {
      await mod.scaffold({ root: dir, platform: "github" });
      // PARSED, not grepped. Both properties this recipe exists for are also DESCRIBED in
      // its header comment, so a substring search passes over a workflow that has neither.
      const actions = load(
        await readFile(
          path.join(dir, ".yama", "ci", "github-actions.yml"),
          "utf8",
        ),
      ) as WorkflowFile;
      const steps = actions.jobs.review.steps;

      const checkout = steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/checkout"),
      );
      assertEqual(
        checkout?.with?.["fetch-depth"],
        0,
        "the clone is deep enough for the base ref to be in it",
      );

      const upload = steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/upload-artifact"),
      );
      assertEqual(
        upload?.if,
        "always()",
        "the run store is kept even when the review failed — that run banked evidence too",
      );
      assertIncludes(
        String(upload?.with?.path),
        ".yama/artifacts",
        "and the store is what it keeps",
      );

      const download = steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/download-artifact"),
      );
      assertEqual(
        download?.["continue-on-error"],
        true,
        "the first review of a pull request has no store to restore, and that is not a failure",
      );
      assertIncludes(
        String(steps.find((step) => step.run !== undefined)?.run),
        "--base",
        "the diff range is named explicitly",
      );

      // Groovy is not YAML, so the Jenkinsfile is checked by structure in the text: the
      // archive has to sit in `post { always`, or a failed build takes its evidence with it.
      const jenkins = await readFile(
        path.join(dir, ".yama", "ci", "Jenkinsfile"),
        "utf8",
      );
      assert(
        /post\s*\{\s*always\s*\{[^}]*archiveArtifacts/.test(jenkins),
        "the store is archived whatever the outcome of the build",
      );
      assertIncludes(
        jenkins,
        "allowEmptyArchive: true",
        "and an absent store does not fail the build on top of the review",
      );
      assertIncludes(
        jenkins,
        "copyArtifacts",
        "the previous store is restored",
      );
      assertIncludes(
        jenkins,
        "git fetch",
        "and the base ref is fetched, because the diff comes from git",
      );
    });
  });

  await test("yama init scaffolds through the built CLI", async () => {
    await withTempDir("init-cli", async (dir) => {
      const r = await runCLI(["init", "--platform", "bitbucket"], { cwd: dir });
      assertExit(r, 0, "yama init");
      assertIncludes(r.stdout, "written", "it says what it wrote");
      assertIncludes(r.stdout, "yama doctor", "and what to do next");
      const mcp = await readFile(path.join(dir, ".yama", "mcp.yaml"), "utf8");
      assertIncludes(mcp, "bitbucket", "the platform asked for");
    });
  });

  section("yama doctor — every problem at once, each with its fix");

  await test("a workspace with no .yama/ is broken, and says how to fix it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("doctor", async (dir) => {
      const report = await mod.runDoctor({
        root: dir,
        target: { mode: "local" },
      });
      assertEqual(report.ok, false, "the workspace is not usable");
      assertEqual(
        report.checks[0].status,
        "broken",
        "and the config check says so",
      );
      assertIncludes(String(report.checks[0].fix), "yama init", "with the fix");
    });
  });

  await test("a scaffolded workspace probes clean once its variables are set", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("doctor", async (dir) => {
      await gitWorkspace(dir);
      const report = await mod.runDoctor({
        root: dir,
        target: { mode: "local" },
        engine: { connectMcp: async () => [] },
      });
      assertEqual(report.ok, true, "nothing is broken");
      const groups = [
        ...new Set(report.checks.map((c: { group: string }) => c.group)),
      ];
      for (const group of [
        "config",
        "models",
        "git",
        "mcp",
        "capabilities",
        "checks",
      ]) {
        assert(groups.includes(group), `the report covers ${group}`);
      }
      const rendered = mod.renderDoctorReport(report);
      assertIncludes(rendered, "capabilities", "the table is printed");
      assertIncludes(
        rendered,
        "everything this workspace declares is reachable",
        "and summarised",
      );
    });
  });

  await test("a capability pointing at a tool nobody serves is BROKEN, with the fix", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("doctor", async (dir) => {
      await gitWorkspace(dir, { yamaYaml: DELIVERY_YAMA });
      await writeFile(
        path.join(dir, ".yama", "mcp.yaml"),
        DELIVERY_MCP,
        "utf8",
      );
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const report = await mod.runDoctor({
        root: dir,
        target: { mode: "pr", pr: 7 },
        // The forge is up and serves something else entirely.
        engine: { connectMcp: async () => ["totally_different_tool"] },
      });
      assertEqual(report.ok, false, "the workspace would fail a real run");
      const row = report.checks.find(
        (c: { group: string; name: string }) =>
          c.group === "capabilities" && c.name === "pr.read",
      );
      assertEqual(row.status, "broken", "the capability is broken");
      assertIncludes(
        row.detail,
        "totally_different_tool",
        "and the report lists what IS served",
      );
      assertIncludes(String(row.fix), "mcp.yaml", "with where to fix it");
      assertIncludes(
        mod.renderDoctorReport(report),
        "BROKEN",
        "and it is loud in the printed report",
      );
    });
  });

  await test("the degradation matrix is printed, not merely computed", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("doctor", async (dir) => {
      await gitWorkspace(dir);
      const report = await mod.runDoctor({
        root: dir,
        target: { mode: "local" },
        engine: { connectMcp: async () => [] },
      });
      assertEqual(report.ok, true, "nothing here is BROKEN…");
      assert(
        report.degradations.length > 0,
        "…and yet things are switched off",
      );

      const named = report.degradations.map((d: { what: string }) => d.what);
      assertEqual(
        named.length,
        new Set(named).size,
        "config and the probe both name a capability; the matrix names it once",
      );

      const rendered = mod.renderDoctorReport(report);
      assertIncludes(
        rendered,
        "switched off",
        "the matrix has its own heading",
      );
      for (const what of ["memory", "checks"]) {
        assertIncludes(
          rendered,
          what,
          `an absent optional piece is printed, not just returned`,
        );
      }
      // The same list a run report prints, so the two can be read as one thing.
      for (const degradation of report.degradations) {
        assertIncludes(
          rendered,
          degradation.reason,
          "every reason reaches the operator",
        );
      }
    });
  });

  await test("doctor exits 2 when something is broken, 0 when nothing is", async () => {
    await withTempDir("doctor-cli", async (dir) => {
      const broken = await runCLI(["doctor"], { cwd: dir });
      assertExit(broken, 2, "yama doctor with no .yama/");
      assertIncludes(broken.stdout, "BROKEN", "and says so");

      await gitWorkspace(dir);
      const clean = await runCLI(["doctor"], { cwd: dir });
      assertExit(
        clean,
        0,
        "yama doctor on a workspace with no servers to connect",
      );
    });
  });

  await test("doctor against the fixture repo connects its real MCP server", async () => {
    const mod = await import(DIST_ENTRY);
    if (process.env.YAMA_TEST_MCP !== "1") {
      throw new Skip("set YAMA_TEST_MCP=1 to connect the fixture's MCP server");
    }
    const report = await mod.runDoctor({
      root: path.join(FIXTURES, "mini-repo"),
      target: { mode: "local" },
    });
    assert(
      report.checks.some((c: { group: string }) => c.group === "mcp"),
      "the server was probed",
    );
  });

  section("branch and pull-request diffs come from git, not from the platform");

  await test("a branch is diffed against where it left its base", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("range", async (dir) => {
      await gitWorkspace(dir);
      const git = (args: string[]) => runCommand("git", args, { cwd: dir });
      await git(["checkout", "-q", "--", "."]);
      await git(["checkout", "-q", "-b", "feature"]);
      await writeFile(
        path.join(dir, "feature.ts"),
        "export const b = 1;\n",
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "feature work"]);
      await git(["checkout", "-q", "main"]);
      await writeFile(
        path.join(dir, "unrelated.ts"),
        "export const c = 1;\n",
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "meanwhile on main"]);

      const diff = await mod.acquireTargetDiff({
        runId: "run-1",
        target: { mode: "branch", branch: "feature", base: "main" },
        root: dir,
        storeDir: dir,
        dryRun: true,
      });
      assertEqual(
        diff.files.map((f: { path: string }) => f.path).join(","),
        "feature.ts",
        "only what the branch added — not what main did meanwhile",
      );
    });
  });

  await test("a base that cannot be resolved says to pass --base", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("range", async (dir) => {
      await gitWorkspace(dir);
      await runCommand("git", ["branch", "-m", "main", "trunk"], { cwd: dir });
      let message = "";
      try {
        await mod.acquireTargetDiff({
          runId: "run-1",
          target: { mode: "pr", pr: 4 },
          root: dir,
          storeDir: dir,
          dryRun: true,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "--base", "the fix is named");
    });
  });

  await test("a base ref that does not resolve names the fetch depth", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("range", async (dir) => {
      await gitWorkspace(dir);
      let message = "";
      try {
        await mod.acquireTargetDiff({
          runId: "run-1",
          target: { mode: "pr", pr: 4, base: "origin/nope" },
          root: dir,
          storeDir: dir,
          dryRun: true,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assertIncludes(message, "fetch-depth", "CI's usual cause is named");
    });
  });

  section(
    "the wiring: every stage is handed its own phase's tools (TASKS:Y5.1)",
  );

  /**
   * A scripted model that drives a whole `runReview`, recording the toolset each stage was
   * given and every tool the run registered.
   *
   * That the REGISTRY filters by phase is pinned above. What is pinned here is that
   * `runReview` asks it for the right list at the right moment: a shell that handed the
   * review stages the delivery toolset would let the work stage comment on the pull
   * request, and every assertion above would still hold.
   */
  const reviewEngine = (serverTools: readonly string[]) => {
    const byStage = new Map<string, string[]>();
    const registered: string[] = [];
    const stageOf = (prompt: string): string =>
      prompt.includes("WARM UP.")
        ? "warmup"
        : prompt.includes("TASK INSERTION.")
          ? "taskInsertion"
          : prompt.includes("COLLATE AND DECIDE")
            ? "collate"
            : prompt.includes("DELIVERY.")
              ? "delivery"
              : "work";
    const answers: Record<string, unknown> = {
      warmup: {
        persona: "sceptical about auth",
        rules: [],
        focusAreas: ["security"],
        sources: [".yama/rulebook/index.md"],
        gaps: [],
      },
      taskInsertion: {
        changeSummary: "adds a token endpoint",
        riskAreas: ["auth"],
        tasks: [
          {
            title: "check the token endpoint",
            rationale: "the diff adds one",
            scope: ["feature.ts"],
            delegate: false,
          },
        ],
        checklistIds: ["t1"],
      },
      work: {
        findings: [
          finding("auth-token-logged", "CRITICAL", { confidence: 0.9 }),
        ],
        worked: [
          {
            taskId: "t1",
            handledBy: "self",
            note: "read it",
            findingIds: ["auth-token-logged"],
          },
        ],
        openQuestions: [],
      },
      collate: {
        findings: [
          finding("auth-token-logged", "CRITICAL", { confidence: 0.9 }),
        ],
        merged: [],
        summary: "the token path logs a secret",
      },
      delivery: {
        posted: ["auth-token-logged"],
        failed: [],
        summaryPosted: true,
        verdictSet: true,
        described: false,
        notes: "done",
      },
    };

    const engine = {
      generateStructured: async (req: {
        prompt: string;
        tools?: string[];
        schema: {
          safeParse: (value: unknown) => { success: boolean; data?: unknown };
        };
      }) => {
        const stage = stageOf(req.prompt);
        byStage.set(stage, [...(req.tools ?? [])]);
        const answer = answers[stage];
        const parsed = req.schema.safeParse(answer);
        return {
          data: parsed.success ? parsed.data : undefined,
          trusted: parsed.success,
          raw: {
            content: JSON.stringify(answer ?? null),
            structured: answer ?? null,
            repaired: false,
            truncated: false,
            provider: "test-provider",
            model: "test-model",
            stepsUsed: 1,
            toolsUsed: [],
          },
        };
      },
      registerTool: (name: string) => {
        registered.push(name);
      },
      connectMcp: async () => [...serverTools],
      callTool: async () => [],
      tasksApi: async (sessionId: string) => ({
        sessionId,
        tasks: [
          { id: "t1", title: "check the token endpoint", status: "done" },
        ],
      }),
      delegate: async () => ({ workerId: "w-unrequested" }),
      collect: async () => [],
      bankReport: async (req: { label: string; payload: string }) => ({
        id: `banked-${req.label}`,
        label: req.label,
        sizeBytes: req.payload.length,
        preview: req.payload.slice(0, 40),
        readBackHint: `retrieve_context({ artifactId: "banked-${req.label}" })`,
      }),
      backgroundRun: async () => {
        throw new Error("this case runs no commands");
      },
    };
    return { byStage, registered, engine };
  };

  /**
   * `main` with one commit, then a `feature` branch on top of it. `base` files are
   * committed before the branch exists, so they are the change's BASE, not part of it.
   */
  const twoBranchWorkspace = async (
    dir: string,
    options: {
      yamaYaml?: string;
      base?: Record<string, string>;
      head?: Record<string, string>;
    } = {},
  ): Promise<void> => {
    await gitWorkspace(
      dir,
      options.yamaYaml !== undefined ? { yamaYaml: options.yamaYaml } : {},
    );
    const git = (args: string[]) => runCommand("git", args, { cwd: dir });
    await git(["checkout", "-q", "--", "."]);
    const put = async (files: Record<string, string>): Promise<void> => {
      for (const [file, body] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
        await writeFile(path.join(dir, file), body, "utf8");
      }
    };
    if (options.base !== undefined) {
      await put(options.base);
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", "the state being reviewed against"]);
    }
    await git(["checkout", "-q", "-b", "feature"]);
    await put({
      "feature.ts": "export const b = 1;\n",
      ...(options.head ?? {}),
    });
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "feature work"]);
  };

  await test("a review hands the posting tools to Delivery and to no stage before it", async () => {
    const mod = await import(DIST_ENTRY);
    await withTempDir("exposure", async (dir) => {
      await twoBranchWorkspace(dir, {
        yamaYaml: DELIVERY_YAMA,
        base: { ".yama/mcp.yaml": DELIVERY_MCP },
      });
      process.env.YAMA_TEST_REPO = "acme/widgets";
      const scripted = reviewEngine([
        "read_pr",
        "read_diff",
        "list_comments",
        "create_inline",
        "create_summary",
        "set_state",
      ]);

      await mod.runReview(
        {
          runId: "run-1",
          target: { mode: "pr", pr: 7, base: "main" },
          root: dir,
          storeDir: path.join(dir, ".yama", "artifacts", "pr-7"),
          dryRun: false,
        },
        scripted.engine,
      );

      for (const stage of ["warmup", "taskInsertion", "work", "collate"]) {
        const tools = scripted.byStage.get(stage) ?? [];
        assert(
          tools.includes("list_comments"),
          `${stage} is given the review-phase capabilities`,
        );
        for (const tool of ["create_inline", "create_summary", "set_state"]) {
          assert(
            !tools.includes(tool),
            `${stage} must hold nothing that can write to the pull request`,
          );
        }
      }
      const delivery = scripted.byStage.get("delivery") ?? [];
      assert(
        delivery.includes("create_inline"),
        "Delivery is given the posting tool for the action it performs",
      );
      assert(
        delivery.includes("list_comments"),
        "and the read it is paired with, so it can dedupe",
      );
    });
  });

  await test("a check the change itself adds is never registered (TASKS:Y5.2)", async () => {
    const mod = await import(DIST_ENTRY);
    const CHECKS = [
      "version: 1",
      "checks:",
      "  - id: base-lint",
      '    command: ["node", "-e", "0"]',
      "",
    ].join("\n");
    const branchRun = async (dir: string, scripted: { engine: unknown }) =>
      mod.runReview(
        {
          runId: "run-1",
          target: { mode: "branch", branch: "feature", base: "main" },
          root: dir,
          storeDir: path.join(dir, ".yama", "artifacts", "branch"),
          dryRun: true,
        },
        scripted.engine,
      );

    // Declared on the base: the repository's own check, and the review may run it.
    await withTempDir("base-checks", async (dir) => {
      await twoBranchWorkspace(dir, { base: { ".yama/checks.yaml": CHECKS } });
      const scripted = reviewEngine([]);
      await branchRun(dir, scripted);
      assert(
        scripted.registered.includes("run_check"),
        "a check declared on the base branch is one this review may run",
      );
      assert(
        (scripted.byStage.get("work") ?? []).includes("run_check"),
        "and the work stage is the stage given it",
      );
    });

    // Introduced BY the change: the base has none, so the review runs none.
    await withTempDir("head-checks", async (dir) => {
      await twoBranchWorkspace(dir, { head: { ".yama/checks.yaml": CHECKS } });
      const scripted = reviewEngine([]);
      const result = await branchRun(dir, scripted);
      assert(
        !scripted.registered.includes("run_check"),
        "a change does not get to introduce the command that reviews it",
      );
      const degradation = result.report.degradations.find(
        (entry: { what: string }) => entry.what === "checks",
      );
      assert(
        degradation !== undefined,
        "and the run report says the checks are switched off",
      );
      assertIncludes(
        String(degradation.reason),
        "main",
        "naming the ref they were looked for on",
      );
    });
  });

  section("through a real MCP server, not a scripted tool result (TASKS:Y8.1)");

  /**
   * Everything above drives the platform layer with tool results the test wrote. What is
   * left unproved by that is the connection itself: an actual child process, an actual
   * stdio transport, an actual `tools/list`. `fixtures/fake-mcp-server.mjs` is that server
   * — dependency-free, serving the synthetic pull request — and it is the fixture the
   * ledger has been carrying as owed.
   */
  const fakeForgeWorkspace = async (
    dir: string,
    exposes: string,
  ): Promise<void> => {
    await gitWorkspace(dir);
    await writeFile(
      path.join(dir, ".yama", "mcp.yaml"),
      [
        "servers:",
        "  forge:",
        "    transport: stdio",
        "    command: node",
        `    args: ["${path.join(FIXTURES, "fake-mcp-server.mjs")}", "--tools", "${exposes}"]`,
        "capabilities:",
        "  comment.list:",
        "    tool: forge.list_comments",
        "    args:",
        '      pull: "${pr}"',
        "  pr.read:",
        "    tool: forge.read_pr",
        "    args:",
        '      pull: "${pr}"',
        "",
      ].join("\n"),
      "utf8",
    );
  };

  await test("the probe compares the map against what the server really advertised", async () => {
    // The server exposes ONE of the two tools the map names.
    await withTempDir("real-mcp-broken", async (dir) => {
      await fakeForgeWorkspace(dir, "list_comments");
      const result = await runCLI(["doctor", "--pr", "7"], { cwd: dir });
      assertExit(
        result,
        2,
        "doctor over a capability that is not really there",
      );
      assertIncludes(
        result.stdout,
        "connected, 1 tool(s): list_comments",
        "the server was really connected and really asked what it has",
      );
      assertIncludes(
        result.stdout,
        "BROKEN  pr.read",
        "the capability the server cannot provide is called broken",
      );
      assertIncludes(
        result.stdout,
        "it exposes: list_comments",
        "and the report names what it does have instead",
      );
    });

    // The mirror: the same map over a server that has both, so the failure above cannot
    // be the map, the target or the fixture.
    await withTempDir("real-mcp-ok", async (dir) => {
      await fakeForgeWorkspace(dir, "list_comments,read_pr");
      const result = await runCLI(["doctor", "--pr", "7"], { cwd: dir });
      assertExit(result, 0, "doctor over a map the server can satisfy");
      assertIncludes(
        result.stdout,
        "ok    pr.read — forge.read_pr",
        "the same capability is fine once the tool is there",
      );
    });
  });

  // Keep the scratch fixture directory out of the mini-repo.
  await rm(path.join(FIXTURES, "mini-repo", ".yama", "artifacts"), {
    recursive: true,
    force: true,
  });
}
