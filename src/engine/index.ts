/**
 * Engine seam — the ONLY module in Yama allowed to import `@juspay/neurolink`
 * (TASKS:0.4). Every other module talks to the engine through this surface.
 *
 * Five of the nine members (`tasksApi`, `delegate`, `collect`, `bankReport`,
 * `backgroundRun`) have two implementations behind them, chosen by {@link ENGINE_NATIVE}:
 *
 *   - `./native/` — NeuroLink's own N1–N4 primitives (`registerTaskTools`,
 *     `spawnDelegate` / `collectDelegates`, `bankArtifact`, `startBackgroundCommand`);
 *   - `./fallback/` — the seam-local implementations the product track was built on,
 *     kept working so the swap can be undone in one environment variable.
 *
 * Both register the SAME model-visible tool names and return the same result shapes
 * (docs/engine-spec.md section 5.1), so every prompt, every stage and every gate above the
 * seam is identical on both paths — which is what makes the two comparable at all.
 */
import { NeuroLink } from "@juspay/neurolink";
import { storePathsForDir } from "../store/index.js";
import type {
  Engine,
  EngineBankApi,
  EngineBankRequest,
  EngineBankedRef,
  EngineChecklistApi,
  EngineCollectRequest,
  EngineCommandApi,
  EngineCommandRequest,
  EngineCommandRun,
  EngineConfig,
  EngineDelegateRequest,
  EngineDelegationApi,
  EngineMcpServer,
  EngineMemoryStatus,
  EngineTaskState,
  EngineTool,
  EngineToolOptions,
  EngineToolRegistrar,
  EngineWorkerHandle,
  EngineWorkerResult,
  RunStorePaths,
} from "../types/index.js";
import { createBankFallback } from "./fallback/bank.js";
import { createChecklistFallback } from "./fallback/tasks.js";
import { createCommandFallback } from "./fallback/command.js";
import { createDelegationFallback } from "./fallback/delegation.js";
import { createBankNative } from "./native/bank.js";
import { createChecklistNative } from "./native/tasks.js";
import { createCommandNative } from "./native/command.js";
import { createDelegationNative } from "./native/delegation.js";
import { connectMcpServer } from "./mcp.js";
import { createStructuredCall } from "./structured.js";
import { createWorkerRunner } from "./worker.js";

/** The engine package Yama is pinned to; imported nowhere else. */
export const ENGINE_PACKAGE = "@juspay/neurolink";

/**
 * Which implementation backs the five swappable members. The engine-native primitives are
 * the default; `YAMA_ENGINE_NATIVE=0` puts the seam-local fallbacks back.
 *
 * The switch exists so the two paths can be run against the SAME e2e suite rather than
 * argued about, and so a regression in a freshly landed engine primitive costs one
 * environment variable instead of a revert. It is read once, at module load: a run does not
 * get to change engines half way through.
 */
export const ENGINE_NATIVE: boolean = process.env.YAMA_ENGINE_NATIVE !== "0";

/** Default worker pool when the config does not size it (POOL_TIER_CONCURRENCY.medium). */
const DEFAULT_MAX_WORKERS = 3;

/** The four swappable surfaces, whichever implementation is behind them. */
type Surfaces = {
  bank: EngineBankApi;
  checklist: EngineChecklistApi;
  delegation: EngineDelegationApi;
  commands: EngineCommandApi;
};

/** What both implementations are built from. */
type Boot = {
  nl: NeuroLink;
  cfg: EngineConfig;
  paths: RunStorePaths;
  register: EngineToolRegistrar;
  /** Session of the stage in flight, so a tool call with no context still lands right. */
  currentSession: () => string;
};

/** NeuroLink's own N1–N4 primitives. Yama registers none of these tools itself. */
const nativeSurfaces = (boot: Boot): Surfaces => {
  const { nl, cfg, paths, currentSession } = boot;
  return {
    bank: createBankNative({ nl, paths, currentSession }),
    checklist: createChecklistNative({ nl }),
    delegation: createDelegationNative({
      nl,
      paths,
      model: cfg.workerModel ?? cfg.model,
      systemPrompt: cfg.systemPrompt,
      maxConcurrent: cfg.maxConcurrentWorkers ?? DEFAULT_MAX_WORKERS,
      currentSession,
      ...(cfg.workerTools !== undefined
        ? { workerTools: cfg.workerTools }
        : {}),
    }),
    commands: createCommandNative({
      nl,
      paths,
      currentSession,
      ...(cfg.commandPolicy !== undefined ? { policy: cfg.commandPolicy } : {}),
    }),
  };
};

/** The seam-local implementations, on surfaces NeuroLink shipped before Track N. */
const fallbackSurfaces = (boot: Boot): Surfaces => {
  const { nl, cfg, paths, register, currentSession } = boot;
  const bank = createBankFallback({ register, paths });
  const delegation = createDelegationFallback({
    register,
    bank,
    run: createWorkerRunner(nl, cfg),
    maxConcurrent: cfg.maxConcurrentWorkers ?? DEFAULT_MAX_WORKERS,
    ...(cfg.workerTools !== undefined ? { workerTools: cfg.workerTools } : {}),
  });
  return {
    bank,
    delegation,
    checklist: createChecklistFallback({
      register,
      delegates: delegation.counts,
      currentSession,
    }),
    commands: createCommandFallback({
      register,
      paths,
      bank,
      defaultCwd: cfg.commandPolicy?.cwdRoot ?? cfg.storeDir,
      ...(cfg.commandPolicy !== undefined ? { policy: cfg.commandPolicy } : {}),
    }),
  };
};

/**
 * The engine's memory configuration, or nothing at all.
 *
 * NeuroLink defaults `conversationMemory.enabled` to FALSE, and Yama spent its whole v5
 * life constructing `new NeuroLink()` with no argument — so the "one session, stages as
 * checkpoints on it" model in PLAN.md §1 was never true at run time. Every stage, every
 * schema retry and every nudge round was a cold call.
 *
 * The summarizer is pinned deliberately, and pinning it is not optional in the way it
 * looks. `generateSummary` REFUSES to run without an explicit provider and model, and a
 * refusal evicts nothing — so an unset summarizer is not "no summarizer, harmlessly", it
 * is a memory that grows for ever. The chain it comes from always resolves (`summarizer`
 * falls back to `worker`, then to the required `main`), which is what makes this safe.
 */
const memoryConfig = (
  memory: EngineConfig["memory"],
): { conversationMemory: Record<string, unknown> } | undefined => {
  if (memory === undefined || !memory.enabled) {
    return undefined;
  }
  // Summarization is switched OFF rather than left half-configured. `generateSummary`
  // refuses without an explicit provider AND model, and a refusal evicts nothing — so
  // "enabled with no summarizer" is not a degraded memory, it is one that grows for ever
  // while claiming to be managed. Saying so up front is the honest shape.
  const named =
    memory.summarizer?.provider !== undefined &&
    memory.summarizer.model !== undefined;
  return {
    conversationMemory: {
      enabled: true,
      enableSummarization: memory.summarize && named,
      tokenThreshold: memory.tokenThreshold,
      // The ceiling belongs to the deployment, not the library (see the config field).
      summarizationTimeoutMs: memory.summarizeTimeoutMs,
      ...(named
        ? {
            summarizationProvider: memory.summarizer?.provider,
            summarizationModel: memory.summarizer?.model,
          }
        : {}),
    },
  };
};

/** Boots the main session. MCP servers are attached afterwards via `connectMcp`. */
export const createEngine = (cfg: EngineConfig): Engine => {
  const memory = memoryConfig(cfg.memory);
  const nl = memory === undefined ? new NeuroLink() : new NeuroLink(memory);
  const paths = storePathsForDir(cfg.storeDir);

  let activeSession = "yama";

  const register = (
    name: string,
    tool: EngineTool,
    options?: EngineToolOptions,
  ): void => {
    nl.registerTool(name, { name, ...tool }, options);
  };

  const boot: Boot = {
    nl,
    cfg,
    paths,
    register,
    currentSession: () => activeSession,
  };
  const { bank, checklist, delegation, commands } = ENGINE_NATIVE
    ? nativeSurfaces(boot)
    : fallbackSurfaces(boot);

  return {
    generateStructured: createStructuredCall(nl, cfg, (sessionId) => {
      activeSession = sessionId;
    }),
    registerTool: register,
    connectMcp: (id: string, server: EngineMcpServer): Promise<string[]> =>
      connectMcpServer(nl, id, server),
    // Direct invocation, no model in the loop: the deterministic gates read the platform
    // themselves rather than asking an agent to transcribe it (TASKS:Y4.3).
    callTool: (name: string, params?: unknown): Promise<unknown> =>
      nl.executeTool(name, params ?? {}),
    // Read off the engine, never off our own config: "we asked for memory" and "this run
    // has one" are different claims, and only the second is worth reporting.
    memoryStatus: (): EngineMemoryStatus => ({
      enabled: memory !== undefined,
      ready: Boolean(nl.conversationMemory),
      ...(cfg.memory !== undefined
        ? {
            tokenThreshold: cfg.memory.tokenThreshold,
            summarizeTimeoutMs: cfg.memory.summarizeTimeoutMs,
            evicting:
              memory !== undefined &&
              memory.conversationMemory["enableSummarization"] === true,
          }
        : {}),
    }),
    tasksApi: async (sessionId: string): Promise<EngineTaskState> =>
      checklist.state(sessionId),
    delegate: (req: EngineDelegateRequest): Promise<EngineWorkerHandle> =>
      delegation.delegate(req),
    collect: (req: EngineCollectRequest): Promise<EngineWorkerResult[]> =>
      delegation.collect(req),
    bankReport: (req: EngineBankRequest): Promise<EngineBankedRef> =>
      bank.bank(req),
    backgroundRun: (req: EngineCommandRequest): Promise<EngineCommandRun> =>
      commands.start(req),
  };
};
