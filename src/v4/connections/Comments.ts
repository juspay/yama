/**
 * Reading a VCS's comment list, whatever shape it arrives in.
 *
 * GitHub returns a bare array with `body` and `user.login`. Bitbucket returns
 * `{ values: [...] }` with `content.raw` and `user.display_name`. Neither is
 * wrong; Yama's code should not know either exists.
 *
 * Pure, and separate from the runtime on purpose: this is what marker-based
 * deduplication reads, so getting it wrong duplicates every finding on every
 * re-run — exactly the failure that has to be testable without a network.
 */

import type { ExistingComment } from "../types/index.js";

/** Shape whatever a VCS returned into the comment fields the marker scan needs. */
export function normalizeComments(result: unknown): ExistingComment[] {
  const list = Array.isArray(result)
    ? result
    : result && typeof result === "object"
      ? ((result as Record<string, unknown>).comments ??
        (result as Record<string, unknown>).values ??
        (result as Record<string, unknown>).items ??
        [])
      : [];

  if (!Array.isArray(list)) {
    return [];
  }

  return list.flatMap((raw): ExistingComment[] => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const entry = raw as Record<string, unknown>;
    const body =
      typeof entry.body === "string"
        ? entry.body
        : typeof entry.content === "string"
          ? entry.content
          : typeof (entry.content as Record<string, unknown>)?.raw === "string"
            ? String((entry.content as Record<string, unknown>).raw)
            : "";
    if (!body) {
      return [];
    }
    const user = (entry.user ?? entry.author ?? entry.created_by) as
      | Record<string, unknown>
      | string
      | undefined;
    const author =
      typeof user === "string"
        ? user
        : typeof user?.login === "string"
          ? String(user.login)
          : typeof user?.username === "string"
            ? String(user.username)
            : typeof user?.display_name === "string"
              ? String(user.display_name)
              : undefined;

    return [
      {
        id: String(entry.id ?? entry.comment_id ?? ""),
        body,
        ...(author ? { author } : {}),
        ...(typeof entry.path === "string" ? { filePath: entry.path } : {}),
        ...(typeof entry.line === "number" ? { line: entry.line } : {}),
      },
    ];
  });
}
