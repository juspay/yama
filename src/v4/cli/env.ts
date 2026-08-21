/**
 * Loading `.env`, and the reason it is conditional.
 *
 * A developer running Yama locally expects `.env` to work. A CI job must not
 * read it: in CI the checkout is the pull request, which on a fork is written by
 * someone outside the team. A `.env` committed by that pull request could
 * redirect `LITELLM_BASE_URL` to a host they control and collect the API key on
 * the first model call.
 *
 * So: load it locally, never in CI, and never override a variable the
 * environment already set — a real secret always beats a file in the checkout.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvLoadResult } from "../types/index.js";

/** Standard CI markers. Any one of them means "do not read the checkout". */
const CI_MARKERS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BITBUCKET_BUILD_NUMBER",
  "JENKINS_URL",
  "BUILDKITE",
  "CIRCLECI",
  "TEAMCITY_VERSION",
];

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_MARKERS.some((marker) => {
    const value = env[marker];
    return (
      value !== undefined && value !== "" && value !== "false" && value !== "0"
    );
  });
}

/** Parse `.env` contents. Tolerant of comments, blank lines, and quotes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

/**
 * Apply `.env` to the process environment when it is safe to do so.
 *
 * Returns names, never values, so a caller can report what happened without
 * risking a secret in a log.
 */
export function loadLocalEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvLoadResult {
  if (isCI(env)) {
    return {
      loaded: false,
      applied: [],
      reason:
        "Running in CI: .env is not read. The checkout is the pull request, and on a " +
        "fork it is written by someone outside the team. Credentials come from the " +
        "CI secret store.",
    };
  }

  const path = join(projectRoot, ".env");
  if (!existsSync(path)) {
    return { loaded: false, applied: [], reason: "No .env file." };
  }

  const applied: string[] = [];
  try {
    for (const [key, value] of Object.entries(
      parseEnvFile(readFileSync(path, "utf-8")),
    )) {
      // An already-set variable wins. A real secret must never be shadowed by a
      // file in the working tree.
      if (env[key] === undefined) {
        env[key] = value;
        applied.push(key);
      }
    }
  } catch (error) {
    return {
      loaded: false,
      applied,
      reason: `Could not read ${path}: ${(error as Error).message}`,
    };
  }

  return { loaded: true, applied };
}
