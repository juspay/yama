/**
 * Shared plumbing for every tool Yama registers — the seam-local fallbacks
 * (docs/engine-spec.md section 5.1) and the product's own toolsets alike.
 *
 * Two rules live here. Tool RESULTS keep the same shape whichever implementation is
 * behind them, so the eventual swap to the engine-native primitives is a non-event. And a
 * refusal is a RESULT carrying the recovery instruction — never a thrown error, which the
 * model cannot read and cannot act on.
 */
import { z } from "zod";

/** Refusal shape, matching NeuroLink's `agentToolRegistrar.refusal()`. */
export const refuse = (error: string): { isError: true; error: string } => ({
  isError: true,
  error,
});

/** JSON Schema for a tool's parameters, generated from the zod schema that validates them. */
export const jsonSchemaOf = (schema: z.ZodType): object =>
  z.toJSONSchema(schema, { io: "input" });

/**
 * Validates tool params, returning either the typed value or a refusal that says what the
 * model got wrong. A tool never receives unvalidated input.
 */
export const readParams = <T>(
  schema: z.ZodType<T>,
  params: unknown,
):
  | { ok: true; value: T }
  | { ok: false; refusal: { isError: true; error: string } } => {
  const parsed = schema.safeParse(params ?? {});
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        refusal: refuse(
          `invalid arguments: ${parsed.error.issues
            .map(
              (issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`,
            )
            .join("; ")}. Call the tool again with corrected arguments.`,
        ),
      };
};

const ToolContextSchema = z.object({ sessionId: z.string().min(1).optional() });

/** Session a tool call belongs to: the execution context first, the live stage second. */
export const sessionOf = (context: unknown, fallback: string): string => {
  const parsed = ToolContextSchema.safeParse(context);
  return parsed.success && parsed.data.sessionId !== undefined
    ? parsed.data.sessionId
    : fallback;
};
