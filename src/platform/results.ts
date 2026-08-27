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

/** The spellings real comment APIs use for the two fields that matter. */
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

/** Keys a list of comments hides behind, across the forges and their MCP wrappers.
 * `review_threads` is GitHub's hosted MCP: each thread then hides its own `comments`. */
const LIST_KEYS = [
  "values",
  "comments",
  "items",
  "results",
  "data",
  "review_threads",
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

/** Comment id and body out of one record, whichever spelling the platform used. */
export const readComment = (
  value: unknown,
): { id?: string; body: string } | undefined => {
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
  } = parsed.data;
  const anchored = html_url?.match(
    /#(?:discussion_r|issuecomment-)(\d+)$/,
  )?.[1];
  const found = id ?? comment_id ?? commentId ?? comment?.id ?? anchored;
  return {
    ...(found !== undefined ? { id: String(found) } : {}),
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
 * Flattens one tool result into the records it carries. Arrays, MCP content envelopes,
 * JSON-in-a-string and the usual pagination wrappers are all unwrapped; anything else is
 * itself, once.
 */
export const unwrapRecords = (value: unknown, depth = 0): unknown[] => {
  if (value === null || value === undefined || depth > MAX_DEPTH) {
    return [];
  }
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined ? [] : unwrapRecords(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => unwrapRecords(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }
  const mcp = McpEnvelopeSchema.safeParse(value);
  if (mcp.success) {
    return mcp.data.content.flatMap((part) =>
      unwrapRecords(part.text, depth + 1),
    );
  }
  // A record that is itself a comment is the answer, not an envelope around one: a
  // comment carrying a `data` array must not be mistaken for a list of comments. It has
  // to have SAID something, though — GitHub's review THREADS carry an id and no body,
  // and mistaking a thread for a comment swallows every comment inside it.
  const self = readComment(value);
  if (self?.id !== undefined && self.body !== "") {
    return [value];
  }
  const record: Record<string, unknown> = { ...value };
  for (const key of LIST_KEYS) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested.flatMap((entry) => unwrapRecords(entry, depth + 1));
    }
  }
  return [value];
};

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
    comments.push({ id: comment.id, body: comment.body });
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
  for (const record of unwrapRecords(value)) {
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
