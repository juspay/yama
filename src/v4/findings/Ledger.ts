/**
 * The finding ledger — the run's honest accounting.
 *
 * One rule governs this file: a finding counts as posted only when a posting
 * tool RETURNED a comment id. Not when the tool was called, not when the agent
 * said it posted. v3 counted calls, which is how runs reported findings that
 * were never on the pull request, and how a posting failure became indistinguishable
 * from a clean review.
 *
 * The ledger is also what the post stage's exit predicate reads: `unposted`
 * being non-empty is precisely the condition that must be remediated.
 */

import type {
  FindingLedgerSnapshot,
  IdentifiedFinding,
  PostedFinding,
  RejectedFinding,
} from "../types/index.js";

export class FindingLedger {
  private submittedCount = 0;
  private readonly acceptedById = new Map<string, IdentifiedFinding>();
  private readonly rejectedList: RejectedFinding[] = [];
  private readonly postedById = new Map<string, PostedFinding>();

  /** Record one gate decision. */
  recordGate(result: {
    accepted: IdentifiedFinding[];
    rejected: RejectedFinding[];
  }): void {
    this.submittedCount += result.accepted.length + result.rejected.length;
    for (const finding of result.accepted) {
      this.acceptedById.set(finding.id, finding);
    }
    this.rejectedList.push(...result.rejected);
  }

  /**
   * Record a confirmed post.
   *
   * Only accepted findings may be marked posted. A comment id arriving for a
   * finding the gate never accepted means something posted outside the gate,
   * which is exactly what the gate exists to prevent — so it is refused rather
   * than quietly recorded.
   */
  recordPosted(findingId: string, commentId: string, at = new Date()): void {
    const finding = this.acceptedById.get(findingId);
    if (!finding) {
      throw new Error(
        `Refusing to record a post for finding "${findingId}", which the gate did not accept.`,
      );
    }
    if (!commentId || commentId.trim().length === 0) {
      throw new Error(
        `Refusing to record a post for finding "${findingId}" without a comment id ` +
          `from the posting tool's result.`,
      );
    }
    this.postedById.set(findingId, {
      ...finding,
      postedCommentId: commentId,
      postedAt: at.toISOString(),
    });
  }

  /**
   * Mark a finding as already carrying a comment from a previous run.
   *
   * Distinct from `recordPosted` in intent but identical in effect: the finding
   * IS on the pull request, so the post stage has nothing left to do for it.
   */
  recordPreExisting(finding: IdentifiedFinding, commentId: string): void {
    this.acceptedById.set(finding.id, finding);
    this.postedById.set(finding.id, {
      ...finding,
      postedCommentId: commentId,
      postedAt: new Date(0).toISOString(),
    });
  }

  /** Accepted findings with no confirmed comment. The post stage's work list. */
  get unposted(): IdentifiedFinding[] {
    return [...this.acceptedById.values()].filter(
      (finding) => !this.postedById.has(finding.id),
    );
  }

  get accepted(): IdentifiedFinding[] {
    return [...this.acceptedById.values()];
  }

  get posted(): PostedFinding[] {
    return [...this.postedById.values()];
  }

  get rejected(): RejectedFinding[] {
    return [...this.rejectedList];
  }

  /** Ids the gate has accepted — feeds back in as `alreadyAccepted`. */
  get acceptedIds(): ReadonlySet<string> {
    return new Set(this.acceptedById.keys());
  }

  snapshot(): FindingLedgerSnapshot {
    return {
      submitted: this.submittedCount,
      accepted: this.accepted,
      rejected: this.rejected,
      posted: this.posted,
      unposted: this.unposted,
    };
  }

  /** Counts for the summary comment and CI outputs. */
  counts(): {
    submitted: number;
    accepted: number;
    rejected: number;
    posted: number;
    unposted: number;
    bySeverity: Record<string, number>;
  } {
    const bySeverity: Record<string, number> = {
      CRITICAL: 0,
      MAJOR: 0,
      MINOR: 0,
      SUGGESTION: 0,
    };
    // Counted over POSTED findings: the severity mix a reader sees on the PR is
    // the one the summary should describe.
    for (const finding of this.postedById.values()) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    }
    return {
      submitted: this.submittedCount,
      accepted: this.acceptedById.size,
      rejected: this.rejectedList.length,
      posted: this.postedById.size,
      unposted: this.unposted.length,
      bySeverity,
    };
  }
}

/**
 * Extract a comment id from a posting tool's result.
 *
 * Providers disagree about the field name, so several are tried. Returning
 * undefined when none is present is deliberate and important: an unrecognised
 * result shape must read as "not confirmed posted", never as success. A wrong
 * guess here would recreate exactly the accounting bug this module exists to
 * prevent.
 */
export function extractCommentId(result: unknown): string | undefined {
  if (result === null || result === undefined) {
    return undefined;
  }
  if (typeof result === "number") {
    return String(result);
  }
  if (typeof result === "string") {
    // Only something that LOOKS like an identifier. Servers that return plain
    // prose ("Comment added successfully") must read as unconfirmed — a
    // sentence accepted as a comment id is a phantom post in the ledger, and
    // the id is later embedded in a marker that could never be re-scanned.
    const value = result.trim();
    return value.length > 0 &&
      value.length <= 64 &&
      /^[A-Za-z0-9_-]+$/.test(value)
      ? value
      : undefined;
  }
  if (typeof result !== "object") {
    return undefined;
  }

  const record = result as Record<string, unknown>;
  const candidates = [
    record.id,
    record.commentId,
    record.comment_id,
    (record.comment as Record<string, unknown> | undefined)?.id,
    (record.data as Record<string, unknown> | undefined)?.id,
    (record.data as Record<string, unknown> | undefined)?.commentId,
    (record.result as Record<string, unknown> | undefined)?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return undefined;
}
