/**
 * v3 → v4 config adaptation.
 *
 * A v3 single-file config keeps working forever. This module maps it onto the v4
 * file shapes in memory; `yama migrate` uses the same mapping to write the split
 * files to disk, so the two can never drift.
 *
 * What v3 expressed as PROMPT TEXT becomes something else in v4:
 *   - `review.focusAreas` and `workflowInstructions` were concatenated into the
 *     prompt. v4 has no prompt assembly, so they are reported as content to move
 *     into `.yama/knowledge/`, not silently dropped and not silently injected.
 *   - `review.excludePatterns` was advice to the model. v4 enforces it in code.
 *   - `review.blockingCriteria` becomes guard policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AdaptedV3, ConfigNotice } from "../types/index.js";

/** Locations a v3 config was allowed to live in, in discovery order. */
const V3_CANDIDATES = [
  ".yama/config.yaml",
  "yama.config.yaml",
  "yama.config.yml",
  ".yama.yaml",
];

export function findV3ConfigPath(projectRoot: string): string | undefined {
  for (const candidate of V3_CANDIDATES) {
    const path = join(projectRoot, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

type Legacy = Record<string, unknown>;

const get = (source: Legacy, path: string): unknown => {
  let cursor: unknown = source;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Legacy)[part];
  }
  return cursor;
};

/**
 * Infer a capability map from well-known tool names per server id.
 *
 * Best-effort convenience, never a guarantee: anything it cannot infer is left
 * absent so the startup capability probe reports it precisely, rather than
 * guessing a tool name that does not exist and failing at posting time.
 */
let hintCache: Record<string, Record<string, string>> | undefined;

/** Where the shipped data file might be, most specific first. */
function dataFileCandidates(): string[] {
  const roots: string[] = [];

  // Under CommonJS (the test transform) the module's own directory is known.
  // Under ESM it is not, and `typeof` on an undeclared name is safe in both.
  if (typeof __dirname === "string") {
    roots.push(__dirname);
  }
  // The shipped build always runs from the installed package's bin.
  if (typeof process.argv[1] === "string") {
    roots.push(dirname(process.argv[1]));
  }
  roots.push(process.cwd());

  const paths: string[] = [];
  for (const root of roots) {
    let current = resolve(root);
    // Walk up to the package root. Five levels covers dist/v4/config and
    // src/v4/config with room to spare, and stops well short of the filesystem
    // root even on a shallow install path.
    for (let depth = 0; depth < 5; depth += 1) {
      paths.push(join(current, "data", "v3-capability-hints.json"));
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return paths;
}

/**
 * Load the migration hints.
 *
 * They live in `data/v3-capability-hints.json`, not here, because they are the
 * one set of tool names Yama ships and rule 7 keeps tool names out of `src/`.
 * A missing or malformed file degrades to no inference at all — every
 * capability is then left absent, which the startup probe reports precisely and
 * which `migrate` marks with a TODO.
 */
function capabilityHints(): Record<string, Record<string, string>> {
  if (hintCache) {
    return hintCache;
  }
  hintCache = {};
  for (const path of dataFileCandidates()) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        servers?: Record<string, Record<string, string>>;
      };
      hintCache = parsed.servers ?? {};
      break;
    } catch {
      // A malformed hints file must not fail a migration: migrating with no
      // inference still produces correct files, just with a TODO on each
      // server. Keep looking in case another candidate is intact.
      continue;
    }
  }
  return hintCache;
}

function inferCapabilities(
  serverId: string,
): Record<string, string> | undefined {
  const hints = capabilityHints();
  const key = Object.keys(hints)
    .sort((a, b) => b.length - a.length)
    .find((known) => serverId.toLowerCase().includes(known));
  return key ? { ...hints[key] } : undefined;
}

/** Map a v3 config document onto the v4 file shapes. */
export function adaptV3Config(legacy: unknown): AdaptedV3 {
  const source = (legacy ?? {}) as Legacy;
  const notices: ConfigNotice[] = [];
  const orphans: AdaptedV3["orphans"] = [];

  // ── ai ────────────────────────────────────────────────────────────────────
  const legacyAi = (get(source, "ai") ?? {}) as Legacy;
  const legacyExplore = (get(source, "ai.explore") ?? {}) as Legacy;

  const ai: Record<string, unknown> = {
    provider: legacyAi.provider ?? "auto",
    ...(legacyAi.model ? { model: legacyAi.model } : {}),
    ...(legacyAi.temperature !== undefined
      ? { temperature: legacyAi.temperature }
      : {}),
    ...(legacyAi.maxTokens !== undefined
      ? { maxTokens: legacyAi.maxTokens }
      : {}),
    ...(legacyAi.timeout ? { timeout: legacyAi.timeout } : {}),
  };

  // v3's "explore" model was the cheap sub-agent model. It maps onto the
  // sub-agent and judge slots, which are v4's cheap paths.
  if (legacyExplore.provider || legacyExplore.model) {
    const cheap = {
      ...(legacyExplore.provider ? { provider: legacyExplore.provider } : {}),
      ...(legacyExplore.model ? { model: legacyExplore.model } : {}),
      ...(legacyExplore.maxTokens !== undefined
        ? { maxTokens: legacyExplore.maxTokens }
        : {}),
    };
    ai.subAgent = cheap;
    ai.judge = cheap;
    ai.compaction = cheap;
  }

  const yama: Record<string, unknown> = { version: 4, ai };

  const legacyState = get(source, "state") as Legacy | undefined;
  if (legacyState) {
    yama.state = {
      ...(legacyState.enabled !== undefined
        ? { enabled: legacyState.enabled }
        : {}),
      ...(legacyState.path ? { path: legacyState.path } : {}),
    };
  }

  // ── mcp ───────────────────────────────────────────────────────────────────
  const legacyServers = (get(source, "mcpServers.servers") ?? {}) as Legacy;
  const servers: Record<string, unknown> = {};
  let inferredCount = 0;
  let unmappedCount = 0;

  for (const [id, raw] of Object.entries(legacyServers)) {
    const definition = { ...((raw ?? {}) as Legacy) };
    // v3 roles were "review" | "explore"; v4 calls them "main" | "sub".
    const legacyRoles = definition.roles as string[] | undefined;
    if (Array.isArray(legacyRoles)) {
      definition.roles = legacyRoles.map((role) =>
        role === "explore" ? "sub" : role === "review" ? "main" : role,
      );
    }
    // v3 `modes` (pr | local) has no v4 equivalent — v4 scopes by stage.
    delete definition.modes;

    const capabilities = inferCapabilities(id);
    if (capabilities) {
      definition.capabilities = capabilities;
      inferredCount += 1;
    } else if (definition.command || definition.url) {
      unmappedCount += 1;
    }
    servers[id] = definition;
  }

  if (inferredCount > 0) {
    notices.push({
      level: "info",
      message:
        `Inferred a capability map for ${inferredCount} server(s) from well-known ` +
        `tool names. \`yama doctor\` verifies each one against the live server.`,
    });
  }
  if (unmappedCount > 0) {
    notices.push({
      level: "warn",
      message:
        `${unmappedCount} server(s) have no capability map. Yama can still let the ` +
        `agent use their tools, but code-driven actions (posting, status) need an ` +
        `explicit \`capabilities:\` block. Run \`yama doctor\` to list their tools.`,
    });
  }

  // ── review ────────────────────────────────────────────────────────────────
  const legacyReview = (get(source, "review") ?? {}) as Legacy;
  const review: Record<string, unknown> = {};

  if (Array.isArray(legacyReview.excludePatterns)) {
    review.excludePatterns = legacyReview.excludePatterns;
    notices.push({
      level: "info",
      message:
        `excludePatterns is now enforced in code before the agent sees a file — ` +
        `in v3 it was only a request in the prompt.`,
    });
  }
  if (typeof legacyReview.maxFilesPerReview === "number") {
    review.maxFiles = legacyReview.maxFilesPerReview;
  }

  // v3 verification modes map onto the confidence threshold.
  const verification = legacyReview.verification;
  if (verification === "off") {
    review.confidenceThreshold = 0;
  } else if (verification === "strict") {
    review.confidenceThreshold = 90;
  }

  // ── guards, from v3 blockingCriteria ──────────────────────────────────────
  if (
    Array.isArray(legacyReview.blockingCriteria) &&
    legacyReview.blockingCriteria.length > 0
  ) {
    notices.push({
      level: "warn",
      message:
        `${legacyReview.blockingCriteria.length} blockingCriteria found. These are ` +
        `prose conditions; v4 expresses blocking as path-scoped guards. ` +
        `\`yama migrate\` writes them to .yama/policy/guards.yaml for you to make concrete.`,
    });
  }

  // ── orphaned prompt text ──────────────────────────────────────────────────
  const workflow = legacyReview.workflowInstructions;
  if (typeof workflow === "string" && workflow.trim().length > 0) {
    orphans.push({
      from: "review.workflowInstructions",
      suggestedPath: ".yama/knowledge/workflow.md",
      content: workflow.trim(),
    });
  }

  if (Array.isArray(legacyReview.focusAreas)) {
    for (const area of legacyReview.focusAreas as Legacy[]) {
      const name = typeof area?.name === "string" ? area.name : "focus-area";
      const description =
        typeof area?.description === "string" ? area.description : "";
      if (!description.trim()) {
        continue;
      }
      orphans.push({
        from: `review.focusAreas[${name}]`,
        suggestedPath: `.yama/knowledge/focus/${name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")}.md`,
        content: description.trim(),
      });
    }
  }

  if (orphans.length > 0) {
    notices.push({
      level: "warn",
      message:
        `${orphans.length} block(s) of v3 prompt text (focus areas, workflow ` +
        `instructions) have no v4 equivalent — v4 never assembles prompts. They are ` +
        `NOT being injected. \`yama migrate\` writes them to .yama/knowledge/ where the ` +
        `agent retrieves them on demand.`,
    });
  }

  // ── checks ────────────────────────────────────────────────────────────────
  // v3 had no checks concept. Nothing to adapt; the file simply stays absent.

  return {
    yama,
    mcp: { servers },
    review: Object.keys(review).length > 0 ? review : undefined,
    checks: undefined,
    orphans,
    notices,
  };
}
