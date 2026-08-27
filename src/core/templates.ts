/**
 * Where the `.yama/` templates live, and where each one lands (TASKS:Y6.2, Y6.3).
 *
 * They ship as files rather than as string constants on purpose: an operator reads and
 * edits the scaffolded config, and a template that has to survive being a TypeScript
 * string literal stops being readable long before it stops being correct.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, CONFIG_FILES } from "../config/index.js";
import type { InitPlatform } from "../types/index.js";

/**
 * The package's `templates/` directory. Resolved from this module, so it works the same
 * from `dist/core/` in a published install as it does from a checkout.
 */
export const templatesDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

/** Where the CI recipes are scaffolded — examples to copy, not live pipelines. */
export const CI_DIR = `${CONFIG_DIR}/ci`;

/**
 * Template file → destination, relative to the repository root. The capability map is
 * chosen by platform; everything else is the same for every repository.
 */
export const templateManifest = (
  platform: InitPlatform,
): { from: string; to: string }[] => [
  { from: "yama.yaml", to: `${CONFIG_DIR}/${CONFIG_FILES.yama}` },
  {
    from: platform === "none" ? "mcp.github.yaml" : `mcp.${platform}.yaml`,
    to: `${CONFIG_DIR}/${CONFIG_FILES.mcp}`,
  },
  { from: "checks.yaml", to: `${CONFIG_DIR}/${CONFIG_FILES.checks}` },
  {
    from: join("rulebook", "index.md"),
    to: `${CONFIG_DIR}/${CONFIG_FILES.rulebook}/index.md`,
  },
  {
    from: join("memory", "README.md"),
    to: `${CONFIG_DIR}/${CONFIG_FILES.memory}/README.md`,
  },
  {
    from: join("ci", "github-actions.yml"),
    to: `${CI_DIR}/github-actions.yml`,
  },
  { from: join("ci", "Jenkinsfile"), to: `${CI_DIR}/Jenkinsfile` },
];
