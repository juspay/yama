/**
 * Argv-only process execution (PLAN.md section 3: "argv not shell").
 *
 * `shell: false` is the whole point — a path with a space, a branch called `$(id)`, a file
 * named `;rm -rf /` are all just strings here. Output is accumulated without a cap: this
 * runs `git`, and a large diff is exactly the thing that must not be trimmed.
 */
import { spawn } from "node:child_process";

/** Result of one argv run. A non-zero `exitCode` is data, not an exception. */
export const runArgv = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    timer?.unref();

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code ?? -1,
      });
    });
  });
