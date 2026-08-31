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
 * confusing failure. So: network, timeout, rate limit and 5xx are transient; everything
 * else, 4xx above all, fails on the first attempt.
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

/** Statuses that are the provider's problem rather than the request's. */
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
  for (const key of ["status", "statusCode", "code"]) {
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
  if (status !== undefined && TRANSIENT_STATUS.has(status)) {
    return true;
  }
  const text = textOf(error).toLowerCase();
  // A status can also arrive only inside the message, which is how an SDK that wraps a
  // gateway's JSON body reports it ("524 {...}").
  if (/\b(408|429|500|502|503|504|520|522|524)\b/.test(text)) {
    return true;
  }
  return TRANSIENT_MARKERS.some((marker) => text.includes(marker));
};
