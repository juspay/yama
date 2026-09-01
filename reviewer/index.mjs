#!/usr/bin/env node
/**
 * Yama — a config-driven agent built on NeuroLink.
 *
 * Everything is read from the CURRENT WORKING DIRECTORY (the project):
 *   config.json  — provider/model (string or 1:1 fallback arrays), timeouts,
 *                  compaction, memory, skills, delegation
 *   MCP.json     — external MCP servers (stdio / http / sse / websocket)
 *   prompts.json — ordered prompts for batch mode
 *   skills/      — filesystem skill store (one directory per skill, SKILL.md)
 *   memory/      — persisted long-term memory (Hippocampus, SQLite)
 *
 * Modes:
 *   yama init                 scaffold the structure into this directory
 *   yama run key=value ...    run prompts.json top to bottom, one session
 *   yama                      interactive REPL
 *
 * Each start is a NEW session; long-term memory persists across sessions via
 * Hippocampus, keyed by config.userId.
 */

import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import "dotenv/config";

const CWD = process.cwd();
const argv = process.argv.slice(2);
const command = argv[0];

// ---------------------------------------------------------------------------
// init — no config needed, scaffold and exit
// ---------------------------------------------------------------------------

if (command === "init") {
  const { runInit } = await import("./init.mjs");
  runInit(argv[1] ? path.resolve(CWD, argv[1]) : CWD);
  process.exit(0);
}

// key=value parameters for `run` and `learn` (e.g. pr=123 branch=main).
const params = {};
for (const arg of argv.slice(1)) {
  const eq = arg.indexOf("=");
  if (eq > 0) {
    params[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
}
if (command === "learn" && !/^\d+$/.test(params.pr ?? "")) {
  console.error("✗ usage: yama learn pr=<number> [key=value ...]");
  process.exit(1);
}

const { NeuroLink } = await import("@juspay/neurolink");

// ---------------------------------------------------------------------------
// Config loading (from the project directory)
// ---------------------------------------------------------------------------

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(CWD, file), "utf8"));
  } catch (error) {
    if (fallback !== undefined) {
      return fallback;
    }
    console.error(
      `✗ Cannot read ${file} in ${CWD}: ${error.message}\n  Run \`yama init\` to scaffold the structure.`,
    );
    process.exit(1);
  }
}

const config = await loadJson("config.json");
const mcpFile = await loadJson("MCP.json", { servers: {} });

if (
  command === "learn" &&
  !(typeof config.learnPrompt === "string" && config.learnPrompt.trim())
) {
  console.error(
    '✗ config.json has no "learnPrompt" — add one before running yama learn',
  );
  process.exit(1);
}

const sessionId = randomUUID(); // each start = a brand-new session
const userId = config.userId ?? "local-user";

// ---------------------------------------------------------------------------
// Provider/model chain — config.provider / config.model accept a string OR an
// array. Arrays map 1:1 into fallback pairs: pair 0 is primary; on any
// failure except a real user cancel, NeuroLink's native providerFallback
// consults the next pair. A scalar on one side is repeated across the chain.
// ---------------------------------------------------------------------------

const providerList = Array.isArray(config.provider)
  ? config.provider
  : config.provider !== undefined
    ? [config.provider]
    : [];
const modelList = Array.isArray(config.model)
  ? config.model
  : config.model !== undefined
    ? [config.model]
    : [];
if (
  Array.isArray(config.provider) &&
  Array.isArray(config.model) &&
  providerList.length !== modelList.length
) {
  console.error(
    "✗ config.json: provider[] and model[] must be the same length (1:1 chain)",
  );
  process.exit(1);
}
const chainLength = Math.max(providerList.length, modelList.length);
const pick = (list, i) =>
  list.length === 0 ? undefined : list[Math.min(i, list.length - 1)];
const modelChain = Array.from({ length: chainLength }, (_, i) => ({
  ...(pick(providerList, i) !== undefined && {
    provider: pick(providerList, i),
  }),
  ...(pick(modelList, i) !== undefined && { model: pick(modelList, i) }),
}));
const primary = modelChain[0] ?? {};

// ---------------------------------------------------------------------------
// NeuroLink instance: session memory + compaction + Hippocampus + skills
// ---------------------------------------------------------------------------

const memoryDbPath = path.resolve(
  CWD,
  config.memory?.path ?? "memory/hippocampus.sqlite",
);
mkdirSync(path.dirname(memoryDbPath), { recursive: true });
const skillsDir = path.resolve(CWD, config.skills?.path ?? "skills");

const nl = new NeuroLink({
  conversationMemory: {
    // In-memory session store (no redisConfig) — history lives for this run.
    enabled: true,
    ...(config.summarization?.provider && {
      summarizationProvider: config.summarization.provider,
    }),
    ...(config.summarization?.model && {
      summarizationModel: config.summarization.model,
    }),
    // Auto-compaction: BudgetChecker fires pre-call; at `threshold` of the
    // model window the 4-stage compactor runs (prune → dedupe → summarize → window).
    contextCompaction: {
      enabled: config.compaction?.enabled ?? true,
      ...(config.compaction?.threshold !== undefined && {
        threshold: config.compaction.threshold,
      }),
    },
    // Long-term memory (Hippocampus) — persists in ./memory across sessions.
    memory: {
      enabled: true,
      storage: { type: "sqlite", path: memoryDbPath },
      ...(config.memory?.maxWords !== undefined && {
        maxWords: config.memory.maxWords,
      }),
      ...(config.summarization?.provider && {
        neurolink: {
          provider: config.summarization.provider,
          ...(config.summarization?.model && {
            model: config.summarization.model,
          }),
        },
      }),
    },
  },
  // Skills from ./skills — list_skills + use_skill/read_skill_resource are
  // injected per call; discovery "tool" embeds the catalog in the tool description.
  skills: {
    enabled: true,
    storage: { type: "filesystem", path: skillsDir },
    discovery: config.skills?.discovery ?? "tool",
  },
});

// ---------------------------------------------------------------------------
// Subagent delegation (optional, config.delegation)
// ---------------------------------------------------------------------------

if (
  config.delegation?.enabled &&
  typeof nl.registerDelegationTools !== "function"
) {
  console.warn(
    "⚠ delegation requested but this @juspay/neurolink build has no registerDelegationTools — rebuild neurolink (pnpm run build) and reinstall",
  );
}
if (
  config.delegation?.enabled &&
  typeof nl.registerDelegationTools === "function"
) {
  nl.registerDelegationTools({
    maxConcurrent: config.delegation.maxConcurrent ?? 2,
    spawnDefaults: {
      ...(primary.provider && { provider: primary.provider }),
      ...(primary.model && { model: primary.model }),
    },
  });
}

// ---------------------------------------------------------------------------
// MCP servers from MCP.json
// ---------------------------------------------------------------------------

const mcpServers = mcpFile.servers ?? mcpFile.mcpServers ?? {};
const mcpStatus = [];

// Expand "${VAR}" references against process.env so MCP.json stays free of
// secrets — credentials live in .env only.
function expandEnvRefs(record) {
  if (!record) {
    return record;
  }
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] =
      typeof value === "string"
        ? value.replace(/\$\{([A-Z_0-9]+)\}/g, (_, name) => {
            const resolved = process.env[name];
            if (resolved === undefined) {
              console.warn(
                `⚠ MCP.json references \${${name}} but it is not set in the environment`,
              );
              return "";
            }
            return resolved;
          })
        : value;
  }
  return out;
}

for (const [id, server] of Object.entries(mcpServers)) {
  const transport = server.transport ?? (server.url ? "http" : "stdio");
  try {
    const result = await nl.addExternalMCPServer(id, {
      id,
      name: server.name ?? id,
      description: server.description ?? `MCP server ${id}`,
      transport,
      status: "disconnected",
      tools: [],
      ...(server.command && { command: server.command }),
      ...(server.args && { args: server.args }),
      ...(server.env && { env: expandEnvRefs(server.env) }),
      ...(server.url && { url: server.url }),
      ...(server.headers && { headers: expandEnvRefs(server.headers) }),
      ...(server.timeout !== undefined && { timeout: server.timeout }),
      // stdio servers default to running inside the project directory so
      // relative paths in MCP.json resolve predictably.
      cwd: server.cwd ?? CWD,
    });
    if (result.success) {
      const toolCount = result.metadata?.toolsDiscovered ?? 0;
      mcpStatus.push(`  ✔ ${id} (${transport}) — ${toolCount} tools`);
    } else {
      mcpStatus.push(`  ✗ ${id} — ${result.error}`);
    }
  } catch (error) {
    mcpStatus.push(`  ✗ ${id} — ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

console.log("─".repeat(60));
console.log("Yama — NeuroLink agent");
console.log(`  project   ${CWD}`);
console.log(`  session   ${sessionId}  (new session each start)`);
console.log(`  user      ${userId}`);
console.log(
  `  models    ${
    modelChain.length > 0
      ? modelChain
          .map((c) => `${c.provider ?? "auto"}/${c.model ?? "auto"}`)
          .join("  →  ")
      : "auto"
  }`,
);
console.log(`  skills    ${skillsDir}`);
console.log(`  memory    ${memoryDbPath}`);
if (mcpStatus.length > 0) {
  console.log("  mcp");
  for (const line of mcpStatus) {
    console.log(`  ${line}`);
  }
} else {
  console.log("  mcp       (none configured)");
}
if (config.delegation?.enabled) {
  console.log("  delegation  delegate_task / collect_results enabled");
}
console.log("─".repeat(60));

// ---------------------------------------------------------------------------
// Shared turn runner (REPL + batch)
// ---------------------------------------------------------------------------

let lastTurnAt = 0;

async function runTurn(text, overrides = {}) {
  const startedAt = Date.now();
  // Fresh cursor per turn: each generate() walks the chain from pair 1.
  const fallbackCursor = { i: 1 };
  try {
    const result = await nl.generate({
      input: { text },
      ...(primary.provider && { provider: primary.provider }),
      ...(primary.model && { model: primary.model }),
      ...(modelChain.length > 1 && {
        providerFallback: async (error) => {
          if (fallbackCursor.i >= modelChain.length) {
            return null; // chain exhausted — bubble the original error
          }
          const next = modelChain[fallbackCursor.i++];
          const reason = error instanceof Error ? error.message : String(error);
          console.error(
            `  ↻ ${next.provider ?? "same"}/${next.model ?? "same"} (after: ${reason.slice(0, 120)})`,
          );
          return next;
        },
      }),
      ...(config.systemPrompt && { systemPrompt: config.systemPrompt }),
      ...(config.temperature !== undefined && {
        temperature: config.temperature,
      }),
      ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
      ...(config.timeouts?.requestTimeoutMs !== undefined && {
        timeout: config.timeouts.requestTimeoutMs,
      }),
      ...(config.timeouts?.turnTimeoutMs !== undefined && {
        turnTimeoutMs: config.timeouts.turnTimeoutMs,
      }),
      ...(config.timeouts?.stallTimeoutMs !== undefined && {
        stallTimeoutMs: config.timeouts.stallTimeoutMs,
      }),
      // Generic escape hatch: anything NeuroLink's generate() accepts can be
      // set in config.json under "generateOptions" — no code changes needed.
      ...(config.generateOptions ?? {}),
      // Per-prompt overrides from prompts.json win over config.
      ...overrides,
      context: {
        sessionId,
        userId,
        ...(config.generateOptions?.context ?? {}),
      },
    });

    lastTurnAt = Date.now();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    // Tool usage summary (ToolExecutionRecord[] on the new runtime).
    const executions = Array.isArray(result.toolExecutions)
      ? result.toolExecutions
      : [];
    if (executions.length > 0) {
      const summary = executions
        .map((record) => {
          const name = record.toolName ?? record.name ?? "tool";
          return record.isError ? `${name}✗` : name;
        })
        .join(", ");
      console.log(`  [tools: ${summary}]`);
    }

    console.log(`\n${result.content ?? "(no content)"}`);
    const meta = [
      `${seconds}s`,
      result.provider && result.model
        ? `${result.provider}/${result.model}`
        : null,
      result.stepsUsed ? `${result.stepsUsed} steps` : null,
      result.stopReason ?? result.finishReason ?? null,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(`  (${meta})`);
    return true;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

let rl;
let shuttingDown = false;

/** Flush-wait for background memory writes, then dispose NeuroLink — no exit. */
async function settle() {
  rl?.close();
  // Long-term memory is written in the background (LLM condensation +
  // SQLite write) after each turn; give a recent turn's write time to land
  // before killing the process. Bounded by memory.flushWaitMs (default 12s),
  // and skipped entirely when the last turn is already old enough.
  const flushWaitMs = config.memory?.flushWaitMs ?? 12_000;
  const sinceLastTurn = Date.now() - lastTurnAt;
  if (lastTurnAt > 0 && sinceLastTurn < flushWaitMs) {
    const wait = flushWaitMs - sinceLastTurn;
    console.log(`(flushing memory, up to ${Math.ceil(wait / 1000)}s…)`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  try {
    await nl.dispose();
  } catch {
    // best-effort cleanup
  }
}

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await settle();
  process.exit(code);
}

process.on("SIGINT", () => {
  console.log("\n(interrupted)");
  void shutdown(130);
});

// ---------------------------------------------------------------------------
// Batch mode — run prompts.json top to bottom in one session, then exit
// ---------------------------------------------------------------------------

function substituteParams(text, params) {
  return text.replace(/\$\{([A-Za-z_0-9]+)\}/g, (_, name) => {
    const resolved = params[name] ?? process.env[name];
    if (resolved === undefined) {
      console.warn(
        `⚠ prompts.json references \${${name}} but no parameter or env var supplies it`,
      );
      return "";
    }
    return resolved;
  });
}

if (command === "run") {
  const promptsFile = await loadJson("prompts.json");
  const list = Array.isArray(promptsFile) ? promptsFile : promptsFile.prompts;
  if (!Array.isArray(list) || list.length === 0) {
    console.error("✗ prompts.json has no prompts");
    await shutdown(1);
  }

  for (let i = 0; i < list.length; i++) {
    const entry = typeof list[i] === "string" ? { prompt: list[i] } : list[i];
    const { prompt, ...overrides } = entry;
    if (typeof prompt !== "string" || !prompt.trim()) {
      console.error(`✗ prompts.json entry ${i + 1} has no prompt text`);
      await shutdown(1);
    }
    const text = substituteParams(prompt, params);
    console.log(`\n━━ prompt ${i + 1}/${list.length} ━━`);
    console.log(text);
    const ok = await runTurn(text, overrides);
    if (!ok) {
      console.error(`✗ prompt ${i + 1} failed — aborting remaining prompts`);
      await shutdown(1);
    }
  }
  await shutdown(0);
}

// ---------------------------------------------------------------------------
// Learn mode — one agent turn distills a merged pull request's discussion
// into long-term memory (config.learnPrompt), then a deterministic git step
// (learn.mjs) commits the updated database. The agent never touches git.
// ---------------------------------------------------------------------------

/** Size+mtime fingerprint of the database and its WAL — a write lands in one of them. */
async function memoryFingerprint(dbPath) {
  const shape = async (p) => {
    try {
      const s = await stat(p);
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "absent";
    }
  };
  return `${await shape(dbPath)}|${await shape(`${dbPath}-wal`)}`;
}

/**
 * Wait for the condensation WRITE, not the wall clock: poll the fingerprint
 * until it moves (then one extra beat for a mid-flight transaction) or the
 * flushWaitMs deadline passes. The deadline is a ceiling here, never a sleep.
 */
async function waitForMemoryWrite(dbPath, before) {
  const deadlineMs = config.memory?.flushWaitMs ?? 12_000;
  const intervalMs = 1_000;
  const startedAt = Date.now();
  console.log(
    `(waiting for the memory write, up to ${Math.ceil(deadlineMs / 1000)}s…)`,
  );
  while (Date.now() - startedAt < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if ((await memoryFingerprint(dbPath)) !== before) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      return true;
    }
  }
  return (await memoryFingerprint(dbPath)) !== before;
}

if (command === "learn") {
  const text = substituteParams(config.learnPrompt, params);
  console.log(`\n━━ learn from PR #${params.pr} ━━`);
  console.log(text);
  const before = await memoryFingerprint(memoryDbPath);
  const ok = await runTurn(text);
  if (!ok) {
    await shutdown(1);
  }
  // Hippocampus condenses the turn in the background: wait for the WRITE
  // itself, then flush and dispose, so the WAL checkpoint in learn.mjs owns
  // the database alone. The flag keeps a SIGINT during the git phase from
  // re-entering dispose mid-commit. A learn whose memory never landed is a
  // FAILED learn, said out loud — never a green run that committed nothing.
  shuttingDown = true;
  const landed = await waitForMemoryWrite(memoryDbPath, before);
  await settle();
  if (!landed) {
    console.error(
      `✗ no memory write landed within ${config.memory?.flushWaitMs ?? 12_000}ms of the learn turn — the learning was NOT persisted (condensation too slow, or memory is disabled). Nothing will be committed; re-run learn once the cause is fixed.`,
    );
    process.exit(1);
  }
  const { runLearn } = await import("./learn.mjs");
  process.exit(
    await runLearn({
      cwd: CWD,
      memoryDbPath,
      pr: params.pr,
      learn: config.learn ?? {},
    }),
  );
}

// ---------------------------------------------------------------------------
// REPL mode
// ---------------------------------------------------------------------------

console.log('  type "exit" to quit');
rl = createInterface({ input: process.stdin, output: process.stdout });

for (;;) {
  let line;
  try {
    line = (await rl.question("\nyou> ")).trim();
  } catch {
    break; // readline closed
  }
  if (!line) {
    continue;
  }
  if (["exit", "quit", ":q"].includes(line.toLowerCase())) {
    break;
  }
  await runTurn(line);
}

await shutdown(0);
