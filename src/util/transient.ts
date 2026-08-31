/**
 * Which provider failures are worth trying again (TASKS:Y2.2).
 *
 * A stage's schema gate retries a BAD ANSWER. Nothing retried a FAILED CALL, so one
 * transient hiccup between the runner and the provider ended the whole review — measured
 * live: a Cloudflare 524 in front of an Anthropic proxy, twice, killed a run that had
 * nothing wrong with it. The error even said so itself (`"retryable": true`).
 *
 * The classification is deliberately CONSERVATIVE, and that is the point. Retrying an
 * outage costs a little time; retrying a misconfiguration hides it — a wrong key, a model
 * the team may not use, a malformed request — behind three slow attempts and a late,
 * confusing failure.
 *
 * So the rule is: 5xx, plus the handful of 4xx that describe a CONDITION rather than a
 * mistake (408 request timeout, 409 conflict, 425 too early, 429 rate limit), are
 * transient. Every other 4xx is the caller's fault and fails on the first attempt. When
 * the error carries no usable status at all, the text decides — but only then.
 */

/** Substrings that mark a failure as worth another attempt. Lower-cased comparison. */
const TRANSIENT_MARKERS = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "network error",
  "connection error",
  "timeout",
  "timed out",
  "rate limit",
  "too many requests",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "origin_response_timeout",
] as const;

/**
 * Statuses that are the provider's problem rather than the request's: every 5xx, and the
 * four 4xx that describe a condition to wait out rather than a request to fix.
 */
const TRANSIENT_STATUS = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524,
]);

/** Text a caller can match against, from whatever shape the provider threw. */
const textOf = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`;
  }
  try {
    return JSON.stringify(error ?? "");
  } catch {
    return String(error ?? "");
  }
};

/** A status code, wherever the provider hung it. */
const statusOf = (error: unknown): number | undefined => {
  if (error === null || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  // `status` and `statusCode` only. A numeric `code` is not reliably an HTTP status
  // (Node puts strings there, other SDKs put their own numbering), and this value now
  // DECIDES rather than merely hints — a wrong guess would silence a real retry.
  for (const key of ["status", "statusCode"]) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
};

/**
 * Whether this failure is worth another attempt. A status the provider owns, or an error
 * whose text carries one of the network/timeout/rate-limit markers; anything else is
 * treated as the caller's fault and is not retried.
 */
export const isTransientProviderError = (error: unknown): boolean => {
  const status = statusOf(error);
  if (status !== undefined) {
    // A status the provider set is the ANSWER, and the message does not get to overrule
    // it. Falling through to the text meant a 401 whose body happened to say "timeout",
    // or a 400 quoting the number 500, was retried three times with backoff — inverting
    // the fast-fail this classifier exists to guarantee (caught in review, reproduced).
    return TRANSIENT_STATUS.has(status);
  }
  // No usable status: the text is all there is. This is the shape that started it — an
  // SDK that reports a gateway failure as `Error: 524 {...}` and nothing else.
  const text = textOf(error).toLowerCase();
  // A status can also arrive only inside the message, which is how an SDK that wraps a
  // gateway's JSON body reports it ("524 {...}").
  if (/\b(408|429|500|502|503|504|520|522|524)\b/.test(text)) {
    return true;
  }
  return TRANSIENT_MARKERS.some((marker) => text.includes(marker));
};
