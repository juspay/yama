/**
 * Typed JSON read/write for the run store (TASKS:Y2.3).
 *
 * Reads are validated: these files cross process and CI-job boundaries, so "it parsed"
 * is not the same as "it is what I wrote". An absent file is `undefined`; a present but
 * unreadable one throws and names itself.
 */
import type { ZodType } from "zod";
import { readTextFile, writeTextFile } from "../util/fs.js";
import { formatIssues } from "../util/zod.js";
import { StoreError } from "./errors.js";

/** Writes pretty JSON (artifacts get read by humans) and returns the path. */
export const writeJson = async (
  file: string,
  value: unknown,
): Promise<string> =>
  writeTextFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** Reads and validates JSON. Absent file → `undefined`. Corrupt file → `StoreError`. */
export const readJson = async <T>(
  file: string,
  schema: ZodType<T>,
): Promise<T | undefined> => {
  const text = await readTextFile(file);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new StoreError("is not valid JSON", file, error);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StoreError(
      `does not match its schema — ${formatIssues(result.error)}`,
      file,
    );
  }
  return result.data;
};
