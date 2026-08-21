/**
 * One schema-bound model call, with the chain walked and the answer validated.
 *
 * Everything Yama asks a model for outside the review conversation — a
 * confidence score, a parsed tool output, a classification of what a merge
 * taught — is a structured call. Each one names a schema, and the answer is
 * validated against that schema before any code acts on it.
 *
 * This is the difference between a harness and a hope. A model asked for JSON
 * in prose returns JSON most of the time; the rest of the time it returns an
 * apology, a fenced block with a trailing comma, or a preamble explaining what
 * it is about to return. v3 parsed those by hand and treated a parse failure as
 * an absent result, so a malformed answer and a clean review were the same
 * event. Here a schema goes over the wire, the runtime enforces it natively
 * where the provider can and coerces it where the provider cannot, and anything
 * that still does not validate is reported as a failure rather than as nothing
 * to say.
 *
 * The two damage flags the runtime returns are surfaced rather than swallowed:
 * a repaired answer is usable but worth knowing about, and a truncated one is a
 * token cap the operator has to raise.
 */

import type {
  GenerateResponse,
  ModelChainMember,
  StructuredCallOptions,
  StructuredCallResult,
} from "../types/index.js";
import { isEmptyTurn, isFailoverWorthy } from "./SessionRunner.js";

const describe = (member: ModelChainMember | undefined): string =>
  member
    ? [member.provider, member.model].filter(Boolean).join("/")
    : "default";

/**
 * Ask for a structured answer, walking the chain when a member cannot give one.
 *
 * Never throws for a model-side failure: the caller decides what an unusable
 * answer means, and for most callers it means "degrade this one feature", not
 * "fail the review". What it never does is return a plausible-looking empty
 * result — an absent `data` with a warning is the honest shape.
 */
export async function generateStructured<T>(
  options: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  const { chain, context, schema } = options;
  const warnings: string[] = [];
  const members: Array<ModelChainMember | undefined> =
    chain.members.length > 0 ? [...chain.members] : [undefined];

  let lastError: Error | undefined;

  for (const member of members) {
    if (context.signal.aborted) {
      break;
    }

    let response: GenerateResponse;
    try {
      response = await options.host.generate({
        input: { text: options.message },
        systemPrompt: options.systemPrompt,
        ...(member?.provider ? { provider: member.provider } : {}),
        ...(member?.model ? { model: member.model } : {}),
        ...(chain.temperature !== undefined
          ? { temperature: chain.temperature }
          : {}),
        ...(chain.maxTokens !== undefined
          ? { maxTokens: chain.maxTokens }
          : {}),
        ...(chain.timeout !== undefined ? { timeout: chain.timeout } : {}),
        // The schema goes to the provider. Where tools and schemas cannot be
        // combined the runtime falls back to coercing its own text — which is
        // still enforcement, just later.
        schema,
        ...(options.allowTools ? {} : { disableTools: true }),
        skipToolPromptInjection: true,
        abortSignal: context.signal,
        context: {
          // A separate session id: these passes must not enter the review
          // conversation, where they would be re-read as the reviewer's own
          // reasoning on every subsequent turn.
          sessionId: `${context.sessionId}:${options.operation}`,
          userId:
            `${context.identity.owner}-${context.identity.repo}`.toLowerCase(),
          operation: options.operation,
        },
        // Auxiliary passes never teach the memory layer anything.
        memory: { read: false, write: false },
        // Yama walks its own chain; the runtime's fallback would otherwise
        // resolve to whichever provider has credentials in the environment.
        providerFallback: async () => null,
      });
    } catch (error) {
      lastError = error as Error;
      if (context.signal.aborted || !isFailoverWorthy(lastError)) {
        break;
      }
      continue;
    }

    if (isEmptyTurn(response)) {
      lastError = new Error(`${describe(member)} returned an empty response`);
      continue;
    }

    if (response.jsonTruncated === true) {
      warnings.push(
        `${options.operation}: the structured answer from ${describe(member)} was cut off by ` +
          `the output token limit, so it may be incomplete. Raise ai.maxTokens for this slot.`,
      );
    }
    if (response.jsonRepaired === true) {
      warnings.push(
        `${options.operation}: ${describe(member)} returned malformed JSON that had to be ` +
          `repaired before it could be read.`,
      );
    }

    const parsed = schema.safeParse(response.structuredData);
    if (parsed.success && parsed.data !== undefined) {
      return {
        data: parsed.data,
        content: response.content ?? "",
        member: describe(member),
        warnings,
      };
    }

    // The model answered, but not with the shape that was asked for. That is a
    // failed member, not a finished call: the next one may be able to.
    lastError = new Error(
      `${describe(member)} answered but the result did not match the requested schema`,
    );
  }

  warnings.push(
    `${options.operation}: no model in the chain returned a valid structured result` +
      (lastError ? ` (${lastError.message})` : "") +
      ".",
  );

  return { content: "", warnings };
}
