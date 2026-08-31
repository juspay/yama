/**
 * Reading what a platform tool actually returned (TASKS:Y4.3, Y4.4).
 *
 * Every forge shapes its results differently, and MCP wraps them again in a `content`
 * envelope whose parts are JSON-in-a-string. Two gates depend on getting a comment id and
 * a comment body out of that: marker dedup, which must know what is already on the target,
 * and posted-=-confirmed, which must know what actually landed.
 *
 * So this reader is deliberately TOLERANT about where the id and the body sit, and
 * deliberately STRICT about what counts as one: an id, and a body, or nothing. Nothing is
 * inferred — a result it cannot read is reported as unreadable, never as success.
 */
import { z } from "zod";
import type { ExistingComment } from "../types/index.js";

/** How deep the reader will unwrap envelopes before giving up. */
const MAX_DEPTH = 4;

const IdSchema = z.union([z.string().min(1), z.number()]);

/** A person, however the forge spells their name. */
const PersonSchema = z.object({
  login: z.string().optional(),
  display_name: z.string().optional(),
  displayName: z.string().optional(),
  name: z.string().optional(),
  username: z.string().optional(),
  nickname: z.string().optional(),
});

/** The spellings real comment APIs use for the fields that matter. */
const CommentSchema = z.object({
  id: IdSchema.optional(),
  comment_id: IdSchema.optional(),
  commentId: IdSchema.optional(),
  /** GitHub's review-thread comments carry NO id field — only this URL, whose anchor
   * (`#discussion_r123` / `#issuecomment-123`) is the comment id by another spelling. */
  html_url: z.string().optional(),
  body: z.string().optional(),
  /** Bitbucket nests the body under `content.raw`; GitHub puts a string there. */
  content: z
    .union([z.string(), z.object({ raw: z.string().optional() })])
    .optional(),
  text: z.string().optional(),
  /** Who wrote it, across the forges. A string on some wrappers, a person on others. */
  user: z.union([z.string(), PersonSchema]).optional(),
  author: z.union([z.string(), PersonSchema]).optional(),
  /** The comment this one answers, as the forge spells it — or as `unwrap` inferred it. */
  parent_id: IdSchema.optional(),
  parentId: IdSchema.optional(),
  in_reply_to_id: IdSchema.optional(),
  __inReplyTo: IdSchema.optional(),
  comment: z
    .object({
      id: IdSchema.optional(),
      body: z.string().optional(),
      content: z
        .union([z.string(), z.object({ raw: z.string().optional() })])
        .optional(),
      raw: z.string().optional(),
    })
    .optional(),
  raw: z.string().optional(),
});

/** A body field that is either the text itself or `{ raw }` around it. */
const bodyOf = (
  value: string | { raw?: string } | undefined,
): string | undefined => (typeof value === "string" ? value : value?.raw);

/**
 * Keys a list of comments hides behind, across the forges and their MCP wrappers.
 * `review_threads` is GitHub's hosted MCP: each thread then hides its own `comments`.
 * `active_comments` is Bitbucket's: a pull-request document carries its comments
 * inline under that key, alongside its own `id` — which is why the record-is-a-comment
 * test below also requires a non-empty body. Without this key the reader returned the
 * pull request itself as one body-less comment and marker dedup saw an empty target,
 * so every re-review posted everything again.
 */
/**
 * Where a comment's own replies hang. Distinct from {@link LIST_KEYS}: these are descended
 * into IN ADDITION to the comment carrying them, never instead of it.
 */
const REPLY_KEYS = ["replies", "children", "responses"] as const;

const LIST_KEYS = [
  "values",
  "comments",
  "items",
  "results",
  "data",
  "review_threads",
  "active_comments",
] as const;

/** MCP tool results arrive as `{ content: [{ type: "text", text: "<json>" }] }`. */
const McpEnvelopeSchema = z.object({
  content: z.array(z.object({ type: z.string().optional(), text: z.string() })),
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A person's name out of whichever field carried it. */
const nameOf = (
  value: z.infer<typeof PersonSchema> | string | undefined,
): string | undefined => {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  return (
    value?.login ??
    value?.display_name ??
    value?.displayName ??
    value?.name ??
    value?.username ??
    value?.nickname
  );
};

/** Comment id, body and author out of one record, whichever spelling the platform used. */
export const readComment = (
  value: unknown,
):
  | { id?: string; body: string; author?: string; inReplyTo?: string }
  | undefined => {
  const parsed = CommentSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const {
    id,
    comment_id,
    commentId,
    html_url,
    body,
    content,
    text,
    comment,
    raw,
    user,
    author,
    parent_id,
    parentId,
    in_reply_to_id,
    __inReplyTo,
  } = parsed.data;
  const anchored = html_url?.match(
    /#(?:discussion_r|issuecomment-)(\d+)$/,
  )?.[1];
  const found = id ?? comment_id ?? commentId ?? comment?.id ?? anchored;
  const wrote = nameOf(user) ?? nameOf(author);
  const answers = parent_id ?? parentId ?? in_reply_to_id ?? __inReplyTo;
  return {
    ...(found !== undefined ? { id: String(found) } : {}),
    ...(wrote !== undefined ? { author: wrote } : {}),
    ...(answers !== undefined ? { inReplyTo: String(answers) } : {}),
    body:
      body ??
      bodyOf(content) ??
      text ??
      raw ??
      comment?.body ??
      bodyOf(comment?.content) ??
      comment?.raw ??
      "",
  };
};

/**
 * One list of comments, read as a THREAD: the first is the comment the rest are answering.
 *
 * GitHub's hosted server hands a review thread over as `review_threads` → `comments`, flat
 * rather than parent-and-children, so parentage has to be read off the position — there is
 * no field carrying it. A list of one, or of records that are not comments, is returned
 * untouched: not every list is a conversation.
 */
const asThread = (records: readonly unknown[]): unknown[] => {
  const head = readComment(records[0]);
  if (records.length < 2 || head?.id === undefined) {
    return [...records];
  }
  return [
    records[0],
    ...records
      .slice(1)
      .map((reply) =>
        reply !== null && typeof reply === "object"
          ? { ...(reply as Record<string, unknown>), __inReplyTo: head.id }
          : reply,
      ),
  ];
};

/**
 * Flattens one tool result into the records it carries. Arrays, MCP content envelopes,
 * JSON-in-a-string and the usual pagination wrappers are all unwrapped; anything else is
 * itself, once.
 */
const unwrap = (value: unknown, depth: number, descend: boolean): unknown[] => {
  if (value === null || value === undefined || depth > MAX_DEPTH) {
    return [];
  }
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined ? [] : unwrap(parsed, depth + 1, descend);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => unwrap(entry, depth + 1, descend));
  }
  if (typeof value !== "object") {
    return [];
  }
  const mcp = McpEnvelopeSchema.safeParse(value);
  if (mcp.success) {
    return mcp.data.content.flatMap((part) =>
      unwrap(part.text, depth + 1, descend),
    );
  }
  // A record that is itself a comment is the answer, not an envelope around one: a
  // comment carrying a `data` array must not be mistaken for a list of comments. It has
  // to have SAID something, though — GitHub's review THREADS carry an id and no body,
  // and mistaking a thread for a comment swallows every comment inside it.
  const self = readComment(value);
  if (self?.id !== undefined && self.body !== "") {
    // …and so is anything nested UNDER it. Bitbucket hangs replies off the comment they
    // answer, and returning the parent alone silently dropped every reply — so `learn`
    // never saw a maintainer's answer to a finding, and the dedup gate never saw a thread
    // it had already been argued out of. The parent comes first, then its replies.
    const record = value as Record<string, unknown>;
    const replies = REPLY_KEYS.flatMap((key) => {
      const nested = record[key];
      return Array.isArray(nested)
        ? nested
            .flatMap((entry) => unwrap(entry, depth + 1, descend))
            // Parentage, kept: "somebody answered finding F7" is a different fact from
            // "somebody commented", and a recurring run has to be able to tell them apart.
            .map((reply) =>
              reply !== null && typeof reply === "object"
                ? {
                    ...(reply as Record<string, unknown>),
                    __inReplyTo: self.id,
                  }
                : reply,
            )
        : [];
    });
    return [value, ...replies];
  }
  // Only a caller that wants the CONTENTS of a document descends into its lists. One
  // that wants the document ITSELF must not: a Bitbucket pull request carries both its
  // description and its comments, and descending returns the comments — which is how
  // adding `active_comments` here silently stopped `readDescription` from ever seeing a
  // Bitbucket description (caught in review, reproduced against the live response).
  if (descend) {
    const record: Record<string, unknown> = { ...value };
    for (const key of LIST_KEYS) {
      const nested = record[key];
      if (Array.isArray(nested)) {
        const flattened = nested.flatMap((entry) =>
          unwrap(entry, depth + 1, descend),
        );
        return key === "review_threads" ? flattened : asThread(flattened);
      }
    }
  }
  return [value];
};

/**
 * Every record a tool result CARRIES: envelopes, JSON-in-a-string and pagination
 * wrappers unwrapped, and lists descended into. This is what comment reading wants.
 */
export const unwrapRecords = (value: unknown, depth = 0): unknown[] =>
  unwrap(value, depth, true);

/**
 * The DOCUMENTS a tool result carries, with the same envelope tolerance but no descent
 * into their lists — what a caller wants when the answer is the document itself rather
 * than the things inside it.
 */
export const unwrapDocuments = (value: unknown): unknown[] =>
  unwrap(value, 0, false);

/**
 * Every comment a tool result carries, in the order it carried them. A record with no id
 * is dropped: dedup binds a finding to the comment id that already holds it, and a comment
 * we cannot name is a comment we cannot bind to.
 */
export const readComments = (value: unknown): ExistingComment[] => {
  const comments: ExistingComment[] = [];
  const seen = new Set<string>();
  for (const record of unwrapRecords(value)) {
    const comment = readComment(record);
    if (comment?.id === undefined || seen.has(comment.id)) {
      continue;
    }
    seen.add(comment.id);
    comments.push({
      id: comment.id,
      body: comment.body,
      ...(comment.author !== undefined ? { author: comment.author } : {}),
      ...(comment.inReplyTo !== undefined
        ? { inReplyTo: comment.inReplyTo }
        : {}),
    });
  }
  return comments;
};

/** The spellings a pull-request body arrives under, across the forges and their wrappers. */
const DescriptionSchema = z.object({
  body: z.string().optional(),
  description: z
    .union([z.string(), z.object({ raw: z.string().optional() })])
    .optional(),
  content: z
    .union([z.string(), z.object({ raw: z.string().optional() })])
    .optional(),
  summary: z
    .union([z.string(), z.object({ raw: z.string().optional() })])
    .optional(),
});

/**
 * The pull request's own description, out of whatever `pr.read` returned (TASKS:Y7.3).
 *
 * `undefined` means "could not be read", which is NOT the same as an empty description:
 * enhancing a description Yama could not read would mean overwriting the author, so the
 * caller has to be able to tell the two apart.
 */
export const readDescription = (value: unknown): string | undefined => {
  for (const record of unwrapDocuments(value)) {
    const parsed = DescriptionSchema.safeParse(record);
    if (!parsed.success) {
      continue;
    }
    const { body, description, content, summary } = parsed.data;
    const found =
      body ?? bodyOf(description) ?? bodyOf(content) ?? bodyOf(summary);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};
