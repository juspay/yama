/**
 * PR artifacts — the memory tier that spans runs while a pull request is open.
 *
 * Three tiers of memory exist in Yama:
 *   turn — the session conversation, compacted by the runtime
 *   PR   — this module: what has been learned about THIS pull request
 *   repo — `.yama/knowledge/`, written only on merge
 *
 * The PR tier is what makes a fifth run smarter than a first. It accumulates
 * across runs and is carried between them by the CI's own artifact mechanism.
 * A missing artifact is never an error — comment markers still carry dedup, and
 * the run simply rebuilds what it needs.
 *
 * Nothing here leaks into repo knowledge. On merge the artifact is an input to
 * `yama learn`, which decides what deserves to be permanent.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  FindingLedgerSnapshot,
  PrArtifact,
  RejectedFinding,
  RunIdentity,
} from "../types/index.js";

/** Keep the artifact small enough to stay cheap to read every run. */
const MAX_CONTEXT_CHARS = 24_000;
const MAX_RUNS = 25;

export function artifactDir(stateRoot: string, pullRequestId: number): string {
  return join(stateRoot, "artifacts", `pr-${pullRequestId}`);
}

function artifactPath(stateRoot: string, pullRequestId: number): string {
  return join(artifactDir(stateRoot, pullRequestId), "artifact.json");
}

export function emptyArtifact(pullRequestId: number): PrArtifact {
  return {
    schemaVersion: 1,
    pullRequestId,
    reviewedShas: [],
    context: "",
    findings: { posted: [], rejected: [] },
    runs: [],
  };
}

/**
 * Load the artifact for a pull request.
 *
 * Every failure path returns an empty artifact rather than throwing. A corrupt
 * or absent artifact must degrade into "this run has no prior context", never
 * into a failed review — the artifact is an accelerator, not a dependency.
 */
export async function loadArtifact(
  stateRoot: string,
  pullRequestId: number,
): Promise<{ artifact: PrArtifact; existed: boolean; warning?: string }> {
  const path = artifactPath(stateRoot, pullRequestId);
  if (!existsSync(path)) {
    return { artifact: emptyArtifact(pullRequestId), existed: false };
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as PrArtifact;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.reviewedShas)) {
      return {
        artifact: emptyArtifact(pullRequestId),
        existed: false,
        warning: `The artifact at ${path} has an unrecognised shape; starting fresh.`,
      };
    }
    return { artifact: parsed, existed: true };
  } catch (error) {
    return {
      artifact: emptyArtifact(pullRequestId),
      existed: false,
      warning: `Could not read ${path}: ${(error as Error).message}. Starting fresh.`,
    };
  }
}

export async function saveArtifact(
  stateRoot: string,
  artifact: PrArtifact,
): Promise<void> {
  const path = artifactPath(stateRoot, artifact.pullRequestId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
}

/**
 * Fold a completed run into the artifact.
 *
 * Only POSTED findings are recorded as posted. An accepted-but-unposted finding
 * must not be remembered as reported: doing so would suppress it on the next
 * run, turning one posting failure into permanent silence about a real defect.
 */
export function recordRun(
  artifact: PrArtifact,
  run: {
    sha: string;
    at: string;
    decision?: string;
    ledger: FindingLedgerSnapshot;
    degradedStages: string[];
    impact?: string;
    contextAppend?: string;
  },
): PrArtifact {
  const postedIds = new Set(artifact.findings.posted.map((entry) => entry.id));
  const posted = [
    ...artifact.findings.posted,
    ...run.ledger.posted
      .filter((finding) => !postedIds.has(finding.id))
      .map((finding) => ({
        id: finding.id,
        commentId: finding.postedCommentId,
        severity: finding.severity,
        title: finding.title,
        filePath: finding.filePath,
        line: finding.line ?? null,
      })),
  ];

  const rejectedIds = new Set(
    artifact.findings.rejected.map((entry) => entry.id),
  );
  const rejected = [
    ...artifact.findings.rejected,
    ...run.ledger.rejected
      .filter((entry: RejectedFinding) => !rejectedIds.has(entry.finding.id))
      .map((entry: RejectedFinding) => ({
        id: entry.finding.id,
        reason: entry.reason,
        title: entry.finding.title,
      })),
  ];

  const context = run.contextAppend
    ? compactContext(
        `${artifact.context}\n\n${run.contextAppend.trim()}`.trim(),
      )
    : artifact.context;

  return {
    ...artifact,
    reviewedShas: artifact.reviewedShas.includes(run.sha)
      ? artifact.reviewedShas
      : [...artifact.reviewedShas, run.sha],
    context,
    findings: { posted, rejected },
    impact: run.impact ?? artifact.impact,
    runs: [
      ...artifact.runs,
      {
        sha: run.sha,
        at: run.at,
        decision: run.decision,
        postedCount: run.ledger.posted.length,
        degradedStages: run.degradedStages,
      },
    ].slice(-MAX_RUNS),
  };
}

/**
 * Keep the context section bounded.
 *
 * Trims from the FRONT: the most recent understanding is the most relevant, and
 * older notes usually describe code that has since been rewritten.
 */
export function compactContext(context: string): string {
  if (context.length <= MAX_CONTEXT_CHARS) {
    return context;
  }
  const kept = context.slice(context.length - MAX_CONTEXT_CHARS);
  const boundary = kept.indexOf("\n");
  return `_[earlier notes trimmed]_\n${boundary === -1 ? kept : kept.slice(boundary + 1)}`;
}

/** Finding ids already posted, for the gate's `alreadyReported` set. */
export function reportedIds(artifact: PrArtifact): Set<string> {
  return new Set(artifact.findings.posted.map((entry) => entry.id));
}

/** The last SHA reviewed, for an incremental diff. */
export function lastReviewedSha(artifact: PrArtifact): string | undefined {
  return artifact.reviewedShas[artifact.reviewedShas.length - 1];
}

/** A compact summary for the agent to recall at the start of a re-run. */
export function summarizeForRecall(
  artifact: PrArtifact,
  identity: RunIdentity,
): string {
  if (artifact.runs.length === 0) {
    return "";
  }
  const lines: string[] = [
    `This is run ${artifact.runs.length + 1} on ${identity.owner}/${identity.repo} PR #${artifact.pullRequestId}.`,
  ];

  const previous = lastReviewedSha(artifact);
  if (previous) {
    lines.push(`Last reviewed commit: ${previous}.`);
  }

  if (artifact.findings.posted.length > 0) {
    lines.push("", "Findings already posted (do not repeat them):");
    for (const finding of artifact.findings.posted) {
      const location = finding.filePath
        ? ` — ${finding.filePath}${finding.line ? `:${finding.line}` : ""}`
        : "";
      lines.push(
        `- [${finding.id}] ${finding.severity}: ${finding.title}${location}`,
      );
    }
  }

  if (artifact.impact) {
    lines.push("", "Impact assessed so far:", artifact.impact.trim());
  }

  if (artifact.context.trim()) {
    lines.push("", "Notes from earlier runs:", artifact.context.trim());
  }

  return lines.join("\n");
}

/** Remove a pull request's artifact. Called after `yama learn` consumes it. */
export async function listArtifacts(stateRoot: string): Promise<number[]> {
  const root = join(stateRoot, "artifacts");
  if (!existsSync(root)) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^pr-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(3)))
    .sort((a, b) => a - b);
}

/**
 * Consume a pull request's artifact after learning has read it.
 *
 * The PR tier is deliberately temporary. Once a pull request merges, whatever
 * deserves to be permanent has been promoted into `.yama/knowledge/` by the
 * learning pass, and keeping the rest would let one pull request's working
 * notes leak into how every future review reads the repository.
 *
 * Returns what it removed so the caller can report it rather than deleting
 * silently.
 */
export async function consumeArtifact(
  stateRoot: string,
  pullRequestId: number,
): Promise<{ removed: boolean; path: string; artifact?: PrArtifact }> {
  const dir = artifactDir(stateRoot, pullRequestId);
  const { artifact, existed } = await loadArtifact(stateRoot, pullRequestId);
  if (!existed) {
    return { removed: false, path: dir };
  }
  await rm(dir, { recursive: true, force: true });
  return { removed: true, path: dir, artifact };
}
