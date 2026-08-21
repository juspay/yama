/**
 * Persisting the learning watermark.
 *
 * The watermark is committed alongside the knowledge base, in the same commit,
 * for one reason: if it were stored anywhere else, the two could disagree. A
 * watermark that advanced without its knowledge landing means feedback is lost
 * silently; knowledge that landed without the watermark advancing means the next
 * run learns from it twice, doubling every occurrence count it contributed.
 *
 * Same commit, or neither.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyWatermark } from "./Window.js";
import type { LearnWatermark, WatermarkLoad } from "../types/index.js";

/** Lives under the knowledge base, not the state directory: state is a cache
 *  that can be lost, and losing this would re-learn or skip. */
export function watermarkPath(projectRoot: string): string {
  return join(projectRoot, ".yama", "knowledge", "learn-watermark.json");
}

/**
 * Load the watermark for a branch.
 *
 * A watermark for a different branch is not reused. Branches merge different
 * work, and inheriting main's watermark on a release branch would skip
 * everything that branch merged.
 */
export async function loadWatermark(
  projectRoot: string,
  branch: string,
): Promise<WatermarkLoad> {
  const path = watermarkPath(projectRoot);
  if (!existsSync(path)) {
    return { watermark: emptyWatermark(branch), existed: false };
  }

  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as LearnWatermark;

    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.processed)) {
      return {
        watermark: emptyWatermark(branch),
        existed: false,
        warning:
          `The watermark at ${path} has an unrecognised shape. Starting fresh, which ` +
          `means only the triggering pull request is learned from this run.`,
      };
    }

    if (parsed.branch !== branch) {
      return {
        watermark: emptyWatermark(branch),
        existed: false,
        warning:
          `The stored watermark tracks "${parsed.branch}" but this run is on ` +
          `"${branch}". Starting a fresh watermark rather than inheriting a position ` +
          `from a different branch's history.`,
      };
    }

    return { watermark: parsed, existed: true };
  } catch (error) {
    return {
      watermark: emptyWatermark(branch),
      existed: false,
      warning: `Could not read ${path}: ${(error as Error).message}. Starting fresh.`,
    };
  }
}

export async function saveWatermark(
  projectRoot: string,
  watermark: LearnWatermark,
): Promise<string> {
  const path = watermarkPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(watermark, null, 2)}\n`, "utf-8");
  return path;
}

/** Relative path, for staging in the learn commit. */
export function watermarkRelativePath(): string {
  return ".yama/knowledge/learn-watermark.json";
}
