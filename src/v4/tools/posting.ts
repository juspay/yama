/**
 * Posting — the deterministic path from an accepted finding to a comment on the
 * pull request.
 *
 * The agent posts as it works. This layer is the net underneath: after the agent
 * is done, code verifies every accepted finding actually landed and posts what
 * did not. Production data on the previous architecture is unambiguous about why
 * — 121 consecutive runs posted zero summary comments because posting was left
 * entirely to the model's judgement.
 *
 * Every write is idempotent and every write is skipped in dry-run.
 */

import type {
  CapabilityName,
  ExistingComment,
  IdentifiedFinding,
  PostOutcome,
  PostedFinding,
  PostingContext,
  SummaryPostResult,
} from "../types/index.js";
import { FindingLedger, extractCommentId } from "../findings/Ledger.js";
import { renderMarker, scanMarkers, withMarker } from "../findings/Markers.js";
import { renderFindingComment } from "./commentFormat.js";

const capability = (
  context: PostingContext,
  name: CapabilityName,
): { toolName: string; args?: Record<string, unknown> } | undefined =>
  context.resolver.find(name, context.stage);

/**
 * Call a capability with the arguments its config pinned to it.
 *
 * Modern VCS servers put many operations behind one tool selected by a
 * parameter. That parameter is part of the mapping, not part of Yama, so it
 * arrives from `.yama/mcp.yaml` and is merged here — the call sites stay
 * written in terms of what they mean, never what a server calls it.
 */
const call = (
  context: PostingContext,
  tool: { toolName: string; args?: Record<string, unknown> },
  params: Record<string, unknown>,
): Promise<unknown> =>
  context.invoke(tool.toolName, { ...context.target, ...tool.args, ...params });

/**
 * Post one inline comment.
 *
 * Returns undefined rather than throwing when the capability is missing, so a
 * dry run or a partially-configured project degrades instead of failing.
 */
export async function postInlineComment(
  context: PostingContext,
  finding: IdentifiedFinding,
): Promise<string | undefined> {
  const tool = capability(context, "postInlineComment");
  if (!tool) {
    return undefined;
  }

  const body = withMarker(renderFindingComment(finding), "finding", finding.id);
  const result = await call(context, tool, {
    path: finding.filePath,
    file_path: finding.filePath,
    line: finding.line ?? undefined,
    body,
    comment: body,
  });
  return extractCommentId(result);
}

/**
 * Post every accepted finding that has no confirmed comment.
 *
 * This is the post stage's exit predicate made executable: after it runs,
 * `ledger.unposted` being non-empty means something genuinely failed, and the
 * failures list says what.
 */
export async function postMissingFindings(
  context: PostingContext,
  ledger: FindingLedger,
): Promise<PostOutcome> {
  const outcome: PostOutcome = { posted: [], failures: [], skipped: 0 };

  if (context.mode === "dry-run") {
    outcome.skipped = ledger.unposted.length;
    return outcome;
  }

  for (const finding of ledger.unposted) {
    try {
      const commentId = await postInlineComment(context, finding);
      if (!commentId) {
        outcome.failures.push({
          finding,
          error:
            "The posting tool returned no comment id, so the comment cannot be " +
            "confirmed. Treating it as unposted rather than assuming success.",
        });
        continue;
      }
      ledger.recordPosted(finding.id, commentId);
      outcome.posted.push(
        ledger.posted.find((entry) => entry.id === finding.id) as PostedFinding,
      );
    } catch (error) {
      outcome.failures.push({ finding, error: (error as Error).message });
    }
  }

  return outcome;
}

/**
 * Post or update the single summary comment.
 *
 * Idempotency comes from re-scanning the pull request immediately before
 * writing, not from remembered state: concurrent runs and expired artifacts both
 * make remembered state wrong, and the failure mode is a duplicate summary on
 * every run.
 *
 * Only a comment Yama itself authored is ever edited. Editing a human's comment
 * because it happens to contain a marker would be a serious breach of trust.
 */
export async function postSummary(
  context: PostingContext,
  body: string,
  existingComments: ExistingComment[],
): Promise<SummaryPostResult> {
  if (context.mode === "dry-run") {
    return { status: "skipped" };
  }

  const tool = capability(context, "postSummary");
  if (!tool) {
    return {
      status: "failed",
      error: "No postSummary capability is configured for this stage.",
    };
  }

  const marked = withMarker(body, "summary");
  const scan = scanMarkers(existingComments, context.botIdentity);

  try {
    if (scan.summaryCommentId) {
      const updateTool = capability(context, "updateComment");
      if (updateTool) {
        const result = await call(context, updateTool, {
          comment_id: scan.summaryCommentId,
          commentId: scan.summaryCommentId,
          body: marked,
          comment: marked,
        });
        return {
          status: "updated",
          commentId: extractCommentId(result) ?? scan.summaryCommentId,
        };
      }
      // No update capability: a new comment beats no summary at all, and the
      // marker keeps the next run converging on the newest one.
    }

    const result = await call(context, tool, { body: marked, comment: marked });
    const commentId = extractCommentId(result);
    return commentId
      ? { status: "created", commentId }
      : {
          status: "failed",
          error:
            "The summary tool returned no comment id — cannot confirm it posted.",
        };
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}

/** Post or update the ownership comment. Same idempotency rules as the summary. */
export async function postOwnersComment(
  context: PostingContext,
  body: string,
  existingComments: ExistingComment[],
): Promise<SummaryPostResult> {
  if (context.mode === "dry-run") {
    return { status: "skipped" };
  }

  const tool = capability(context, "postSummary");
  if (!tool) {
    return {
      status: "failed",
      error: "No postSummary capability is configured.",
    };
  }

  const scan = scanMarkers(existingComments, context.botIdentity);
  const marked = body.includes(renderMarker("owners"))
    ? body
    : withMarker(body, "owners");

  try {
    if (scan.ownersCommentId) {
      const updateTool = capability(context, "updateComment");
      if (updateTool) {
        await call(context, updateTool, {
          comment_id: scan.ownersCommentId,
          commentId: scan.ownersCommentId,
          body: marked,
          comment: marked,
        });
        return { status: "updated", commentId: scan.ownersCommentId };
      }
    }
    const result = await call(context, tool, { body: marked, comment: marked });
    return { status: "created", commentId: extractCommentId(result) };
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}

/**
 * Open a review to hang inline comments off, where the VCS requires one.
 *
 * Some providers accept a standalone inline comment; others only accept one
 * attached to an open review, which must be created first and submitted after.
 * Both are expressed as capabilities, so the protocol is config, not code: a
 * provider that needs no review simply maps neither, and these become no-ops.
 */
export async function beginReview(
  context: PostingContext,
): Promise<{ status: "opened" | "skipped" | "failed"; error?: string }> {
  if (context.mode === "dry-run") {
    return { status: "skipped" };
  }
  const tool = capability(context, "beginReview");
  if (!tool) {
    return { status: "skipped" };
  }
  try {
    await call(context, tool, {});
    return { status: "opened" };
  } catch (error) {
    // An already-open review is the common case on a re-run and is not a
    // failure: the comments still attach to it.
    const message = (error as Error).message;
    return /already|pending|exists/i.test(message)
      ? { status: "opened" }
      : { status: "failed", error: message };
  }
}

/** Submit the open review, making its inline comments visible. */
export async function submitReview(
  context: PostingContext,
  decision?: string,
): Promise<{ status: "submitted" | "skipped" | "failed"; error?: string }> {
  if (context.mode === "dry-run") {
    return { status: "skipped" };
  }
  const tool = capability(context, "submitReview");
  if (!tool) {
    return { status: "skipped" };
  }
  try {
    await call(context, tool, {
      ...(decision ? { event: decision, state: decision } : {}),
    });
    return { status: "submitted" };
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}

/** Record the review decision, when a capability for it exists. */
export async function setReviewStatus(
  context: PostingContext,
  decision: string,
): Promise<{ status: "set" | "skipped" | "failed"; error?: string }> {
  if (context.mode === "dry-run") {
    return { status: "skipped" };
  }
  const tool = capability(context, "setStatus");
  if (!tool) {
    return { status: "skipped" };
  }
  try {
    await call(context, tool, {
      status: decision,
      state: decision,
      event: decision,
    });
    return { status: "set" };
  } catch (error) {
    return { status: "failed", error: (error as Error).message };
  }
}
