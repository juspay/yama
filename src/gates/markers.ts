/**
 * Marker dedup, before anything is posted (TASKS:Y4.3).
 *
 * A recurring review must not re-post what it already said. The run store would be the
 * cheap way to know that, but the store is a CI artifact and can be absent — the pull
 * request itself never is. So dedup reads the comments on the target and matches their
 * `<!-- yama:finding:id -->` markers against this run's findings (TASKS:Y5.3).
 *
 * Pure, and deliberately so: nothing here posts, reads a network, or mutates a finding.
 * It answers one question — what is new — and reports the leftovers both ways round.
 */
import { scanMarkers } from "../tools/markers.js";
import type {
  ExistingComment,
  Finding,
  MarkerDedupResult,
  PostedComment,
} from "../types/index.js";

/**
 * Splits this run's findings against what the target already carries.
 *
 * Duplicate ids inside `findings` collapse to the first: two workers reporting the same
 * finding is one finding, and the dedupe belongs here rather than at the posting call.
 */
export const dedupePostedFindings = (input: {
  findings: readonly Finding[];
  comments: readonly ExistingComment[];
}): MarkerDedupResult => {
  const commentByFinding = new Map<string, string>();
  for (const comment of input.comments) {
    for (const id of scanMarkers(comment.body)) {
      if (!commentByFinding.has(id)) {
        commentByFinding.set(id, comment.id);
      }
    }
  }

  const post: Finding[] = [];
  const alreadyPosted: PostedComment[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    if (seen.has(finding.id)) {
      continue;
    }
    seen.add(finding.id);
    const commentId = commentByFinding.get(finding.id);
    if (commentId === undefined) {
      post.push(finding);
    } else {
      alreadyPosted.push({ findingId: finding.id, commentId });
    }
  }

  return {
    post,
    alreadyPosted,
    stale: [...commentByFinding.keys()].filter((id) => !seen.has(id)),
  };
};
