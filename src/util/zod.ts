/** Shared zod helpers. One rendering of validation issues, so every layer reads the same. */
import type { z } from "zod";

/** `path.to.field: message; other: message` — the form config errors and store errors use. */
export const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`,
    )
    .join("; ");
