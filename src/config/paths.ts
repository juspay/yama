import { join, resolve } from "node:path";
// Needs `export * from "./config.js"` in src/types/index.ts (barrel line owned by the
// integrate step of TASKS:Y1.1) — internal types are barrel-only imports (NeuroLink rule 13).
import type { ConfigPaths } from "../types/index.js";

/** Consumer-repo config directory, per PLAN.md section 4. */
export const CONFIG_DIR = ".yama";

/** Entries inside `.yama/`. Absent optional pieces mean the capability is off, never broken. */
export const CONFIG_FILES = {
  yama: "yama.yaml",
  mcp: "mcp.yaml",
  checks: "checks.yaml",
  rulebook: "rulebook",
  memory: "memory",
  artifacts: "artifacts",
} as const;

/** Rulebook index file, in preference order — WarmUp reads the index first (TASKS:Y3.1). */
export const RULEBOOK_INDEX_CANDIDATES = [
  "index.md",
  "index.yaml",
  "README.md",
] as const;

/** Absolute locations of every `.yama/` entry for one repository root. */
export const resolveConfigPaths = (root: string): ConfigPaths => {
  const repoRoot = resolve(root);
  const dir = join(repoRoot, CONFIG_DIR);
  return {
    root: repoRoot,
    dir,
    yamaFile: join(dir, CONFIG_FILES.yama),
    mcpFile: join(dir, CONFIG_FILES.mcp),
    checksFile: join(dir, CONFIG_FILES.checks),
    rulebookDir: join(dir, CONFIG_FILES.rulebook),
    memoryDir: join(dir, CONFIG_FILES.memory),
    artifactsDir: join(dir, CONFIG_FILES.artifacts),
  };
};
