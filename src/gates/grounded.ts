/**
 * Findings are grounded in the change, or they are gone (the v4 doctrine's "cited file
 * exists in the change set", learned again live: a budget-squeezed model round emitted
 * schema-valid findings citing files that do not exist, and nothing between it and the
 * pull request checked. Schema validity proves shape; this gate proves the subject.)
 *
 * Deterministic and total: a finding whose `file` is not a changed path is dropped and
 * NAMED — silently narrowing a review is the failure mode this repository's rulebook
 * exists to prevent. Findings carried over from a previous run legitimately cite files
 * this diff does not touch, so callers pass their ids through `allow`.
 */
import type { Finding, GitDiff, UngroundedFinding } from "../types/index.js";

const normalize = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Splits findings into those citing a changed file (either side of a rename) and those
 * citing anything else. `allow` bypasses the check by finding id — carried-over findings
 * answer to their own run's diff, not this one's.
 */
export const groundFindings = (input: {
  findings: readonly Finding[];
  diff: GitDiff;
  allow?: ReadonlySet<string>;
}): { grounded: Finding[]; dropped: UngroundedFinding[] } => {
  const changed = new Set<string>();
  for (const file of input.diff.files) {
    changed.add(normalize(file.path));
    if (file.previousPath !== undefined) {
      changed.add(normalize(file.previousPath));
    }
  }
  const grounded: Finding[] = [];
  const dropped: UngroundedFinding[] = [];
  for (const finding of input.findings) {
    if (
      input.allow?.has(finding.id) === true ||
      changed.has(normalize(finding.file))
    ) {
      grounded.push(finding);
    } else {
      dropped.push({
        id: finding.id,
        file: finding.file,
        reason: `cites "${finding.file}", which this change does not touch`,
      });
    }
  }
  return { grounded, dropped };
};
