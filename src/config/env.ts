/**
 * `${VAR}` expansion for `.yama/mcp.yaml` (TASKS:Y1.2).
 *
 * Only env values and headers are expanded — the two places a secret belongs. URLs are
 * deliberately left alone: credentials never go in a URL (TASKS:Y7.2 hygiene).
 *
 * Server expansion happens at CONNECT time, not at load time, and that placement is the
 * point: a local review never connects the pull-request platform, and it must not fail
 * because the token for a server it will not start is unset. A server whose variables are
 * missing fails to connect, is named as such, and costs only the capabilities behind it.
 */
import type { McpServerConfig } from "../types/index.js";
import { ConfigError } from "./errors.js";

/** `${NAME}` — an environment variable, or one of the run placeholders the loader fills. */
export const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expands `${VAR}` in a record of strings, loudly naming anything unset. */
export const expandEnvRefs = (
  values: Record<string, string>,
  file: string,
  where: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(ENV_REF, (_match: string, name: string) => {
        const found = process.env[name];
        if (found === undefined) {
          throw new ConfigError(
            `${file}: ${where}.${key} references \${${name}}, which is not set in the environment`,
            { file, hint: `export ${name} before running yama` },
          );
        }
        return found;
      }),
    ]),
  );

/** One server declaration with its secrets filled in. Throws when one is missing. */
export const expandServer = (
  id: string,
  server: McpServerConfig,
  file: string,
): McpServerConfig =>
  server.transport === "stdio"
    ? { ...server, env: expandEnvRefs(server.env, file, `servers.${id}.env`) }
    : {
        ...server,
        headers: expandEnvRefs(server.headers, file, `servers.${id}.headers`),
      };
