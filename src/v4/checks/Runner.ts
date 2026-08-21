/**
 * Check execution.
 *
 * This module runs commands authored by the repository, which makes it the most
 * dangerous code in Yama. Two rules are therefore not configurable downward:
 *
 *  1. **Config and scripts come from the base branch.** A pull request that can
 *     edit `checks.yaml` can run anything it likes with the CI job's credentials.
 *     The base branch is the only version a reviewer has actually approved.
 *  2. **Forks are off unless explicitly enabled.** Same reasoning, higher risk.
 *
 * Beyond that: results are cached on content, output is bounded, and truncation
 * is always reported. A check that silently drops 300 findings is worse than one
 * that fails.
 */

import { createHash } from "node:crypto";
import type {
  ChangeSet,
  CheckConfig,
  CheckFinding,
  CheckRunResult,
  ExecuteCheckOptions,
  FindingSeverity,
  IdentifiedFinding,
  ParserName,
  PreparedCheck,
  ResolvedConfig,
} from "../types/index.js";
import { getParser } from "./parsers/index.js";
import { changedPaths } from "../changes/ChangeSet.js";
import { matchesAnyPath, normalizePath } from "../policy/paths.js";
import { buildFindingId } from "../findings/Markers.js";

/** Output kept per check. Enough to diagnose; not enough to flood a report. */
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_FINDINGS = 50;

export class CheckSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckSecurityError";
  }
}

/**
 * Refuse to run checks when the pull request modified the check configuration or
 * any script it names.
 *
 * The base-branch config is what runs, so a modified script in the head would
 * not execute anyway — but a PR that edits them is either trying something or
 * about to be surprised. Both deserve a stop rather than a silent divergence.
 */
export function assertCheckConfigUntampered(
  checks: CheckConfig[],
  changedFilePaths: string[],
): void {
  const changed = new Set(changedFilePaths.map(normalizePath));

  if (changed.has(".yama/checks.yaml")) {
    throw new CheckSecurityError(
      "This pull request modifies .yama/checks.yaml. Checks run from the base branch, " +
        "so the change would not take effect here — and running project commands for a " +
        "pull request that edits them is not safe. Merge the config change first.",
    );
  }

  for (const check of checks) {
    if (!check.run) {
      continue;
    }
    // Match any changed path that appears as a token in the command. Coarse on
    // purpose: a false positive costs one skipped check run, a false negative
    // costs arbitrary code execution.
    for (const path of changed) {
      if (path.length > 3 && check.run.includes(path)) {
        throw new CheckSecurityError(
          `This pull request modifies "${path}", which check "${check.id}" executes. ` +
            `Checks are disabled for this run. Merge the script change first.`,
        );
      }
    }
  }
}

/** Should this check run for this change? */
export function shouldRunCheck(
  check: CheckConfig,
  changeSet: ChangeSet,
): { run: boolean; paths: string[]; reason?: string } {
  if (check.enabled === false) {
    return { run: false, paths: [], reason: "disabled in config" };
  }

  const paths = changedPaths(changeSet);
  if (!check.when?.paths || check.when.paths.length === 0) {
    return { run: true, paths };
  }

  const matching = paths.filter((path) =>
    matchesAnyPath(path, check.when?.paths),
  );
  return matching.length > 0
    ? { run: true, paths: matching }
    : { run: false, paths: [], reason: "no changed file matches when.paths" };
}

/**
 * Cache key over the check's identity and the content it will look at.
 *
 * Content-addressed rather than time-based: the same code produces the same
 * lint output, and a re-run on an unchanged file is pure waste. Callers pass
 * file contents (or their hashes) for the paths in scope.
 */
export function buildCacheKey(
  check: CheckConfig,
  fileHashes: ReadonlyMap<string, string>,
  paths: string[],
): string {
  const relevant = [...paths]
    .sort()
    .map((path) => `${path}:${fileHashes.get(path) ?? ""}`)
    .join("|");
  return createHash("sha256")
    .update(
      `${check.id}\u0000${check.run ?? check.type ?? ""}\u0000${relevant}`,
    )
    .digest("hex")
    .slice(0, 16);
}

export function prepareChecks(
  config: ResolvedConfig,
  changeSet: ChangeSet,
  fileHashes: ReadonlyMap<string, string> = new Map(),
): { prepared: PreparedCheck[]; skipped: CheckRunResult[] } {
  const prepared: PreparedCheck[] = [];
  const skipped: CheckRunResult[] = [];

  for (const check of config.checks.checks) {
    const decision = shouldRunCheck(check, changeSet);
    if (!decision.run) {
      skipped.push({
        checkId: check.id,
        status: "skipped",
        durationMs: 0,
        findings: [],
        droppedFindings: 0,
        reason: decision.reason,
      });
      continue;
    }
    prepared.push({
      config: check,
      paths: decision.paths,
      cacheKey: buildCacheKey(check, fileHashes, decision.paths),
    });
  }

  return { prepared, skipped };
}

/** Keep findings whose location this pull request actually touched. */
export function scopeFindings(
  findings: CheckFinding[],
  check: CheckConfig,
  changeSet: ChangeSet,
  isChangedLine: (path: string, line: number) => boolean,
): CheckFinding[] {
  const scope = check.scope ?? "changed-lines";
  if (scope === "repo") {
    return findings;
  }

  const paths = new Set(changedPaths(changeSet));
  return findings.filter((finding) => {
    if (!finding.filePath) {
      // A repository-level finding (no path) survives: it is not about a line.
      return true;
    }
    const path = normalizePath(finding.filePath);
    const relative = [...paths].find(
      (candidate) => path === candidate || path.endsWith(`/${candidate}`),
    );
    if (!relative) {
      return false;
    }
    if (scope === "changed-files") {
      return true;
    }
    return (
      finding.line === undefined ||
      finding.line === null ||
      isChangedLine(relative, finding.line)
    );
  });
}

/** Run one check and parse its output. Never throws for a check's own failure. */
export async function executeCheck(
  options: ExecuteCheckOptions,
): Promise<CheckRunResult> {
  const { check, runner, cwd } = options;
  const now = options.now ?? (() => Date.now());
  const config = check.config;

  const cached = options.cache?.get(check.cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  if (!config.run) {
    return {
      checkId: config.id,
      status: "skipped",
      durationMs: 0,
      findings: [],
      droppedFindings: 0,
      reason: "built-in checks are evaluated in code, not executed",
    };
  }

  const startedAt = now();
  let result: CheckRunResult;

  try {
    const output = await runner(config.run, {
      cwd: config.workingDirectory ? `${cwd}/${config.workingDirectory}` : cwd,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    });

    if (output.timedOut) {
      result = {
        checkId: config.id,
        status: "timeout",
        durationMs: now() - startedAt,
        findings: [],
        droppedFindings: 0,
        reason: `exceeded ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        output: truncate(`${output.stdout}\n${output.stderr}`),
      };
    } else {
      const parsed = getParser(config.parse as ParserName | undefined)(output, {
        checkId: config.id,
        severityMap: config.severity as
          | Record<string, FindingSeverity>
          | undefined,
      });

      result = {
        checkId: config.id,
        // Exit code is the authority on pass/fail. A tool can exit non-zero with
        // no parseable findings (a crash, a bad flag) and that is still a failure.
        status: output.exitCode === 0 ? "passed" : "failed",
        exitCode: output.exitCode,
        durationMs: now() - startedAt,
        findings: parsed,
        droppedFindings: 0,
        output: truncate(`${output.stdout}\n${output.stderr}`),
      };
    }
  } catch (error) {
    result = {
      checkId: config.id,
      status: "error",
      durationMs: now() - startedAt,
      findings: [],
      droppedFindings: 0,
      reason: (error as Error).message,
    };
  }

  options.cache?.set(check.cacheKey, result);
  return result;
}

/** Apply `maxFindings`, keeping the most severe and reporting what was dropped. */
export function capFindings(
  result: CheckRunResult,
  maxFindings: number = DEFAULT_MAX_FINDINGS,
): CheckRunResult {
  if (maxFindings <= 0 || result.findings.length <= maxFindings) {
    return result;
  }
  const rank: Record<FindingSeverity, number> = {
    CRITICAL: 0,
    MAJOR: 1,
    MINOR: 2,
    SUGGESTION: 3,
  };
  const sorted = [...result.findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity],
  );
  return {
    ...result,
    findings: sorted.slice(0, maxFindings),
    droppedFindings: result.findings.length - maxFindings,
  };
}

/** Convert check findings into gate-ready findings. */
export function toFindings(result: CheckRunResult): IdentifiedFinding[] {
  return result.findings.map((finding) => {
    const candidate = {
      severity: finding.severity,
      title: finding.ruleId
        ? `${finding.ruleId}: ${finding.message}`
        : finding.message,
      description: finding.message,
      filePath: finding.filePath ? normalizePath(finding.filePath) : undefined,
      line: finding.line ?? null,
      // A check finding IS its own evidence: the tool ran and said so.
      suggestion: `Resolve what \`${result.checkId}\` reports at this location.`,
      impact: `\`${result.checkId}\` fails while this stands.`,
      source: "check" as const,
      checkId: result.checkId,
      ruleId: finding.ruleId,
    };
    return { ...candidate, id: buildFindingId(candidate) };
  });
}

/** Locations a check already reported — the gate uses this to silence the agent. */
export function flaggedLocations(results: CheckRunResult[]): Set<string> {
  const flagged = new Set<string>();
  for (const result of results) {
    for (const finding of result.findings) {
      if (
        finding.filePath &&
        finding.line !== undefined &&
        finding.line !== null
      ) {
        flagged.add(`${normalizePath(finding.filePath)}:${finding.line}`);
      }
    }
  }
  return flagged;
}

/** Check id → passed, for guard evaluation. Skipped checks are absent. */
export function checkOutcomes(results: CheckRunResult[]): Map<string, boolean> {
  const outcomes = new Map<string, boolean>();
  for (const result of results) {
    if (result.status === "passed") {
      outcomes.set(result.checkId, true);
    } else if (result.status === "failed" || result.status === "timeout") {
      outcomes.set(result.checkId, false);
    }
  }
  return outcomes;
}

/** Ids of blocking checks that did not pass. Feeds the verdict. */
export function failedBlockingChecks(
  results: CheckRunResult[],
  checks: CheckConfig[],
): string[] {
  const blocking = new Set(
    checks.filter((check) => check.blocking).map((check) => check.id),
  );
  return results
    .filter(
      (result) =>
        blocking.has(result.checkId) &&
        (result.status === "failed" ||
          result.status === "timeout" ||
          result.status === "error"),
    )
    .map((result) => result.checkId);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_OUTPUT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n… [${trimmed.length - MAX_OUTPUT_CHARS} more characters]`;
}
