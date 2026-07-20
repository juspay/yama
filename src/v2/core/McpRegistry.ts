/**
 * McpRegistry — external, declarative MCP server configuration.
 *
 * Loads MCP server definitions from the project's `.yama/` directory instead of
 * hardcoding them: `.yama/mcp.json` (and optionally `.yama/mcp.d/*.json`, merged
 * in filename order) using NeuroLink's `mcpServers` schema. This is what lets a
 * project add an MCP server (code-intelligence, a custom tool server, an updated
 * Bitbucket binary) by editing config rather than changing Yama's code.
 *
 * `${ENV_VAR}` placeholders in `args`, `env`, `headers`, and `url` are
 * substituted from the environment at load time, so secrets stay in the
 * environment and never in the committed config file.
 *
 * Parsing and substitution are pure/static so they can be unit-tested without
 * touching the filesystem or the environment.
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { McpConfigFile, McpServerDefinition } from "../types/index.js";

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

export class McpRegistry {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  /**
   * Trust gate for project-level MCP config. `.yama/mcp.json` lives in the
   * repository checkout being reviewed, which in CI is ATTACKER-CONTROLLED — a
   * PR could add a server whose `command` is `bash …`, and NeuroLink launches
   * it (inheriting the job's secrets) at registration, before the model runs.
   * Loading it is therefore OFF by default and must be explicitly enabled by a
   * TRUSTED operator via this env var — which is set outside the checkout, so a
   * PR cannot flip it. Enable it only where the checked-out repo is trusted.
   */
  static readonly ENABLE_ENV = "YAMA_ENABLE_PROJECT_MCP";

  static isProjectMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = env[McpRegistry.ENABLE_ENV];
    return value === "true" || value === "1";
  }

  /**
   * Load and env-substitute all server definitions from `.yama/mcp.json` and
   * `.yama/mcp.d/*.json`. Returns an empty map unless project MCP is explicitly
   * enabled (see {@link isProjectMcpEnabled}) or when no config files exist, so
   * the safe default is the main-config servers only. Callers merge the result
   * OVER `mcpServers.servers` (same id = override, including bitbucket/github).
   *
   * Later sources win on key conflicts: `.yama/mcp.d/*.json` (filename order)
   * override `.yama/mcp.json`.
   */
  async load(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Record<string, McpServerDefinition>> {
    if (!McpRegistry.isProjectMcpEnabled(env)) {
      return {};
    }

    const merged: Record<string, McpServerDefinition> = {};

    const base = await this.readConfigFile(
      join(this.projectRoot, ".yama", "mcp.json"),
    );
    Object.assign(merged, base);

    const dropInDir = join(this.projectRoot, ".yama", "mcp.d");
    for (const file of await this.listJsonFiles(dropInDir)) {
      const part = await this.readConfigFile(join(dropInDir, file));
      Object.assign(merged, part);
    }

    // Surface unresolved `${VAR}` placeholders (missing env vars) — otherwise a
    // typo or missing secret silently substitutes an empty value and the server
    // starts misconfigured. Scans the RAW definitions (placeholders intact).
    const missing = McpRegistry.findMissingEnvVars(merged, env);
    if (missing.length > 0) {
      console.warn(
        `⚠️  .yama/mcp.json references undefined environment variable(s): ` +
          `${missing.join(", ")} — these substituted to empty strings.`,
      );
    }

    // Validate AFTER substitution so structural checks see the values a server
    // would actually be registered with: `command: "${MISSING_BIN}"` is a
    // non-empty literal before substitution but an empty command after it, and
    // must fail closed here rather than register a broken server.
    const substituted = McpRegistry.substituteAll(merged, env);
    McpRegistry.validate(substituted);

    return substituted;
  }

  /**
   * Validate transport-specific required fields for each definition. stdio
   * servers need a `command`; http/sse/websocket servers need a `url`. Throws a
   * clear error naming the offending server id.
   */
  static validate(definitions: Record<string, McpServerDefinition>): void {
    for (const [id, def] of Object.entries(definitions)) {
      if (def.enabled === false) {
        continue;
      }
      const transport = def.transport ?? (def.url ? "http" : "stdio");
      if (transport === "stdio") {
        if (!def.command?.trim()) {
          throw new Error(
            `Invalid MCP server "${id}": transport "stdio" requires a non-empty "command" ` +
              `(an empty value here usually means a \${VAR} placeholder resolved to nothing).`,
          );
        }
      } else if (!def.url?.trim()) {
        throw new Error(
          `Invalid MCP server "${id}": transport "${transport}" requires a non-empty "url" ` +
            `(an empty value here usually means a \${VAR} placeholder resolved to nothing).`,
        );
      }
    }
  }

  /** Env var names referenced via `${VAR}` in the definitions but absent from `env`. */
  static findMissingEnvVars(
    definitions: Record<string, McpServerDefinition>,
    env: NodeJS.ProcessEnv,
  ): string[] {
    const missing = new Set<string>();
    const scan = (value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(ENV_PLACEHOLDER)) {
          if (env[match[1]] === undefined) {
            missing.add(match[1]);
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach(scan);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(scan);
      }
    };
    scan(definitions);
    return Array.from(missing);
  }

  // ---- pure helpers (unit-testable) ----------------------------------------

  /** Replace every `${VAR}` in a string with `env[VAR]` (missing → empty). */
  static substituteString(value: string, env: NodeJS.ProcessEnv): string {
    return value.replace(ENV_PLACEHOLDER, (_match, name: string) => {
      const resolved = env[name];
      return resolved === undefined ? "" : resolved;
    });
  }

  /**
   * Apply `${ENV}` substitution across a single server definition. The walk is
   * deep so nested pass-through options (`auth.bearer.token`,
   * `httpOptions.*`, future NeuroLink keys) resolve placeholders the same way
   * `args`/`env`/`headers`/`url` always have.
   */
  static substituteDefinition(
    def: McpServerDefinition,
    env: NodeJS.ProcessEnv,
  ): McpServerDefinition {
    const sub = (value: unknown): unknown => {
      if (typeof value === "string") {
        return McpRegistry.substituteString(value, env);
      }
      if (Array.isArray(value)) {
        return value.map(sub);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, sub(v)]),
        );
      }
      return value;
    };
    return sub(def) as McpServerDefinition;
  }

  /** Apply `${ENV}` substitution across an entire definitions map. */
  static substituteAll(
    definitions: Record<string, McpServerDefinition>,
    env: NodeJS.ProcessEnv,
  ): Record<string, McpServerDefinition> {
    return Object.fromEntries(
      Object.entries(definitions).map(([id, def]) => [
        id,
        McpRegistry.substituteDefinition(def, env),
      ]),
    );
  }

  /** Parse a raw JSON string into a definitions map, tolerating an absent file. */
  static parse(raw: string): Record<string, McpServerDefinition> {
    const doc = JSON.parse(raw) as Partial<McpConfigFile>;
    if (!doc || typeof doc !== "object" || !doc.mcpServers) {
      return {};
    }
    return doc.mcpServers;
  }

  // ---- filesystem (isolated so the pure helpers stay testable) -------------

  private async readConfigFile(
    path: string,
  ): Promise<Record<string, McpServerDefinition>> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (error) {
      // A genuinely absent file is the common zero-config case; any other I/O
      // error (permissions, etc.) is surfaced rather than silently swallowed so
      // a misconfiguration cannot quietly degrade the review to fewer tools.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new Error(
        `Failed to read MCP config at ${path}: ${(error as Error).message}`,
      );
    }
    try {
      return McpRegistry.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid MCP config at ${path}: ${(error as Error).message}`,
      );
    }
  }

  private async listJsonFiles(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir);
      return entries.filter((f) => f.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return []; // no drop-in directory — fine
      }
      throw new Error(
        `Failed to read MCP config directory ${dir}: ${(error as Error).message}`,
      );
    }
  }
}
