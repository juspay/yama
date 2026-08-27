import type { ZodType } from "zod";

/** Provider/model selection for one engine role (main agent, worker, summarizer). */
export type EngineModel = {
  provider?: string;
  model?: string;
  /** Ordered fallback models, tried when the primary is denied (TASKS:Y1.4). */
  modelChain?: string[];
};

/** One MCP server from `mcp.yaml`, in Yama's own shape (TASKS:Y1.1). */
export type EngineMcpServer = {
  transport: "stdio" | "http" | "sse" | "websocket";
  /** stdio transport. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse / websocket transports. */
  url?: string;
  headers?: Record<string, string>;
  /** Connection timeout in ms. */
  timeout?: number;
};

/**
 * What a background command is allowed to do (docs/engine-spec.md section 4).
 * No policy at all means every start is refused — hardening is a contract, not advice.
 */
export type EngineCommandPolicy = {
  /** `argv[0]` must appear here verbatim. */
  allowedExecutables: string[];
  /** The resolved real cwd must sit inside this directory. */
  cwdRoot: string;
  defaultTimeoutMs?: number;
  /** Per stream. Reaching it kills the process; what was written stays on disk. */
  maxOutputBytes?: number;
};

/** Everything the seam needs to boot the main session. */
export type EngineConfig = {
  model: EngineModel;
  /** Static system instruction shared by every stage call (TASKS:Y2.4). */
  systemPrompt: string;
  /** Run-store directory the seam-local fallbacks bank into (engine-spec section 5.1). */
  storeDir: string;
  /** Default cap on agentic steps per stage call. */
  maxSteps?: number;
  /** Per-call wall-clock cap in ms. */
  timeoutMs?: number;
  /**
   * Cap on OUTPUT tokens per generation. Absent, the provider's own default governs —
   * and a gateway that defaults high makes input + output overflow the model's context
   * window exactly when a long run most needs the room for input (a live run died at
   * input 128001 + output 128000 against a 256k window).
   */
  maxTokens?: number;
  /** Model for delegated workers. Falls back to `model` (TASKS:Y1.4 worker role). */
  workerModel?: EngineModel;
  /**
   * The only tools a delegated worker may use (TASKS:Y5.1). Every `delegate` request is
   * clamped to this list, so a worker cannot recurse or post whatever the model asks for.
   */
  workerTools?: readonly string[];
  /** Absent ⇒ `backgroundRun` refuses every command and names this field. */
  commandPolicy?: EngineCommandPolicy;
  /** Concurrent delegated workers. Defaults to the medium pool tier. */
  maxConcurrentWorkers?: number;
};

/** An in-process tool Yama owns (`git_read`, `run_check`); the name is passed separately. */
export type EngineTool = {
  description: string;
  /** JSON Schema describing the tool parameters. */
  inputSchema?: object;
  /** `context` is the tool-execution context — `sessionId` above all. */
  execute: (params: unknown, context?: unknown) => Promise<unknown>;
};

/** Per-tool execution limits. Omitted fields fall back to the engine defaults. */
export type EngineToolOptions = {
  timeout?: number;
  maxRetries?: number;
};

/**
 * How a toolset gets onto the shared registry. Handed to the seam-local fallbacks so they
 * stay engine-free and testable — only `src/engine/index.ts` knows what backs it.
 */
export type EngineToolRegistrar = (
  name: string,
  tool: EngineTool,
  options?: EngineToolOptions,
) => void;

/** One structured checkpoint on the main session. */
export type StructuredRequest<T> = {
  /** Main-session id; every stage of one run shares it. */
  sessionId: string;
  prompt: string;
  schema: ZodType<T>;
  /** Tool allowlist for this call (TASKS:Y5.1 — posting tools only in Delivery). */
  tools?: string[];
  maxSteps?: number;
};

/**
 * One tool the model actually invoked during a call, as the engine recorded it.
 *
 * This is what makes "posted = confirmed" possible (TASKS:Y4.4): the shell does not take
 * the agent's word for a comment, it reads the platform's own result. `truncated` says the
 * engine bounded the captured result — the gate treats a truncated result as evidence it
 * may not rely on for anything it did not find in it.
 */
export type EngineToolResult = {
  name: string;
  /** Arguments the tool was called with, as the loop parsed them. */
  params: unknown;
  /** Parsed result when it was JSON, the raw text otherwise. */
  result: unknown;
  isError: boolean;
  truncated: boolean;
};

/** Verbatim engine output for one call; banked to the run store as evidence. */
export type EngineRawResult = {
  content: string;
  /** Best-effort object from the engine; partial when `truncated`. */
  structured: unknown;
  /** JSON had to be recovered from malformed model text. */
  repaired: boolean;
  /** Output hit the token cap, so `structured` may be incomplete. */
  truncated: boolean;
  provider?: string;
  model?: string;
  stepsUsed?: number;
  toolsUsed?: string[];
  /** What each tool call actually returned. Delivery's confirmation gate reads these. */
  toolResults?: EngineToolResult[];
};

/** Result of a structured call. `trusted` is the input to the schema gate (TASKS:Y4.1). */
export type StructuredResult<T> = {
  /** Schema-valid payload; `undefined` when the schema rejected what came back. */
  data: T | undefined;
  /** True only when the JSON was complete, unrepaired and schema-valid. */
  trusted: boolean;
  raw: EngineRawResult;
};

/** Checklist item states (TASKS:N1.1). */
export type EngineTaskStatus = "pending" | "in_progress" | "done" | "closed";

/** One item of the agent-authored review checklist. */
export type EngineTask = {
  id: string;
  title: string;
  status: EngineTaskStatus;
  /** Result note, or the reason an item was closed unfinished. */
  note?: string;
};

/** Host view of the session checklist; the completeness gate reads it (TASKS:N1.2/Y4.2). */
export type EngineTaskState = {
  sessionId: string;
  tasks: EngineTask[];
};

/** Outstanding background work, piggybacked on every checklist result (engine-spec N2.3). */
export type EngineDelegateCounts = {
  /** Spawned, not finished. */
  pending: number;
  /** Finished, not yet claimed by `collect`. */
  ready: number;
};

/** A unit of work handed to an isolated worker session (TASKS:N2.1). */
export type EngineDelegateRequest = {
  task: string;
  scope?: string;
  context?: string;
  /** Read-only tool allowlist for the worker (TASKS:Y5.1). */
  tools?: string[];
};

/** Handle returned immediately by `delegate`; the worker runs in the background. */
export type EngineWorkerHandle = {
  workerId: string;
};

/** How to pick up finished workers (TASKS:N2.2); return order is independent of spawn order. */
export type EngineCollectRequest =
  | { mode: "any" | "all"; waitMs?: number }
  | { workerId: string; waitMs?: number };

/** What one worker actually produced, before its report is banked. */
export type EngineWorkerOutcome = {
  ok: boolean;
  /** Bounded text the main conversation sees. */
  summary: string;
  /** The FULL report. Banked verbatim — a discarded byte is a lost finding. */
  report: string;
  error?: string;
};

/** Runs one worker to completion. Injected, so the delegation fallback stays engine-free. */
export type EngineWorkerRunner = (
  req: EngineDelegateRequest,
  signal: AbortSignal,
) => Promise<EngineWorkerOutcome>;

/** What kind of payload was banked; decides where the file lands and how it is labelled. */
export type EngineBankKind =
  "worker-report" | "command-output" | "stage-output";

/** Bank a payload to the run store and get a bounded preview back (TASKS:N3.1). */
export type EngineBankRequest = {
  kind: EngineBankKind;
  /** e.g. `delegate:auth-review` — shows up in previews and logs. */
  label: string;
  payload: string;
  /** Head slice returned inline. Default 1000, hard cap 4000. */
  previewChars?: number;
};

/** A banked payload: bounded preview inline, full content always on disk (TASKS:N3.2). */
export type EngineBankedRef = {
  id: string;
  label: string;
  sizeBytes: number;
  /** Bounded head slice; never a substitute for the file. */
  preview: string;
  /** Verbatim call that reads the whole thing back. */
  readBackHint: string;
};

/** Lifecycle of one background command (docs/engine-spec.md section 4). */
export type EngineCommandState =
  "queued" | "running" | "exited" | "killed" | "timeout" | "output-limit";

/** Start one command as argv. No string form, no shell, ever. */
export type EngineCommandRequest = {
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

/** Where a background command got to; both streams banked once it settles. */
export type EngineCommandResult = {
  taskId: string;
  state: EngineCommandState;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdout?: EngineBankedRef;
  stderr?: EngineBankedRef;
  /** Bounded tail; never a substitute for the banked file. */
  tailPreview: string;
};

/** One page of a command's banked output. */
export type EngineCommandPage = {
  content: string;
  offset: number;
  totalSize: number;
  hasMore: boolean;
};

/** Live handle on a running command. `done` settles when the process does. */
export type EngineCommandRun = {
  taskId: string;
  status: () => Promise<EngineCommandResult>;
  output: (page: {
    stream: "stdout" | "stderr";
    offset?: number;
    limit?: number;
  }) => Promise<EngineCommandPage>;
  kill: () => Promise<EngineCommandResult>;
  done: Promise<EngineCommandResult>;
};

/** A worker's bounded summary plus the banked report holding everything (TASKS:N3.1). */
export type EngineWorkerResult = {
  workerId: string;
  ok: boolean;
  summary: string;
  /** Absolute path of the banked report; kept so nothing reading it breaks. */
  reportPath?: string;
  /** The banked report, with the read-back call spelled out. */
  report?: EngineBankedRef;
  error?: string;
};

/** Seam-local checklist state, keyed by session (engine-spec section 5.1). */
export type EngineChecklistApi = {
  state: (sessionId: string) => EngineTaskState;
  clear: (sessionId: string) => boolean;
};

/** Seam-local spawn/collect, with claimed-once bookkeeping (engine-spec section 5.1). */
export type EngineDelegationApi = {
  delegate: (req: EngineDelegateRequest) => Promise<EngineWorkerHandle>;
  collect: (req: EngineCollectRequest) => Promise<EngineWorkerResult[]>;
  counts: () => EngineDelegateCounts;
  /** Aborts in-flight workers; returns how many were signalled. */
  cancel: (workerId?: string) => Promise<number>;
};

/** Seam-local file banking plus the `retrieve_context` read-back (engine-spec section 5.1). */
export type EngineBankApi = {
  bank: (req: EngineBankRequest) => Promise<EngineBankedRef>;
  read: (
    id: string,
    page?: { offset?: number; limit?: number },
  ) => Promise<string | undefined>;
};

/** Seam-local background commands (engine-spec section 5.1). */
export type EngineCommandApi = {
  start: (req: EngineCommandRequest) => Promise<EngineCommandRun>;
  get: (taskId: string) => EngineCommandRun | undefined;
};

/** The entire engine surface Yama product code is allowed to use. */
export type Engine = {
  /** One `generate({ schema })` checkpoint, with the JSON-health flags folded into `trusted`. */
  generateStructured: <T>(
    req: StructuredRequest<T>,
  ) => Promise<StructuredResult<T>>;
  /** Registers a Yama-owned tool on the shared registry. */
  registerTool: EngineToolRegistrar;
  /** Connects one MCP server; resolves to the tool names it exposed (TASKS:Y1.3). */
  connectMcp: (id: string, server: EngineMcpServer) => Promise<string[]>;
  /**
   * Invokes one registered or MCP tool directly, with no model in the loop.
   *
   * Deterministic gates use this and only this: marker dedup has to read the comments
   * that are actually on the target (TASKS:Y4.3), and asking a model to transcribe them
   * would be both dearer and less reliable than calling the tool.
   */
  callTool: (name: string, params?: unknown) => Promise<unknown>;
  /** Host-side checklist state for the completeness gate (TASKS:N1.2). */
  tasksApi: (sessionId: string) => Promise<EngineTaskState>;
  /** Spawns a background worker and returns its handle at once (TASKS:N2.1). */
  delegate: (req: EngineDelegateRequest) => Promise<EngineWorkerHandle>;
  /** Collects finished workers, whichever landed first (TASKS:N2.2/N3). */
  collect: (req: EngineCollectRequest) => Promise<EngineWorkerResult[]>;
  /** Banks a full payload and hands back a bounded reference (TASKS:N3.1). */
  bankReport: (req: EngineBankRequest) => Promise<EngineBankedRef>;
  /** Runs one allowlisted command as argv, output banked (TASKS:N4.1). */
  backgroundRun: (req: EngineCommandRequest) => Promise<EngineCommandRun>;
};
