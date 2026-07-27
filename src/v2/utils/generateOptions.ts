/**
 * Optional fragments for NeuroLink generate() option objects.
 */

/**
 * Spreadable temperature fragment. Yama never defaults temperature: when the
 * user has not configured one, the field is omitted from the generate() call
 * entirely so the provider's own default applies. Non-finite values (e.g. a
 * bare `temperature:` YAML key parsing to null) are treated as unset.
 */
export function temperatureOption(value: unknown): { temperature?: number } {
  return typeof value === "number" && Number.isFinite(value)
    ? { temperature: value }
    : {};
}
