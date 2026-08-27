/**
 * File banking, seam-local (TASKS:N3 fallback, docs/engine-spec.md section 5.1).
 *
 * The rule this file exists to enforce: a full payload is written to disk and the
 * conversation gets a bounded preview plus the call that reads the rest back. Nothing is
 * truncated away — a preview is a pointer, not a summary.
 *
 * The read-back tool is named `retrieve_context` and takes `{ artifactId, offset, limit }`,
 * exactly as NeuroLink's own does, so prompts survive the swap verbatim.
 */
import { z } from "zod";
import type {
  EngineBankApi,
  EngineBankRequest,
  EngineBankedRef,
  EngineToolRegistrar,
  RunStorePaths,
} from "../../types/index.js";
import { readPayload, writePayload } from "../../store/index.js";
import { jsonSchemaOf, readParams, refuse } from "../../util/tool.js";

/** Inline preview size. The engine spec's default and hard cap. */
const DEFAULT_PREVIEW_CHARS = 1000;
const MAX_PREVIEW_CHARS = 4000;
/** Characters one `retrieve_context` page returns when the model does not say. */
const DEFAULT_PAGE_CHARS = 4000;

const RetrieveSchema = z.object({
  artifactId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** The verbatim call that reads a banked payload back in full. */
const readBackHint = (id: string): string =>
  `retrieve_context({ artifactId: "${id}", offset: 0, limit: ${DEFAULT_PAGE_CHARS} })`;

/** Banks payloads under `<run store>/reports/` and registers `retrieve_context`. */
export const createBankFallback = (options: {
  register: EngineToolRegistrar;
  paths: RunStorePaths;
}): EngineBankApi => {
  const bank = async (req: EngineBankRequest): Promise<EngineBankedRef> => {
    const { id } = await writePayload(
      options.paths,
      `${req.kind}-${req.label}`,
      req.payload,
    );
    const previewChars = clamp(
      req.previewChars ?? DEFAULT_PREVIEW_CHARS,
      1,
      MAX_PREVIEW_CHARS,
    );
    return {
      id,
      label: req.label,
      sizeBytes: Buffer.byteLength(req.payload, "utf8"),
      preview: req.payload.slice(0, previewChars),
      readBackHint: readBackHint(id),
    };
  };

  const read = async (
    id: string,
    page?: { offset?: number; limit?: number },
  ): Promise<string | undefined> => {
    const content = await readPayload(options.paths, id);
    if (content === undefined) {
      return undefined;
    }
    const offset = page?.offset ?? 0;
    const limit = page?.limit ?? content.length;
    return content.slice(offset, offset + limit);
  };

  options.register("retrieve_context", {
    description:
      "Read a banked artifact back in full, one page at a time. Every preview you are shown names its artifactId — use this rather than acting on the preview alone.",
    inputSchema: jsonSchemaOf(RetrieveSchema),
    execute: async (params) => {
      const parsed = readParams(RetrieveSchema, params);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      const { artifactId } = parsed.value;
      const whole = await readPayload(options.paths, artifactId);
      if (whole === undefined) {
        return refuse(
          `no banked artifact "${artifactId}". Use the artifactId printed with the preview you were given.`,
        );
      }
      const offset = parsed.value.offset ?? 0;
      const limit = parsed.value.limit ?? DEFAULT_PAGE_CHARS;
      const content = whole.slice(offset, offset + limit);
      return {
        artifactId,
        content,
        offset,
        limit,
        totalSize: whole.length,
        hasMore: offset + content.length < whole.length,
      };
    },
  });

  return { bank, read };
};
