/**
 * Config loader and degradation matrix (TASKS:Y1.2).
 *
 * Two rules decide every case in this file:
 *   1. An absent OPTIONAL piece turns a capability off and records why. Never an error.
 *   2. A required file that is missing, or any file that is present but broken, fails
 *      loudly and names the exact path plus the fix.
 */
import { join } from "node:path";
import { load } from "js-yaml";
import type { z } from "zod";
// Needs `export * from "./config.js"` in src/types/index.ts (TASKS:Y1.1 integrate step).
import type {
  CapabilityArgs,
  CapabilityBinding,
  CapabilityBindingSpec,
  CapabilityBindings,
  CapabilityId,
  ChecksConfig,
  ConfigDegradation,
  DeliveryAction,
  DeliveryConfig,
  McpConfig,
  McpServerConfig,
  ResolvedConfig,
  RulebookLayout,
  RunTarget,
} from "../types/index.js";
import { pathExists, readTextFile } from "../util/fs.js";
import { formatIssues } from "../util/zod.js";
import {
  CAPABILITIES,
  CAPABILITY_IDS,
  DELIVERY_CAPABILITIES,
  requiredCapabilitiesFor,
} from "./capabilities.js";
import { ENV_REF, expandEnvRefs } from "./env.js";
import { ConfigError } from "./errors.js";
import { resolveModelChains } from "./modelChain.js";
import { RULEBOOK_INDEX_CANDIDATES, resolveConfigPaths } from "./paths.js";
import {
  ChecksConfigSchema,
  DELIVERY_ACTIONS,
  McpConfigSchema,
  YamaConfigSchema,
} from "./schema.js";

/** Reads a YAML document. Returns undefined when the file is not there. */
const readYaml = async (file: string): Promise<unknown> => {
  let text: string | undefined;
  try {
    text = await readTextFile(file);
  } catch (error) {
    throw new ConfigError(`${file}: cannot be read`, { file, cause: error });
  }
  if (text === undefined) {
    return undefined;
  }
  try {
    return load(text, { filename: file }) ?? {};
  } catch (error) {
    throw new ConfigError(
      `${file}: is not valid YAML — ${error instanceof Error ? error.message : String(error)}`,
      { file, cause: error },
    );
  }
};

const parseOrThrow = <S extends z.ZodType>(
  schema: S,
  value: unknown,
  file: string,
): z.infer<S> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(`${file}: ${formatIssues(result.error)}`, { file });
  }
  return result.data;
};

/* ------------------------------------------------------------ mcp.yaml wiring */

/**
 * Reported before schema validation so a mistyped capability names the valid set instead of
 * zod's generic "invalid key" complaint.
 */
const assertKnownCapabilities = (raw: unknown, file: string): void => {
  if (typeof raw !== "object" || raw === null || !("capabilities" in raw)) {
    return;
  }
  const declared = raw.capabilities;
  if (typeof declared !== "object" || declared === null) {
    return;
  }
  const known = new Set<string>(CAPABILITY_IDS);
  const unknown = Object.keys(declared).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${file}: unknown ${unknown.length === 1 ? "capability" : "capabilities"} ${unknown.join(", ")}`,
      { file, hint: `Yama knows: ${CAPABILITY_IDS.join(", ")}` },
    );
  }
};

/**
 * Placeholders a capability's `args` may use, taken from the run target rather than from
 * the environment. They are substituted BEFORE `${VAR}` expansion, so `${pr}` is never
 * mistaken for an unset environment variable.
 */
const RUN_PLACEHOLDERS = ["mode", "pr", "branch", "base"] as const;

const runPlaceholders = (target: RunTarget): Record<string, string> => ({
  mode: target.mode,
  ...(target.mode === "pr" ? { pr: String(target.pr) } : {}),
  ...(target.mode === "branch" ? { branch: target.branch } : {}),
  ...(target.mode !== "local" && target.base !== undefined
    ? { base: target.base }
    : {}),
});

/**
 * Fills `${pr}` and friends. A run placeholder this TARGET has no value for is collected
 * rather than expanded: a capability map written for pull requests is not broken just
 * because someone ran a local review, it is simply unusable in that mode.
 */
const fillRunPlaceholders = (
  value: string,
  values: Record<string, string>,
  unresolved: Set<string>,
): string =>
  value.replace(ENV_REF, (match: string, name: string) => {
    if (Object.hasOwn(values, name)) {
      return values[name];
    }
    if ((RUN_PLACEHOLDERS as readonly string[]).includes(name)) {
      unresolved.add(name);
    }
    return match;
  });

/** Resolves one capability's arguments: run placeholders first, environment second. */
const resolveArgs = (
  capability: CapabilityId,
  args: CapabilityArgs,
  target: RunTarget,
  file: string,
  unresolved: Set<string>,
): CapabilityArgs => {
  const values = runPlaceholders(target);
  const strings: Record<string, string> = {};
  const literals: CapabilityArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      strings[key] = fillRunPlaceholders(value, values, unresolved);
    } else {
      literals[key] = value;
    }
  }
  if (unresolved.size > 0) {
    // Nothing is expanded from the environment either: the binding is off, not half-built.
    return {};
  }
  return {
    ...literals,
    ...expandEnvRefs(strings, file, `capabilities.${capability}.args`),
  };
};

/**
 * Binds one capability, or reports that this target mode cannot use it. A missing SERVER
 * is a config error; a placeholder this mode has no value for is a degradation.
 */
const bindCapability = (
  capability: CapabilityId,
  declared: CapabilityBindingSpec,
  servers: Record<string, McpServerConfig>,
  target: RunTarget,
  file: string,
): CapabilityBinding | string => {
  const ref = typeof declared === "string" ? declared : declared.tool;
  const args = typeof declared === "string" ? {} : declared.args;
  const dot = ref.indexOf(".");
  const server = ref.slice(0, dot);
  const tool = ref.slice(dot + 1);
  if (!Object.hasOwn(servers, server)) {
    throw new ConfigError(
      `${file}: capability "${capability}" maps to server "${server}", which is not declared`,
      {
        file,
        hint: `declare "${server}" under servers:, or point the capability at one of: ${Object.keys(servers).join(", ")}`,
      },
    );
  }
  const unresolved = new Set<string>();
  const resolved = resolveArgs(capability, args, target, file, unresolved);
  if (unresolved.size > 0) {
    return `its arguments need ${[...unresolved].map((name) => `\${${name}}`).join(", ")}, which a ${target.mode} run has no value for`;
  }
  return { capability, server, tool, args: resolved };
};

/**
 * Resolves the capability map, then holds it to two contracts: paired capabilities are
 * mapped together, and whatever this target mode cannot run without is present.
 */
const bindCapabilities = (
  mcp: McpConfig,
  target: RunTarget,
  file: string,
  degradations: ConfigDegradation[],
): CapabilityBindings => {
  const bindings: CapabilityBindings = {};
  /** Capabilities this TARGET MODE cannot use — mapped correctly, just not for this run. */
  const modeOff = new Set<CapabilityId>();
  for (const capability of CAPABILITY_IDS) {
    const ref = mcp.capabilities[capability];
    if (ref === undefined) {
      degradations.push({
        what: capability,
        reason: `not mapped in ${file}`,
      });
      continue;
    }
    const bound = bindCapability(capability, ref, mcp.servers, target, file);
    if (typeof bound === "string") {
      degradations.push({ what: capability, reason: bound });
      modeOff.add(capability);
      continue;
    }
    bindings[capability] = bound;
  }

  for (const capability of CAPABILITY_IDS) {
    if (bindings[capability] === undefined) {
      continue;
    }
    for (const pair of CAPABILITIES[capability].requires) {
      if (bindings[pair] !== undefined) {
        continue;
      }
      // A pair this MODE cannot use takes its dependant with it, quietly: the map is
      // correct, it is just written for a target this run is not reviewing.
      if (modeOff.has(pair)) {
        delete bindings[capability];
        modeOff.add(capability);
        degradations.push({
          what: capability,
          reason: `needs "${pair}", which a ${target.mode} run cannot use`,
        });
        break;
      }
      throw new ConfigError(
        `${file}: capability "${capability}" is mapped but its pair "${pair}" is not`,
        {
          file,
          hint: `map "${pair}" as well — posting without reading means findings cannot be deduped by marker — or drop "${capability}"`,
        },
      );
    }
  }

  const missing = requiredCapabilitiesFor(target).filter(
    (capability) => bindings[capability] === undefined,
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `${file}: a ${target.mode} run needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not mapped`,
      {
        file,
        hint: `add ${missing.map((id) => `${id}: <server>.<tool>`).join(", ")} under capabilities:`,
      },
    );
  }

  return bindings;
};

/**
 * What Delivery can actually do, as opposed to what config asked for (TASKS:Y3.5).
 *
 * Two things can switch an action off, and both are degradations rather than errors: the
 * run has no platform to deliver to (local and branch runs stop at collate), or the
 * capability that performs it is not mapped. Everything that is off says so by name, so a
 * reader of the run report knows what was NOT posted and why.
 */
export const resolveDeliveryActions = (
  delivery: DeliveryConfig,
  capabilities: CapabilityBindings,
  target: RunTarget,
  file: string,
  degradations: ConfigDegradation[],
): DeliveryAction[] => {
  const asked = DELIVERY_ACTIONS.filter((action) => delivery[action]);
  if (target.mode !== "pr") {
    for (const action of asked) {
      degradations.push({
        what: `delivery.${action}`,
        reason: `a ${target.mode} run has no pull request to deliver to — it stops after collate`,
      });
    }
    return [];
  }
  return asked.filter((action) => {
    const capability = DELIVERY_CAPABILITIES[action];
    if (capabilities[capability] !== undefined) {
      return true;
    }
    degradations.push({
      what: `delivery.${action}`,
      reason: `capability "${capability}" is not mapped in ${file}`,
    });
    return false;
  });
};

/* --------------------------------------------------------------- optional bits */

const loadChecks = async (
  file: string,
  degradations: ConfigDegradation[],
): Promise<ChecksConfig | undefined> => {
  const raw = await readYaml(file);
  if (raw === undefined) {
    degradations.push({ what: "checks", reason: `no ${file}` });
    return undefined;
  }
  return parseOrThrow(ChecksConfigSchema, raw, file);
};

const loadRulebook = async (
  dir: string,
  degradations: ConfigDegradation[],
): Promise<RulebookLayout | undefined> => {
  if (!(await pathExists(dir, "dir"))) {
    degradations.push({ what: "rulebook", reason: `no ${dir}` });
    return undefined;
  }
  for (const candidate of RULEBOOK_INDEX_CANDIDATES) {
    const path = join(dir, candidate);
    if (await pathExists(path, "file")) {
      return { dir, index: path };
    }
  }
  degradations.push({
    what: "rulebook.index",
    reason: `no ${RULEBOOK_INDEX_CANDIDATES.join(" / ")} in ${dir} — WarmUp reads the directory unguided`,
  });
  return { dir };
};

/* ---------------------------------------------------------------------- entry */

/** Loads and validates `.yama/` for one run, applying the degradation matrix. */
export const loadConfig = async (
  root: string,
  target: RunTarget,
): Promise<ResolvedConfig> => {
  const paths = resolveConfigPaths(root);
  if (!(await pathExists(paths.dir, "dir"))) {
    throw new ConfigError(`no config directory at ${paths.dir}`, {
      hint: "run `yama init` in the repository root, or pass the root that holds .yama/",
    });
  }

  const degradations: ConfigDegradation[] = [];

  const rawYama = await readYaml(paths.yamaFile);
  if (rawYama === undefined) {
    throw new ConfigError(`${paths.yamaFile} is required and does not exist`, {
      file: paths.yamaFile,
      hint: "run `yama init` to scaffold it — it declares the model fallback chains",
    });
  }
  const yama = parseOrThrow(YamaConfigSchema, rawYama, paths.yamaFile);

  const rawMcp = await readYaml(paths.mcpFile);
  if (rawMcp === undefined) {
    throw new ConfigError(`${paths.mcpFile} is required and does not exist`, {
      file: paths.mcpFile,
      hint: "run `yama init` to scaffold it — it declares the MCP servers and the capability map",
    });
  }
  assertKnownCapabilities(rawMcp, paths.mcpFile);
  // Server secrets are expanded when a server is CONNECTED, not here: a local review must
  // not fail because the token for a platform it never talks to is unset (`config/env.ts`).
  const mcp: McpConfig = parseOrThrow(McpConfigSchema, rawMcp, paths.mcpFile);

  const capabilities = bindCapabilities(
    mcp,
    target,
    paths.mcpFile,
    degradations,
  );
  const deliveryActions = resolveDeliveryActions(
    yama.delivery,
    capabilities,
    target,
    paths.mcpFile,
    degradations,
  );
  const checks = await loadChecks(paths.checksFile, degradations);
  const rulebook = await loadRulebook(paths.rulebookDir, degradations);

  const hasMemory = await pathExists(paths.memoryDir, "dir");
  if (!hasMemory) {
    degradations.push({ what: "memory", reason: `no ${paths.memoryDir}` });
  }

  return {
    paths,
    yama,
    mcp,
    ...(checks ? { checks } : {}),
    chains: resolveModelChains(yama.models, paths.yamaFile),
    capabilities,
    deliveryActions,
    ...(rulebook ? { rulebook } : {}),
    ...(hasMemory ? { memoryDir: paths.memoryDir } : {}),
    degradations,
  };
};
