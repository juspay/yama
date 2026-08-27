/**
 * One structured checkpoint on the main session (TASKS:Y2.2).
 *
 * NeuroLink reports JSON health as two independent flags; the seam folds them into the one
 * boolean the schema gate actually needs. A repaired or truncated object still reaches the
 * caller on `raw.structured` — evidence is never discarded, it is only distrusted.
 */
import type { NeuroLink } from "@juspay/neurolink";
import { z } from "zod";
import type {
  EngineConfig,
  EngineRawResult,
  EngineToolResult,
  StructuredRequest,
  StructuredResult,
} from "../types/index.js";

/**
 * How much of each tool result the engine keeps for us. The default is ~8 KB, which is
 * enough for a comment id and a marker but not for a platform that echoes a whole file.
 * Raised here because the confirmation gate (TASKS:Y4.4) reads these results as EVIDENCE —
 * a marker lost to a capture bound would read as "never posted".
 */
const TOOL_RESULT_CHARS = 65_536;

/** Marker NeuroLink appends when it had to bound a captured result. */
const TRUNCATION_MARK = "…[truncated";

/** JSON when the tool returned JSON, the raw text otherwise. Never discarded. */
const parseResult = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * The schema, restated inside the prompt. The first live trial (juspay/yama PR #88,
 * litellm→vLLM) failed exactly here: the gateway honoured no native schema enforcement,
 * the stage prompt described the shape only in prose, and the model answered with
 * near-miss field names (`title`/`file` where the schema says `statement`/`source`).
 * Restating the contract costs a few hundred tokens and holds on a provider that
 * honours nothing but text; where native enforcement works it is harmless repetition.
 */
const shapeHint = (schema: z.ZodType): string | undefined => {
  try {
    return JSON.stringify(z.toJSONSchema(schema));
  } catch {
    return undefined;
  }
};

/** Builds the `generateStructured` member for one engine instance. */
export const createStructuredCall = (
  nl: NeuroLink,
  cfg: EngineConfig,
  onSession: (sessionId: string) => void,
) => {
  return async <T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> => {
    onSession(req.sessionId);
    // Stamps every tool call made during this stage with the run's session id.
    nl.setToolContext({ sessionId: req.sessionId });

    const shape = shapeHint(req.schema);
    const prompt = shape
      ? `${req.prompt}\n\nAnswer with ONE JSON object that validates against this JSON Schema — use these exact field names and no substitutes:\n${shape}`
      : req.prompt;

    const result = await nl.generate({
      input: { text: prompt },
      systemPrompt: cfg.systemPrompt,
      schema: req.schema,
      provider: cfg.model.provider,
      model: cfg.model.model,
      modelChain: cfg.model.modelChain,
      maxSteps: req.maxSteps ?? cfg.maxSteps,
      timeout: cfg.timeoutMs,
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
      toolFilter: req.tools,
      toolExecutionCapture: { maxResultChars: TOOL_RESULT_CHARS },
      // One session per run: NeuroLink keys conversation memory off context.sessionId.
      context: { sessionId: req.sessionId },
    });

    const raw: EngineRawResult = {
      content: result.content,
      structured: result.structuredData,
      repaired: result.jsonRepaired === true,
      truncated: result.jsonTruncated === true,
      provider: result.provider,
      model: result.model,
      stepsUsed: result.stepsUsed,
      toolsUsed: result.toolsUsed,
      toolResults: (result.toolExecutions ?? []).map(
        (record): EngineToolResult => ({
          name: record.toolName,
          params: record.params,
          result: parseResult(record.resultText),
          isError: record.isError,
          truncated: record.resultText.includes(TRUNCATION_MARK),
        }),
      ),
    };

    const parsed = req.schema.safeParse(result.structuredData);
    return {
      data: parsed.success ? parsed.data : undefined,
      trusted: parsed.success && !raw.repaired && !raw.truncated,
      raw,
    };
  };
};
