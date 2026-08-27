/**
 * Posted = confirmed (TASKS:Y4.4).
 *
 * Delivery is executed agentically, so "the agent said it posted the comment" is not
 * evidence. The evidence is the platform's own tool result: a comment id, and a body
 * carrying the marker. This gate reads those results and reports what actually landed —
 * anything intended but unconfirmed is named out loud rather than assumed.
 *
 * The tolerant reading of a platform result lives in `src/platform/results.ts`, because
 * marker dedup needs exactly the same tolerance. What is strict is the RULE, and it is
 * here: an id AND a marker that matches something we meant to post.
 */
import { readComment, unwrapRecords } from "../platform/results.js";
import { scanMarkers } from "../tools/markers.js";
import type {
  EngineToolResult,
  ExistingComment,
  PostedComment,
  PostingConfirmation,
} from "../types/index.js";

/**
 * Confirms what was posted. A finding counts as posted only when a result carries both a
 * comment id and that finding's marker; everything else is reported, never inferred.
 *
 * `intended` is anything with an id — findings for inline comments, the run id for the
 * summary comment — and `kind` selects which marker family to match (TASKS:Y5.3).
 */
export const confirmPosted = (input: {
  intended: readonly { id: string }[];
  results: readonly unknown[];
  kind?: string;
}): PostingConfirmation => {
  const wanted = new Set(input.intended.map((entry) => entry.id));
  const posted: PostedComment[] = [];
  const unmatched: string[] = [];
  const confirmed = new Set<string>();

  for (const value of input.results) {
    for (const record of unwrapRecords(value)) {
      const result = readComment(record);
      if (result?.id === undefined) {
        continue;
      }
      const ids = scanMarkers(result.body, input.kind).filter((id) =>
        wanted.has(id),
      );
      if (ids.length === 0) {
        unmatched.push(result.id);
        continue;
      }
      for (const findingId of ids) {
        if (!confirmed.has(findingId)) {
          confirmed.add(findingId);
          posted.push({ findingId, commentId: result.id });
        }
      }
    }
  }

  const unposted = [...wanted].filter((id) => !confirmed.has(id));
  return {
    posted,
    unposted,
    unmatched: [...new Set(unmatched)],
    ok: unposted.length === 0 && unmatched.length === 0,
  };
};

/**
 * A creation the platform acknowledged with an id, even though the result echoes no body
 * to scan. GitHub's hosted MCP answers an issue-comment write with `{id, url}` and no
 * body — the id in a clean result is the platform naming the comment it created, which is
 * still platform evidence; the agent's account of the call still is not.
 */
export const confirmCreated = (results: readonly unknown[]): boolean =>
  results.some((value) =>
    unwrapRecords(value).some(
      (record) => readComment(record)?.id !== undefined,
    ),
  );

/**
 * The re-read fallback (TASKS:Y4.4): what the pull request itself now shows. Some forges
 * answer a review-comment write with a bare success string — no id, no body — so tool
 * results alone cannot confirm those posts; GitHub's hosted MCP is one of them. A marker
 * found in a comment read back from the platform is a comment that landed, whatever the
 * write result looked like — which is also why `ok` here stops caring about `unmatched`:
 * an id-bearing result with no marker is noise once the target shows every intended one.
 */
export const confirmFromComments = (input: {
  confirmation: PostingConfirmation;
  comments: readonly ExistingComment[];
  kind?: string;
}): PostingConfirmation => {
  if (input.confirmation.ok || input.comments.length === 0) {
    return input.confirmation;
  }
  const missing = new Set(input.confirmation.unposted);
  const posted = [...input.confirmation.posted];
  for (const comment of input.comments) {
    for (const id of scanMarkers(comment.body, input.kind)) {
      if (missing.delete(id)) {
        posted.push({ findingId: id, commentId: comment.id });
      }
    }
  }
  const unposted = [...missing];
  return {
    posted,
    unposted,
    unmatched: input.confirmation.unmatched,
    ok: unposted.length === 0,
  };
};

/**
 * Whether a named tool ran and did not report an error.
 *
 * Setting a review state or rewriting a description produces no comment and therefore no
 * marker, so the only honest evidence is that the tool itself was invoked and came back
 * clean. That is still a tool RESULT, not the agent's account of one.
 */
export const confirmToolRan = (
  results: readonly EngineToolResult[],
  tool: string | undefined,
): boolean =>
  tool !== undefined &&
  results.some((result) => result.name === tool && !result.isError);

/**
 * The loud half. Returns the message a run must surface when delivery did not land as
 * intended, or `undefined` when everything checks out.
 */
export const postingFailure = (
  confirmation: PostingConfirmation,
): string | undefined => {
  if (confirmation.ok) {
    return undefined;
  }
  const lines: string[] = [];
  if (confirmation.unposted.length > 0) {
    lines.push(
      `${confirmation.unposted.length} finding(s) were never confirmed as posted: ${confirmation.unposted.join(", ")}`,
    );
  }
  if (confirmation.unmatched.length > 0) {
    lines.push(
      `${confirmation.unmatched.length} comment(s) came back carrying no finding marker: ${confirmation.unmatched.join(", ")}`,
    );
  }
  return lines.join("\n");
};
