/**
 * Review state persistence + reconciliation.
 *
 * Backends are config-selected; the CI-artifact kinds are deliberate thin
 * wrappers over the file store — the workflow moves the file across runs
 * (actions/upload-artifact / archiveArtifacts), so Yama needs no bespoke
 * artifact-protocol code. Jenkins additionally supports a read-side fetch of
 * the previous build's artifact over its REST API when the local file is
 * absent.
 */

import { createHash } from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import {
  ReviewState,
  ReviewStateFinding,
  StateConfig,
  StateFindingStatus,
} from "../types/index.js";

export type ReviewStateStore = {
  load(key: string): Promise<ReviewState | null>;
  save(key: string, state: ReviewState): Promise<void>;
  /** Human-readable backend label for logs. */
  readonly kind: string;
};

const DEFAULT_STATE_DIR = ".yama/state";

function parseState(raw: string, key: string): ReviewState | null {
  try {
    const parsed = JSON.parse(raw) as ReviewState;
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.findings)
    ) {
      return parsed;
    }
    console.warn(
      `   ⚠️  Review state for ${key} has an unknown shape — starting fresh.`,
    );
    return null;
  } catch {
    console.warn(
      `   ⚠️  Review state for ${key} was unparseable — starting fresh.`,
    );
    return null;
  }
}

function stateFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}.json`;
}

export class FileStateStore implements ReviewStateStore {
  readonly kind: string = "file";

  constructor(
    private readonly dir: string,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  protected filePath(key: string): string {
    const base = isAbsolute(this.dir)
      ? this.dir
      : join(this.projectRoot, this.dir);
    return join(base, stateFileName(key));
  }

  async load(key: string): Promise<ReviewState | null> {
    const path = this.filePath(key);
    if (!existsSync(path)) {
      return null;
    }
    try {
      return parseState(await readFile(path, "utf-8"), key);
    } catch {
      return null;
    }
  }

  async save(key: string, state: ReviewState): Promise<void> {
    const path = this.filePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
  }
}

/** SDK-injected state: read from provided content, expose what was saved. */
export class InlineStateStore implements ReviewStateStore {
  readonly kind: string = "inline";
  private saved: ReviewState | null = null;

  constructor(private readonly content?: string) {}

  async load(key: string): Promise<ReviewState | null> {
    return this.content ? parseState(this.content, key) : null;
  }

  async save(_key: string, state: ReviewState): Promise<void> {
    this.saved = state;
  }

  /** Updated state for the SDK caller to persist wherever it wants. */
  getSaved(): ReviewState | null {
    return this.saved;
  }
}

/**
 * GitHub Actions: file store + a one-time hint that the workflow must move
 * the state file across runs (download-artifact before / upload-artifact
 * after). No bespoke artifact-protocol code.
 */
export class GithubArtifactStateStore extends FileStateStore {
  override readonly kind: string = "github-artifact";
  private hinted = false;

  override async load(key: string): Promise<ReviewState | null> {
    const state = await super.load(key);
    if (!state && !this.hinted && process.env.GITHUB_ACTIONS === "true") {
      this.hinted = true;
      console.log(
        `   ℹ️  No previous review state found. To persist state across runs, ` +
          `restore/upload the state directory as a workflow artifact named ` +
          `"yama-state" (actions/download-artifact + actions/upload-artifact).`,
      );
    }
    return state;
  }
}

/**
 * Jenkins: file store whose read side falls back to fetching the previous
 * completed build's archived artifact via the Jenkins REST API.
 */
export class JenkinsArtifactStateStore extends FileStateStore {
  override readonly kind: string = "jenkins-artifact";

  constructor(
    private readonly relativeDir: string,
    projectRoot?: string,
  ) {
    super(relativeDir, projectRoot);
  }

  override async load(key: string): Promise<ReviewState | null> {
    const local = await super.load(key);
    if (local) {
      return local;
    }
    const jobUrl = process.env.JOB_URL;
    if (!jobUrl) {
      return null;
    }
    const artifactPath = `${this.relativeDir.replace(/^\.?\//, "")}/${stateFileName(key)}`;
    const url = `${jobUrl.replace(/\/$/, "")}/lastCompletedBuild/artifact/${artifactPath}`;
    try {
      const headers: Record<string, string> = {};
      if (process.env.JENKINS_USER && process.env.JENKINS_API_TOKEN) {
        headers.Authorization = `Basic ${Buffer.from(
          `${process.env.JENKINS_USER}:${process.env.JENKINS_API_TOKEN}`,
        ).toString("base64")}`;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return null;
      }
      return parseState(await response.text(), key);
    } catch {
      return null;
    }
  }
}

export function createStateStore(
  config: StateConfig | undefined,
  projectRoot: string = process.cwd(),
): ReviewStateStore | null {
  if (config?.enabled === false) {
    return null;
  }
  const dir = config?.path || DEFAULT_STATE_DIR;
  switch (config?.store) {
    case "inline":
      return new InlineStateStore(config.content);
    case "github-artifact":
      return new GithubArtifactStateStore(dir, projectRoot);
    case "jenkins-artifact":
      return new JenkinsArtifactStateStore(dir, projectRoot);
    case "file":
    case undefined:
      return new FileStateStore(dir, projectRoot);
    default:
      return new FileStateStore(dir, projectRoot);
  }
}

// ── Pure state logic ─────────────────────────────────────────────────────────

/** Stable content-derived finding id — survives re-runs and re-orderings. */
export function buildFindingId(finding: {
  filePath?: string;
  severity?: string;
  category?: string;
  title?: string;
  description?: string;
}): string {
  const normalize = (value: string | undefined): string =>
    (value || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  const material = [
    normalize(finding.filePath),
    normalize(finding.severity),
    normalize(finding.category),
    normalize(finding.title || finding.description),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export type ReconcileInput = {
  previous: ReviewState | null;
  key: string;
  sha?: string;
  decision: string;
  stopReason?: ReviewState["runs"][number]["stopReason"];
  /** Findings reported by THIS run (already normalized). */
  currentFindings: Array<{
    id: string;
    ruleId?: string;
    filePath?: string;
    line?: number | null;
    severity: ReviewStateFinding["severity"];
    title: string;
  }>;
  /** Finding ids the agent verified as fixed this run. */
  resolvedIds?: string[];
};

export type ReconcileOutput = {
  state: ReviewState;
  /** Findings first seen this run (i.e. worth posting). */
  newFindingIds: Set<string>;
  /** Previously-open findings the agent confirmed fixed. */
  resolvedFindingIds: Set<string>;
};

/**
 * Merge this run's findings into prior state. Deterministic and pure:
 * - current finding with a known id       → stays open (NOT new — do not re-post)
 * - current finding with an unknown id    → new, status open
 * - previous open finding in resolvedIds  → fixed
 * - previous open finding otherwise       → carried (critic/next run judges it)
 */
export function reconcileFindings(input: ReconcileInput): ReconcileOutput {
  const previous = input.previous;
  const runIndex = previous ? previous.runs.length : 0;
  const previousById = new Map<string, ReviewStateFinding>(
    (previous?.findings || []).map((finding) => [finding.id, finding]),
  );
  const resolvedIds = new Set(input.resolvedIds || []);
  const currentIds = new Set(input.currentFindings.map((f) => f.id));

  const newFindingIds = new Set<string>();
  const resolvedFindingIds = new Set<string>();
  const findings: ReviewStateFinding[] = [];

  for (const current of input.currentFindings) {
    const prior = previousById.get(current.id);
    if (prior) {
      findings.push({ ...prior, ...current, status: "open" });
    } else {
      newFindingIds.add(current.id);
      findings.push({
        ...current,
        status: "open",
        firstReportedRun: runIndex,
      });
    }
  }

  for (const prior of previous?.findings || []) {
    if (currentIds.has(prior.id)) {
      continue;
    }
    if (prior.status === "fixed" || prior.status === "dismissed") {
      findings.push(prior);
      continue;
    }
    if (resolvedIds.has(prior.id)) {
      resolvedFindingIds.add(prior.id);
      findings.push({ ...prior, status: "fixed" });
    } else {
      // Reported, never fixed, not re-confirmed: the team is ignoring it.
      // Consecutive carried runs feed auto-suppression (3+ → suppressed).
      const status: StateFindingStatus = "carried";
      findings.push({
        ...prior,
        status,
        dismissCount: (prior.dismissCount ?? 0) + 1,
      });
    }
  }

  const state: ReviewState = {
    schemaVersion: 1,
    key: input.key,
    lastReviewedSha: input.sha ?? previous?.lastReviewedSha,
    runs: [
      ...(previous?.runs || []),
      {
        at: new Date().toISOString(),
        sha: input.sha,
        decision: input.decision,
        stopReason: input.stopReason,
        newFindings: newFindingIds.size,
        resolvedFindings: resolvedFindingIds.size,
      },
    ],
    findings,
  };

  return { state, newFindingIds, resolvedFindingIds };
}

/** Findings the team has ignored for 3+ consecutive runs — treated as
 *  learned false positives and suppressed by the submit_review gate. */
export const AUTO_SUPPRESS_DISMISS_THRESHOLD = 3;

export function collectSuppressedIds(state: ReviewState | null): Set<string> {
  const suppressed = new Set<string>();
  for (const finding of state?.findings || []) {
    if (
      finding.status === "dismissed" ||
      (finding.dismissCount ?? 0) >= AUTO_SUPPRESS_DISMISS_THRESHOLD
    ) {
      suppressed.add(finding.id);
    }
  }
  return suppressed;
}

/** Open/carried findings formatted for prompt injection on the next run. */
export function formatOpenFindingsForPrompt(state: ReviewState): string {
  const open = state.findings.filter(
    (finding) => finding.status === "open" || finding.status === "carried",
  );
  if (open.length === 0) {
    return "";
  }
  return open
    .map(
      (finding) =>
        `- [${finding.id}] ${finding.severity} ${finding.filePath || "?"}${
          finding.line !== null && finding.line !== undefined
            ? `:${finding.line}`
            : ""
        } — ${finding.title}`,
    )
    .join("\n");
}
