/**
 * `run_check` (TASKS:Y5.2) — running the repository's own checks as evidence.
 *
 * Two rules make this safe enough to hand to an agent, and both are the shell's:
 *
 *   1. **The commands come from the BASE branch.** `checks.yaml` is read out of git at the
 *      ref the change is going into, never out of the working tree, so a change cannot
 *      introduce the command that reviews it.
 *   2. **Anything the change modified is refused.** If the head touched `checks.yaml` the
 *      whole file is untrusted; if it touched a script a check names, that check is
 *      refused by name. The refusal says which file moved, so the human can decide.
 *
 * Execution itself is `engine.backgroundRun`: argv only, allowlisted, cwd-sandboxed, both
 * streams banked in full. `run_check` returns the exit code and the read-back calls — the
 * output is evidence, and evidence lives in the store, not in the conversation.
 */
import { join, normalize } from "node:path";
import { load } from "js-yaml";
import { z } from "zod";
import { ChecksConfigSchema } from "../config/schema.js";
import { CONFIG_DIR, CONFIG_FILES } from "../config/paths.js";
import { jsonSchemaOf, readParams, refuse } from "../util/tool.js";
import type {
  CheckRunResult,
  CheckSpec,
  ChecksConfig,
  ChecksGuard,
  EngineCommandRequest,
  EngineCommandRun,
  EngineToolRegistrar,
  GitDiff,
} from "../types/index.js";
import { formatIssues } from "../util/zod.js";
import { gitShowFile } from "./git.js";

/** Repository-relative path of the checks file, as git spells it. */
export const CHECKS_PATH = `${CONFIG_DIR}/${CONFIG_FILES.checks}`;

/**
 * Executables that run a script declared somewhere else — for these, a change to the
 * package manifest is a change to the check itself.
 */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "npx", "bun", "bunx"]);

/** Manifests those runners take their scripts from. */
const MANIFESTS = ["package.json"] as const;

const RunCheckSchema = z.object({ id: z.string().min(1) });

/** Path as git reports it: forward slashes, no leading `./`. */
const normalizePath = (path: string): string =>
  normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * The base branch carries a PRE-v5 `checks.yaml`. This is the state every repository
 * migrating from v3/v4 is in on its first v5 pull request: the base file is not a broken
 * v5 config, it is a different format — so checks degrade to off-with-a-reason for that
 * run instead of failing it. A file that IS v5-shaped but invalid still fails loudly.
 */
export class LegacyChecksError extends Error {
  constructor(ref: string) {
    super(
      `${CHECKS_PATH} on ${ref} is in the pre-v5 format — checks are off for this run ` +
        "and run again once the migrated file is on the base branch",
    );
    this.name = "LegacyChecksError";
  }
}

/** Recognises the pre-v5 document shape: root `enabled`/`allowForks`, or entries with `run`/`parse`/`type`. */
const isLegacyChecksDocument = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if ("enabled" in record || "allowForks" in record) {
    return true;
  }
  const entries = record["checks"];
  return (
    Array.isArray(entries) &&
    entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        ("run" in entry || "parse" in entry || "type" in entry),
    )
  );
};

/**
 * Reads `checks.yaml` as it stands on `ref`. An absent file there is not an error: it
 * means this repository declares no checks on the base branch, which is exactly the state
 * a change that just added them is in — and a check the change itself introduced is not
 * one Yama will run. A pre-v5 file throws {@link LegacyChecksError} so callers degrade
 * rather than die on a format-migration pull request.
 */
export const readChecksAtRef = async (options: {
  root: string;
  ref: string;
  signal?: AbortSignal;
}): Promise<ChecksConfig | undefined> => {
  const text = await gitShowFile(
    options.root,
    options.ref,
    CHECKS_PATH,
    options.signal,
  );
  if (text === undefined) {
    return undefined;
  }
  const document = load(text) ?? {};
  const parsed = ChecksConfigSchema.safeParse(document);
  if (!parsed.success) {
    if (isLegacyChecksDocument(document)) {
      throw new LegacyChecksError(options.ref);
    }
    throw new Error(
      `${CHECKS_PATH} at ${options.ref}: ${formatIssues(parsed.error)}`,
    );
  }
  return parsed.data;
};

/** Every path this change touched, on both sides of a rename. */
const changedPaths = (diff: GitDiff): Set<string> => {
  const paths = new Set<string>();
  for (const file of diff.files) {
    paths.add(normalizePath(file.path));
    if (file.previousPath !== undefined) {
      paths.add(normalizePath(file.previousPath));
    }
  }
  return paths;
};

/** True when `candidate` is a changed file, or a directory holding one. */
const touches = (changed: ReadonlySet<string>, candidate: string): boolean => {
  const path = normalizePath(candidate);
  if (path === "" || path === ".") {
    return false;
  }
  if (changed.has(path)) {
    return true;
  }
  const prefix = `${path}/`;
  for (const entry of changed) {
    if (entry.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

/** The file this check's definition depends on that the change moved, if any. */
const movedUnder = (
  check: CheckSpec,
  changed: ReadonlySet<string>,
): string | undefined => {
  const candidates = [
    ...check.command.slice(1),
    ...(check.cwd !== undefined ? [check.cwd] : []),
    ...(SCRIPT_RUNNERS.has(check.command[0]) ? MANIFESTS : []),
  ];
  return candidates.find((candidate) => touches(changed, candidate));
};

/**
 * Which checks this change is not allowed to run (TASKS:Y5.2).
 *
 * Pure: the diff already says what the head changed relative to the base, so nothing here
 * needs to go back to git.
 */
export const guardChecks = (options: {
  checks: ChecksConfig | undefined;
  diff: GitDiff;
}): ChecksGuard => {
  const guard: ChecksGuard = { blocked: {} };
  if (options.checks === undefined) {
    return guard;
  }
  const changed = changedPaths(options.diff);
  if (changed.has(CHECKS_PATH)) {
    guard.allBlocked = `this change modifies ${CHECKS_PATH}. The checks a review runs come from the base branch; a change that rewrites them does not get to run them. Review the diff of that file by hand.`;
    return guard;
  }
  for (const check of options.checks.checks) {
    const moved = movedUnder(check, changed);
    if (moved !== undefined) {
      guard.blocked[check.id] =
        `check "${check.id}" is refused: this change modifies "${moved}", which is part of the check itself. Read the diff of that file instead of trusting its output.`;
    }
  }
  return guard;
};

/** The result the model sees: the verdict of the check, plus where to read the output. */
const toCheckResult = (
  check: CheckSpec,
  settled: {
    taskId: string;
    state: string;
    exitCode?: number;
    tailPreview: string;
    stdout?: { readBackHint: string };
    stderr?: { readBackHint: string };
  },
): CheckRunResult => ({
  checkId: check.id,
  taskId: settled.taskId,
  state: settled.state,
  ...(settled.exitCode !== undefined ? { exitCode: settled.exitCode } : {}),
  optional: check.optional,
  tailPreview: settled.tailPreview,
  ...(settled.stdout ? { stdout: settled.stdout.readBackHint } : {}),
  ...(settled.stderr ? { stderr: settled.stderr.readBackHint } : {}),
});

/**
 * Registers `run_check`. The command runner is injected rather than the engine itself, so
 * this module stays outside the seam like every other Yama-owned toolset.
 */
export const registerCheckTools = (options: {
  register: EngineToolRegistrar;
  run: (req: EngineCommandRequest) => Promise<EngineCommandRun>;
  checks: ChecksConfig | undefined;
  root: string;
  guard: ChecksGuard;
}): void => {
  const byId = new Map(
    (options.checks?.checks ?? []).map((check) => [check.id, check]),
  );
  const ids = [...byId.keys()];

  options.register("run_check", {
    description: `Run one of this repository's declared checks and read its result. Available: ${ids.join(", ") || "(none — this repository declares no checks on its base branch)"}. The full stdout and stderr are banked; page them with command_output or the returned retrieve_context call.`,
    inputSchema: jsonSchemaOf(RunCheckSchema),
    execute: async (params) => {
      const parsed = readParams(RunCheckSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const check = byId.get(parsed.value.id);
      if (check === undefined) {
        return refuse(
          `no check "${parsed.value.id}". Declared on the base branch: ${ids.join(", ") || "(none)"}.`,
        );
      }
      if (options.guard.allBlocked !== undefined) {
        return refuse(options.guard.allBlocked);
      }
      const blocked = options.guard.blocked[check.id];
      if (blocked !== undefined) {
        return refuse(blocked);
      }
      try {
        const run = await options.run({
          argv: [...check.command],
          cwd:
            check.cwd !== undefined
              ? join(options.root, check.cwd)
              : options.root,
          timeoutMs: check.timeoutMs,
        });
        return toCheckResult(check, await run.done);
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error));
      }
    },
  });
};
