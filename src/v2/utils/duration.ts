/**
 * Duration parsing for config values like "15m", "90s", "2h", "500ms" or a
 * plain number of milliseconds. Returns undefined for absent/invalid input —
 * callers fall back to their own defaults rather than guessing.
 */
export function parseDurationMs(
  value: string | number | undefined | null,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] || "ms").toLowerCase();
  const factor =
    unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  return Math.floor(amount * factor);
}
