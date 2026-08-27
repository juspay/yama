/**
 * Background commands, engine-native (TASKS:N4, docs/engine-spec.md section 4).
 *
 * `registerBackgroundCommandTools(policy)` puts `run_command_bg`, `command_status`,
 * `command_output` and `command_kill` on the registry under the fallback's names. The
 * hardening is the same contract — argv only, an exact-match allowlist, a realpath cwd
 * sandbox, SIGTERM then SIGKILL — enforced by the engine rather than by the seam, plus
 * three things the fallback did not have:
 *
 *   - the SIGKILL escalation actually escalates, and `command_status` is `cacheable: false`,
 *     so polling a command twice reports where it got to rather than replaying the first answer;
 *   - the outstanding counts ride on every `tasks_list`, so the agent learns a check finished
 *     without polling at all;
 *   - `output-limit` kills the process and keeps every byte already written.
 *
 * A run with no policy refuses before the engine is touched, in Yama's own words
 * (`NO_COMMAND_POLICY`), because the fix is in the repository and not in the engine.
 */
import type { BackgroundCommandStatus, NeuroLink } from "@juspay/neurolink";
import type {
  EngineCommandApi,
  EngineCommandPage,
  EngineCommandPolicy,
  EngineCommandRequest,
  EngineCommandResult,
  EngineCommandRun,
  RunStorePaths,
} from "../../types/index.js";
import { NO_COMMAND_POLICY } from "../policy.js";
import { mirrorArtifact, toEngineRef } from "./artifacts.js";

/** Engine status → seam result. Both banked streams are carried, never summarised away. */
const toResult = (status: BackgroundCommandStatus): EngineCommandResult => ({
  taskId: status.taskId,
  state: status.state,
  ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
  ...(status.signal !== undefined ? { signal: status.signal } : {}),
  durationMs: status.durationMs,
  ...(status.stdout ? { stdout: toEngineRef(status.stdout) } : {}),
  ...(status.stderr ? { stderr: toEngineRef(status.stderr) } : {}),
  tailPreview: status.tailPreview,
});

/** Runs allowlisted commands through the engine and registers the four N4 tools. */
export const createCommandNative = (options: {
  nl: NeuroLink;
  paths: RunStorePaths;
  policy?: EngineCommandPolicy;
  /** Session the commands belong to; scopes the outstanding counters. */
  currentSession: () => string;
}): EngineCommandApi => {
  const { policy } = options;
  if (policy !== undefined) {
    options.nl.registerBackgroundCommandTools({
      allowedExecutables: [...policy.allowedExecutables],
      cwdRoot: policy.cwdRoot,
      ...(policy.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: policy.defaultTimeoutMs }
        : {}),
      ...(policy.maxOutputBytes !== undefined
        ? { maxOutputBytes: policy.maxOutputBytes }
        : {}),
    });
  }

  const runs = new Map<string, EngineCommandRun>();

  /** Both streams into the run store, so the CI artifact carries the evidence. */
  const settle = async (
    status: BackgroundCommandStatus,
  ): Promise<EngineCommandResult> => {
    for (const stream of [status.stdout, status.stderr]) {
      if (stream !== undefined) {
        await mirrorArtifact({
          nl: options.nl,
          paths: options.paths,
          artifactId: stream.artifactId,
        });
      }
    }
    return toResult(status);
  };

  const start = async (
    req: EngineCommandRequest,
  ): Promise<EngineCommandRun> => {
    if (policy === undefined) {
      throw new Error(NO_COMMAND_POLICY);
    }
    const handle = await options.nl.startBackgroundCommand([...req.argv], {
      cwd: req.cwd,
      label: req.argv.join(" "),
      sessionId: options.currentSession(),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.maxOutputBytes !== undefined
        ? { maxOutputBytes: req.maxOutputBytes }
        : {}),
    });
    const { taskId } = handle;
    const done = options.nl.awaitBackgroundCommand(taskId).then(settle);
    const run: EngineCommandRun = {
      taskId,
      status: async (): Promise<EngineCommandResult> =>
        toResult(options.nl.getBackgroundCommandStatus(taskId)),
      output: async (page): Promise<EngineCommandPage> => {
        const read = await options.nl.readBackgroundCommandOutput(taskId, {
          stream: page.stream,
          ...(page.offset !== undefined ? { offset: page.offset } : {}),
          ...(page.limit !== undefined ? { limit: page.limit } : {}),
        });
        return {
          content: read.content,
          offset: read.offset,
          totalSize: read.totalSize,
          hasMore: read.hasMore,
        };
      },
      kill: async (): Promise<EngineCommandResult> => {
        await options.nl.killBackgroundCommand(taskId);
        return done;
      },
      done,
    };
    runs.set(taskId, run);
    return run;
  };

  return { start, get: (taskId: string) => runs.get(taskId) };
};
