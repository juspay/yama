/**
 * Config loader — turns the `.yama/` file tree into one {@link ResolvedConfig}.
 *
 * Layering, lowest precedence first:
 *
 *   defaults  <  extends: (org baseline)  <  local .yama/ files  <  env  <  SDK overrides
 *
 * Two properties this file is responsible for:
 *
 *  1. **Optionality is total.** Only `yama.yaml` and `mcp.yaml` must exist. Every
 *     other file resolves to a no-op default, so consumers never test for
 *     presence.
 *  2. **v3 configs keep working.** A single-file `yama.config.yaml` is adapted
 *     into the v4 shape and reported once, rather than failing. Keys v3 exposed
 *     but never read are accepted and listed as inert.
 *
 * Nothing here reads secrets: `${VAR}` placeholders are substituted from the
 * environment at the point of use, and the substituted values are never logged.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYAML } from "yaml";
import type {
  ConfigNotice,
  GuardRule,
  ImpactLogEntry,
  LoadOptions,
  McpFile,
  OwnershipRule,
  ProductCapability,
  ResolvedConfig,
  ReviewFile,
  RuleEntry,
  YamaFile,
} from "../types/index.js";
import { DEAD_V3_KEYS, optionalDefaults } from "./defaults.js";
import {
  checksFileSchema,
  formatIssues,
  guardsFileSchema,
  impactLogEntrySchema,
  mcpFileSchema,
  ownershipFileSchema,
  productCapabilityFileSchema,
  reviewFileSchema,
  rulesFileSchema,
  yamaFileSchema,
} from "./schema.js";
import { adaptV3Config, findV3ConfigPath } from "./v3Compat.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const YAMA_DIR = ".yama";

/** Read + parse a YAML file, or return undefined when it does not exist. */
async function readYaml(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = await readFile(path, "utf-8");
  try {
    return parseYAML(raw);
  } catch (error) {
    throw new ConfigError(
      `${path} is not valid YAML: ${(error as Error).message}`,
    );
  }
}

/** Validate a parsed document, or throw with the file name and the failing path. */
function validate<T>(
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: unknown;
      error?: unknown;
    };
  },
  value: unknown,
  file: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(
      formatIssues(result.error as Parameters<typeof formatIssues>[0], file),
    );
  }
  return result.data as T;
}

/**
 * Merge two plain objects recursively.
 *
 * Arrays REPLACE rather than concatenate. Concatenating would make an inherited
 * baseline impossible to narrow — a repo could add to the org's exclude list but
 * never remove from it — and silent accumulation across layers is exactly the
 * kind of surprise config should not have.
 */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) {
    return base;
  }
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof override !== "object" ||
    Array.isArray(override)
  ) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(
    override as Record<string, unknown>,
  )) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/**
 * Read the generated product model.
 *
 * Both halves are optional and both degrade to empty rather than to an error:
 * a repository that has never run `bootstrap` has no map, and that is the
 * documented "impact analysis falls back to caller tracing" state, not a
 * misconfiguration. A malformed file IS reported, because a capability map that
 * silently matches nothing looks exactly like one that was never written.
 */
async function loadProduct(
  dir: string,
  notices: ConfigNotice[],
): Promise<{ capabilities: ProductCapability[]; impactLog: ImpactLogEntry[] }> {
  const capabilities: ProductCapability[] = [];
  const impactLog: ImpactLogEntry[] = [];

  if (!existsSync(dir)) {
    return { capabilities, impactLog };
  }

  const mapRaw = await readYaml(join(dir, "capabilities.yaml"));
  if (mapRaw) {
    const parsed = productCapabilityFileSchema.safeParse(mapRaw);
    if (parsed.success) {
      capabilities.push(...(parsed.data.capabilities as ProductCapability[]));
    } else {
      notices.push({
        level: "warn",
        message: formatIssues(parsed.error, join(dir, "capabilities.yaml")),
      });
    }
  }

  const logDir = join(dir, "impact-log");
  if (existsSync(logDir)) {
    for (const name of await readdir(logDir)) {
      if (!/\.(ya?ml|json)$/i.test(name)) {
        continue;
      }
      const path = join(logDir, name);
      const raw = await readYaml(path);
      const parsed = impactLogEntrySchema.safeParse(raw);
      if (!parsed.success) {
        notices.push({
          level: "warn",
          message: formatIssues(parsed.error, path),
        });
        continue;
      }
      const entry = parsed.data;
      impactLog.push({
        pullRequestId: entry.pullRequestId,
        // `at` is what the writer emits; `mergedAt` is the declared field. Both
        // are accepted so a ledger written by an earlier version still reads.
        mergedAt: entry.mergedAt ?? entry.at ?? "",
        capabilities: entry.capabilities,
        changeKind: entry.changeKind ?? "internal",
        summary: entry.summary || entry.title || "",
        ...(entry.userVisibleEffect
          ? { userVisibleEffect: entry.userVisibleEffect }
          : {}),
        ...(entry.risk ? { risk: entry.risk } : {}),
        ...(entry.testedBy ? { testedBy: entry.testedBy } : {}),
        ...(entry.laterCorrectedBy
          ? { laterCorrectedBy: entry.laterCorrectedBy }
          : {}),
        ...(entry.corrects ? { corrects: entry.corrects } : {}),
      });
    }
  }

  return { capabilities, impactLog };
}

/** Collect every rule file under `.yama/rules/**`, newest-wins on duplicate ids. */
async function loadRules(
  dir: string,
  notices: ConfigNotice[],
): Promise<RuleEntry[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const byId = new Map<string, RuleEntry>();
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!/\.(ya?ml|json)$/i.test(entry.name)) {
        continue;
      }
      let parsed: unknown;
      try {
        const raw = await readFile(path, "utf-8");
        parsed = entry.name.toLowerCase().endsWith(".json")
          ? JSON.parse(raw)
          : parseYAML(raw);
      } catch (error) {
        // One malformed rule file must not take down the review, but it must
        // never pass unnoticed either — a silently skipped rule reads to the
        // team as a rule that simply does not work.
        notices.push({
          level: "warn",
          message: `Skipped rule file ${path}: ${(error as Error).message}`,
        });
        continue;
      }
      const result = rulesFileSchema.safeParse(parsed);
      if (!result.success) {
        notices.push({
          level: "warn",
          message: formatIssues(result.error, path),
        });
        continue;
      }
      const rules = "rules" in result.data ? result.data.rules : [result.data];
      for (const rule of rules as RuleEntry[]) {
        if (byId.has(rule.id)) {
          notices.push({
            level: "warn",
            message: `Duplicate rule id "${rule.id}" — ${path} overrides the earlier definition.`,
          });
        }
        byId.set(rule.id, rule);
      }
    }
  };
  await walk(dir);
  return [...byId.values()];
}

/** Report v3 keys that are accepted but inert, so nobody trusts them. */
function noticeDeadKeys(raw: unknown, notices: ConfigNotice[]): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const present = DEAD_V3_KEYS.filter((key) => {
    let cursor: unknown = raw;
    for (const part of key.split(".")) {
      if (!cursor || typeof cursor !== "object") {
        return false;
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor !== undefined;
  });
  if (present.length > 0) {
    notices.push({
      level: "warn",
      message:
        `These keys are accepted but no longer read: ${present.join(", ")}. ` +
        `Remove them — they tune nothing.`,
    });
  }
}

/**
 * Load and resolve the whole config tree.
 *
 * @throws ConfigError when a required file is missing or any file is malformed.
 *         Malformed *optional* files degrade to a notice instead, because losing
 *         one rule file should not cost the team its whole review.
 */
export async function loadConfig(
  options: LoadOptions = {},
): Promise<ResolvedConfig> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const notices: ConfigNotice[] = [];

  const explicit = options.configPath
    ? isAbsolute(options.configPath)
      ? options.configPath
      : join(projectRoot, options.configPath)
    : undefined;

  const yamaDir =
    explicit && !/\.(ya?ml|json)$/i.test(explicit)
      ? explicit
      : join(projectRoot, YAMA_DIR);

  const v4Present = existsSync(join(yamaDir, "yama.yaml"));
  const v3Path =
    explicit && /\.(ya?ml|json)$/i.test(explicit)
      ? explicit
      : v4Present
        ? undefined
        : findV3ConfigPath(projectRoot);

  let yamaRaw: unknown;
  let mcpRaw: unknown;
  let reviewRaw: unknown;
  let checksRaw: unknown;

  if (v3Path) {
    const legacy = await readYaml(v3Path);
    if (!legacy) {
      throw new ConfigError(`No configuration found at ${v3Path}.`);
    }
    noticeDeadKeys(legacy, notices);
    const adapted = adaptV3Config(legacy);
    yamaRaw = adapted.yama;
    mcpRaw = adapted.mcp;
    reviewRaw = adapted.review;
    checksRaw = adapted.checks;
    notices.push({
      level: "warn",
      message:
        `Loaded a v3 configuration from ${v3Path}. It works as-is, but ` +
        `\`yama migrate\` will split it into .yama/*.yaml and print what moved where.`,
    });
    notices.push(...adapted.notices);
  } else {
    yamaRaw = await readYaml(join(yamaDir, "yama.yaml"));
    mcpRaw = await readYaml(join(yamaDir, "mcp.yaml"));
    reviewRaw = await readYaml(join(yamaDir, "review.yaml"));
    checksRaw = await readYaml(join(yamaDir, "checks.yaml"));
  }

  if (!yamaRaw) {
    throw new ConfigError(
      `No configuration found. Expected ${join(yamaDir, "yama.yaml")} ` +
        `(or a legacy yama.config.yaml). Run \`yama init\` to create one.`,
    );
  }
  if (!mcpRaw) {
    throw new ConfigError(
      `No connections configured. Expected ${join(yamaDir, "mcp.yaml")}. ` +
        `Yama cannot read a pull request without at least one server. Run \`yama init\`.`,
    );
  }

  const yamaFile = validate<YamaFile>(yamaFileSchema, yamaRaw, "yama.yaml");
  const mcpFile = validate<McpFile>(mcpFileSchema, mcpRaw, "mcp.yaml");
  const reviewFile = reviewRaw
    ? validate<ReviewFile>(reviewFileSchema, reviewRaw, "review.yaml")
    : undefined;
  const checksFile = checksRaw
    ? validate<{ enabled?: boolean; allowForks?: boolean; checks: unknown[] }>(
        checksFileSchema,
        checksRaw,
        "checks.yaml",
      )
    : undefined;

  const ownershipRaw = await readYaml(
    join(yamaDir, "policy", "ownership.yaml"),
  );
  const ownership = ownershipRaw
    ? validate<{ rules: OwnershipRule[] }>(
        ownershipFileSchema,
        ownershipRaw,
        "policy/ownership.yaml",
      ).rules
    : [];

  const guardsRaw = await readYaml(join(yamaDir, "policy", "guards.yaml"));
  const guards = guardsRaw
    ? validate<{ guards: GuardRule[] }>(
        guardsFileSchema,
        guardsRaw,
        "policy/guards.yaml",
      ).guards
    : [];

  const rules = await loadRules(join(yamaDir, "rules"), notices);
  const product = await loadProduct(join(yamaDir, "product"), notices);

  // `extends:` is accepted by the schema and implemented by nothing. Left
  // silent it is the worst kind of config key: a team writes it, the org
  // baseline never loads, and every review runs on defaults while the file says
  // otherwise. Reported until it is either implemented or removed.
  if (yamaFile.extends) {
    notices.push({
      level: "warn",
      message:
        `\`extends: ${yamaFile.extends}\` is not implemented — nothing is inherited ` +
        `from it, and this run uses only the files in this repository. Copy what you ` +
        `need from the baseline into .yama/ until it is supported.`,
    });
  }

  const defaults = optionalDefaults();

  let resolved: ResolvedConfig = {
    version: 4,
    ai: yamaFile.ai,
    learn: deepMerge(defaults.learn, yamaFile.learn),
    state: deepMerge(defaults.state, yamaFile.state),
    observability: deepMerge(defaults.observability, yamaFile.observability),
    prompts: deepMerge(defaults.prompts, yamaFile.prompts),
    mcp: mcpFile,
    review: deepMerge(defaults.review, reviewFile),
    checks: deepMerge(defaults.checks, checksFile),
    ownership,
    guards,
    rules,
    product: product.capabilities,
    impactLog: product.impactLog,
    projectRoot,
    notices,
  };

  resolved = applyEnvOverrides(resolved, options.env ?? process.env);

  if (options.overrides) {
    resolved = deepMerge(resolved, options.overrides);
  }

  // Notices accumulate across layers; re-attach after merges so an override
  // object without a `notices` key cannot erase them.
  resolved.notices = notices;
  return resolved;
}

/**
 * Environment overrides.
 *
 * Deliberately narrow: only the knobs a CI operator legitimately flips per run.
 * Anything that changes review semantics (rules, ownership, guards) stays in the
 * repo where it is reviewable — an env var that could silently relax a blocking
 * rule would be a policy hole.
 */
function applyEnvOverrides(
  config: ResolvedConfig,
  env: NodeJS.ProcessEnv,
): ResolvedConfig {
  const next = { ...config };

  const power = env.YAMA_CONCURRENCY?.toLowerCase();
  if (power === "high" || power === "medium" || power === "low") {
    next.review = {
      ...next.review,
      concurrency: { power },
    };
  }

  if (env.YAMA_VERDICT === "false" || env.YAMA_VERDICT === "0") {
    next.review = {
      ...next.review,
      verdict: { ...next.review.verdict, enabled: false },
    };
  }

  if (env.YAMA_CHECKS === "false" || env.YAMA_CHECKS === "0") {
    next.checks = { ...next.checks, enabled: false };
  }

  // `Number("")` is 0, and a CI variable that is set-but-empty is common —
  // without the trim guard, an empty YAMA_CONFIDENCE_THRESHOLD silently set
  // the threshold to 0 and turned the inline judge off for every run.
  const rawThreshold = (env.YAMA_CONFIDENCE_THRESHOLD ?? "").trim();
  const threshold = rawThreshold === "" ? Number.NaN : Number(rawThreshold);
  if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 100) {
    next.review = { ...next.review, confidenceThreshold: threshold };
  }

  return next;
}

/** Substitute `${VAR}` placeholders. Unresolved placeholders are left intact so
 *  the connection layer can report them precisely rather than sending "". */
export function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (match, name: string) => env[name] ?? match,
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnv(item, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = substituteEnv(item, env);
    }
    return out as unknown as T;
  }
  return value;
}
