/**
 * Background commands, seam-local (TASKS:N4 fallback, docs/engine-spec.md section 5.1).
 *
 * Hardening here is a contract, not advice:
 *   argv arrays only — `spawn(argv[0], argv.slice(1), { shell: false })`, no string form;
 *   an allowlist on `argv[0]`, and no policy at all means every start is refused;
 *   a cwd sandbox resolved through realpath, so a symlink out of the tree is a refusal;
 *   SIGTERM at the timeout, SIGKILL five seconds later.
 *
 * Both streams go straight to files. Hitting the output cap kills the process and keeps
 * every byte written up to that point — the cap bounds the RUN, it never edits the record.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  EngineBankApi,
  EngineCommandApi,
  EngineCommandPage,
  EngineCommandPolicy,
  EngineCommandRequest,
  EngineCommandResult,
  EngineCommandRun,
  EngineCommandState,
  EngineToolRegistrar,
  RunStorePaths,
} from "../../types/index.js";
import { ensureDir, readTextFile, resolveWithinRoot } from "../../util/fs.js";
import { jsonSchemaOf, readParams, refuse } from "../../util/tool.js";
import { NO_COMMAND_POLICY } from "../policy.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10_485_760;
const SIGKILL_GRACE_MS = 5_000;
const TAIL_CHARS = 2_000;
const DEFAULT_PAGE_CHARS = 4_000;

const StartSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const TaskSchema = z.object({ taskId: z.string().min(1) });
const OutputSchema = z.object({
  taskId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

type StreamFiles = { stdout: string; stderr: string };

/** Live state of one command; `settled` appears once the process closed and banked. */
type Job = {
  taskId: string;
  state: EngineCommandState;
  tail: string;
  startedAt: number;
  settled?: EngineCommandResult;
};

/**
 * Every refusal names the fix, because the model is the one that has to act on it.
 * Returns "" when the request is allowed.
 */
const refusalFor = async (
  req: EngineCommandRequest,
  policy: EngineCommandPolicy | undefined,
): Promise<string> => {
  if (!policy) {
    return NO_COMMAND_POLICY;
  }
  if (!policy.allowedExecutables.includes(req.argv[0])) {
    return `"${req.argv[0]}" is not an allowed executable. Allowed: ${policy.allowedExecutables.join(", ") || "(none)"}.`;
  }
  if ((await resolveWithinRoot(req.cwd, policy.cwdRoot)) === undefined) {
    return `cwd "${req.cwd}" resolves outside the sandbox root. Run the command inside the repository.`;
  }
  return "";
};

/** Snapshot of a job that has not settled yet. */
const snapshotOf = (job: Job): EngineCommandResult =>
  job.settled ?? {
    taskId: job.taskId,
    state: job.state,
    durationMs: Date.now() - job.startedAt,
    tailPreview: job.tail,
  };

/** Banks both streams in full and builds the terminal result. */
const settleJob = async (
  job: Job,
  files: StreamFiles,
  bank: EngineBankApi,
  exit: { code: number | null; signal: string | null },
): Promise<EngineCommandResult> => ({
  taskId: job.taskId,
  state: job.state === "running" ? "exited" : job.state,
  ...(exit.code !== null ? { exitCode: exit.code } : {}),
  ...(exit.signal !== null ? { signal: exit.signal } : {}),
  durationMs: Date.now() - job.startedAt,
  stdout: await bank.bank({
    kind: "command-output",
    label: `command-${job.taskId}-stdout`,
    payload: (await readTextFile(files.stdout)) ?? "",
  }),
  stderr: await bank.bank({
    kind: "command-output",
    label: `command-${job.taskId}-stderr`,
    payload: (await readTextFile(files.stderr)) ?? "",
  }),
  tailPreview: job.tail,
});

/** One page of a stream, straight off disk. Output is paged, never trimmed. */
const pageOf = async (
  file: string,
  page: { offset?: number; limit?: number },
): Promise<EngineCommandPage> => {
  const whole = (await readTextFile(file)) ?? "";
  const offset = page.offset ?? 0;
  const content = whole.slice(
    offset,
    offset + (page.limit ?? DEFAULT_PAGE_CHARS),
  );
  return {
    content,
    offset,
    totalSize: whole.length,
    hasMore: offset + content.length < whole.length,
  };
};

/** Spawns the process, wires the streams to files, and returns the live handle. */
const spawnJob = (
  job: Job,
  req: EngineCommandRequest,
  files: StreamFiles,
  limits: { maxOutputBytes: number; timeoutMs: number },
  hooks: { bank: EngineBankApi; signal?: AbortSignal },
): EngineCommandRun => {
  const child = spawn(req.argv[0], req.argv.slice(1), {
    cwd: req.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sinks = {
    stdout: createWriteStream(files.stdout),
    stderr: createWriteStream(files.stderr),
  } as const;
  const written = { stdout: 0, stderr: 0 };

  const stop = (next: EngineCommandState): void => {
    if (job.state === "running") {
      job.state = next;
    }
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS).unref();
  };

  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) => {
      written[stream] += chunk.byteLength;
      sinks[stream].write(chunk);
      job.tail = `${job.tail}${chunk.toString("utf8")}`.slice(-TAIL_CHARS);
      if (written[stream] > limits.maxOutputBytes) {
        stop("output-limit");
      }
    });
  }

  const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
  timer.unref();
  const onAbort = (): void => stop("killed");
  hooks.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<EngineCommandResult>((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      hooks.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        for (const sink of [sinks.stdout, sinks.stderr]) {
          await new Promise<void>((end) => sink.end(end));
        }
        job.settled = await settleJob(job, files, hooks.bank, { code, signal });
        resolve(job.settled);
      })();
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      job.settled = {
        taskId: job.taskId,
        state: "exited",
        durationMs: Date.now() - job.startedAt,
        tailPreview: error.message,
      };
      resolve(job.settled);
    });
  });

  return {
    taskId: job.taskId,
    status: async () => snapshotOf(job),
    output: (page) => pageOf(files[page.stream], page),
    kill: async () => {
      stop("killed");
      return done;
    },
    done,
  };
};

/** Registers the four N4 tools against an already-built command API. */
const registerCommandTools = (
  register: EngineToolRegistrar,
  api: {
    start: (req: EngineCommandRequest) => Promise<EngineCommandRun>;
    get: (taskId: string) => EngineCommandRun | undefined;
    status: (taskId: string) => EngineCommandResult | undefined;
    defaultCwd: string;
  },
): void => {
  const missing = (taskId: string): { isError: true; error: string } =>
    refuse(
      `no background command "${taskId}". Start one with run_command_bg first.`,
    );

  register("run_command_bg", {
    description:
      "Run one allowlisted command as argv (never a shell string) in the background. Returns a taskId at once; poll it with command_status and read its full output with command_output.",
    inputSchema: jsonSchemaOf(StartSchema),
    execute: async (params) => {
      const parsed = readParams(StartSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      try {
        const run = await api.start({
          argv: parsed.value.argv,
          cwd: parsed.value.cwd ?? api.defaultCwd,
          ...(parsed.value.timeoutMs !== undefined
            ? { timeoutMs: parsed.value.timeoutMs }
            : {}),
        });
        return { taskId: run.taskId, state: "running" };
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
    },
  });

  register("command_status", {
    description:
      "Status of one background command, with a bounded tail of its output. The full streams are banked — read them with command_output.",
    inputSchema: jsonSchemaOf(TaskSchema),
    execute: async (params) => {
      const parsed = readParams(TaskSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      return api.status(parsed.value.taskId) ?? missing(parsed.value.taskId);
    },
  });

  register("command_output", {
    description:
      "Read one page of a background command's stdout or stderr. Output is never truncated on disk; page through it.",
    inputSchema: jsonSchemaOf(OutputSchema),
    execute: async (params) => {
      const parsed = readParams(OutputSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const run = api.get(parsed.value.taskId);
      if (!run) {
        return missing(parsed.value.taskId);
      }
      const { taskId, stream, offset, limit } = parsed.value;
      const page = await run.output({
        stream,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { taskId, stream, ...page };
    },
  });

  register("command_kill", {
    description:
      "Stop a background command. Everything it wrote before the kill stays banked and readable.",
    inputSchema: jsonSchemaOf(TaskSchema),
    execute: async (params) => {
      const parsed = readParams(TaskSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const run = api.get(parsed.value.taskId);
      return run ? run.kill() : missing(parsed.value.taskId);
    },
  });
};

/** Runs allowlisted commands as background argv jobs and registers the four N4 tools. */
export const createCommandFallback = (options: {
  register: EngineToolRegistrar;
  paths: RunStorePaths;
  bank: EngineBankApi;
  policy?: EngineCommandPolicy;
  signal?: AbortSignal;
  /** Default cwd for tool calls that do not name one. */
  defaultCwd: string;
}): EngineCommandApi => {
  const jobs = new Map<string, { job: Job; run: EngineCommandRun }>();
  let sequence = 0;

  const start = async (
    req: EngineCommandRequest,
  ): Promise<EngineCommandRun> => {
    const refusal = await refusalFor(req, options.policy);
    if (refusal !== "") {
      throw new Error(refusal);
    }
    const taskId = `c${(sequence += 1)}`;
    await ensureDir(options.paths.checksDir);
    const files: StreamFiles = {
      stdout: join(options.paths.checksDir, `${taskId}.out`),
      stderr: join(options.paths.checksDir, `${taskId}.err`),
    };
    const job: Job = {
      taskId,
      state: "running",
      tail: "",
      startedAt: Date.now(),
    };
    const run = spawnJob(
      job,
      req,
      files,
      {
        maxOutputBytes:
          req.maxOutputBytes ??
          options.policy?.maxOutputBytes ??
          DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs:
          req.timeoutMs ??
          options.policy?.defaultTimeoutMs ??
          DEFAULT_TIMEOUT_MS,
      },
      {
        bank: options.bank,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    jobs.set(taskId, { job, run });
    return run;
  };

  registerCommandTools(options.register, {
    start,
    get: (taskId) => jobs.get(taskId)?.run,
    status: (taskId) => {
      const entry = jobs.get(taskId);
      return entry ? snapshotOf(entry.job) : undefined;
    },
    defaultCwd: options.defaultCwd,
  });

  return { start, get: (taskId: string) => jobs.get(taskId)?.run };
};
