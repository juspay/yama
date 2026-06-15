/**
 * Centralized output-token limits for NeuroLink generate() calls.
 *
 * Yama previously passed `ai.maxTokens` (defaulting to 128000) straight to
 * generate(). 128000 is a context-window size, not an output cap — no model
 * emits that many output tokens, and on the non-streaming Vertex+Claude path it
 * historically tripped the Anthropic SDK's "Streaming is required" guard
 * (expected time > 10 min for maxTokens > ~21333). NeuroLink >= 9.70 clamps
 * per-model server-side, but Yama still clamps to a sane ceiling so configs can
 * never pass absurd values and behavior is consistent across every call site
 * (previous clamps were inconsistent: 16_000 in one place, 12_000 in another,
 * and unclamped in the main review path).
 */

/** Sane default output-token ceiling for review/generation calls. */
export const MAX_OUTPUT_TOKENS = 32_000;

/** Smaller ceiling for lightweight structured-extraction passes. */
export const MAX_EXTRACTION_TOKENS = 12_000;

/**
 * Clamp a requested maxTokens value to a safe ceiling.
 *
 * Returns `cap` when the requested value is missing, non-finite, or non-positive
 * so callers always end up with a usable, bounded number.
 */
export function clampMaxTokens(
  requested: number | undefined | null,
  cap: number = MAX_OUTPUT_TOKENS,
): number {
  if (
    typeof requested !== "number" ||
    !Number.isFinite(requested) ||
    requested <= 0
  ) {
    return cap;
  }
  return Math.min(requested, cap);
}
