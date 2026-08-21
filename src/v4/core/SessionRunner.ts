/**
 * The session runner — one conversation, many supervised turns.
 *
 * v3 ran one hundred-step generate() call and hoped. This runs several bounded
 * turns in one session instead, and inspects between them. The difference is
 * observability: a single long call is a black box until it ends, while a
 * sequence of turns can be watched, corrected, and stopped.
 *
 * The session is what makes turns cheap. Everything the agent has already read
 * stays in the conversation, so a follow-up turn costs a short message rather
 * than a re-sent context.
 */

import type {
  GenerateResponse,
  ModelChainMember,
  SessionOptions,
  StageName,
  SupervisorVerdict,
  TurnResult,
  YamaTool,
} from "../types/index.js";

/** The prefix `registerDelegates` gives every specialist tool. */
const DELEGATE_PREFIX = "delegate_";

/**
 * Stop reasons that mean the model finished saying what it had to say.
 * Everything else — step caps, time limits, stalls, aborts — is a partial turn.
 */
const NATURAL_STOP = new Set([
  "stop",
  "completed",
  "end_turn",
  "finish",
  undefined,
]);

/**
 * Hang protection only.
 *
 * There is deliberately no step or turn default here. A review is bounded by
 * WORK — the agent decides when it is done and the stage predicates verify it.
 * Stall and tool timeouts catch a wedged tool or a hung model call, which is a
 * different thing from a slow one.
 */
const DEFAULT_STALL_TIMEOUT_MS = 180_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;

/**
 * Drives one agent session.
 *
 * Deliberately does NOT own the stage machine or the supervisor: this class
 * knows how to take a turn and report what happened, and the caller decides what
 * that means. Keeping the decision logic out of here is what lets the supervisor
 * stay pure and testable.
 */
export class SessionRunner {
  private turnCount = 0;
  /** Chain member currently in use. Only ever moves forward within a run. */
  private memberIndex = 0;
  /**
   * Set once every member of the chain has failed on one turn.
   *
   * A dead chain does not come back within a run, and the stage machine calls
   * `turn` again for every remaining stage and every remediation attempt. Left
   * unlatched, one unreachable provider becomes minutes of identical failures
   * across seven stages — the same error the design elsewhere refuses to repeat
   * once per member, repeated once per stage instead. Latching it means the
   * first failure is the one the operator reads, and the rest of the run ends
   * in seconds with every stage honestly recorded as failed.
   */
  private chainExhausted: Error | undefined;

  constructor(private readonly options: SessionOptions) {}

  get turns(): number {
    return this.turnCount;
  }

  /** Expose the tools for a stage to the model. */
  setTools(tools: YamaTool[], stage: StageName): void {
    const host = this.options.host;
    if (!host.registerTool) {
      return;
    }
    for (const tool of tools) {
      host.registerTool(tool.name, {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (params: unknown) =>
          tool.execute((params ?? {}) as Record<string, unknown>),
      });
    }
    host.setToolContext?.({
      sessionId: this.options.context.sessionId,
      runId: this.options.context.runId,
      stage,
      dryRun: this.options.context.mode === "dry-run",
    });
  }

  /** Remove tools that must not be reachable in the next stage. */
  clearTools(tools: YamaTool[]): void {
    const host = this.options.host;
    if (!host.unregisterTool) {
      return;
    }
    for (const tool of tools) {
      host.unregisterTool(tool.name);
    }
  }

  /** Take one turn. */
  async turn(
    message: string,
    options: {
      stage: StageName;
      /** Ask for structured output. Omitted for ordinary working turns. */
      schema?: unknown;
      /** Turn tools off — used for a verdict-only turn. */
      disableTools?: boolean;
      /**
       * MCP tools the model must not see this turn. The stage-scoping security
       * control: a review turn reading an attacker-controlled diff has no
       * posting tool in reach, so a prompt injection has nothing to reach for.
       */
      excludeTools?: string[];
      operation?: string;
    },
  ): Promise<TurnResult> {
    this.turnCount += 1;
    const { context, chain } = this.options;

    const response = await this.generateOverChain((member) => ({
      input: { text: message },
      // The system instruction is passed every turn, byte-identical, so the
      // provider's prompt cache applies and the rules never fall out of view.
      systemPrompt: this.options.systemInstruction,
      provider: member?.provider,
      model: member?.model,
      ...(chain.temperature !== undefined
        ? { temperature: chain.temperature }
        : {}),
      ...(chain.maxTokens !== undefined ? { maxTokens: chain.maxTokens } : {}),
      // Only when an operator explicitly configured one.
      ...(this.options.maxStepsPerTurn !== undefined
        ? { maxSteps: this.options.maxStepsPerTurn }
        : {}),
      // The per-call provider timeout, from `ai.timeout`. Self-hosted models can
      // be an order of magnitude slower than a hosted API without being broken,
      // and the runtime's own default would cut them off mid-answer.
      ...(chain.timeout !== undefined ? { timeout: chain.timeout } : {}),
      stallTimeoutMs:
        this.options.stallTimeoutMs ??
        chain.timeout ??
        DEFAULT_STALL_TIMEOUT_MS,
      toolTimeoutMs: this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      // No turnTimeoutMs unless the operator set a run deadline: a review is
      // bounded by work, not by a clock.
      ...(context.deadlineAt !== undefined
        ? { turnTimeoutMs: Math.max(30_000, context.remainingMs()) }
        : {}),
      abortSignal: context.signal,
      // Tool schemas are passed natively rather than injected into the prompt.
      skipToolPromptInjection: true,
      ...(options.schema ? { schema: options.schema } : {}),
      ...(options.disableTools ? { disableTools: true } : {}),
      ...(options.excludeTools && options.excludeTools.length > 0
        ? { excludeTools: options.excludeTools }
        : {}),
      context: {
        sessionId: context.sessionId,
        userId:
          `${context.identity.owner}-${context.identity.repo}`.toLowerCase(),
        operation: options.operation ?? `review-${options.stage}`,
      },
      // Operational turns read memory but never write it: a review must not
      // teach the memory layer anything. Learning happens on merge.
      memory: { read: true, write: false },
    }));

    const result = normalizeTurn(this.turnCount, response);
    this.options.onTurn?.(result);
    return result;
  }

  /** Which chain member served the most recent turn. */
  get activeMember(): number {
    return this.memberIndex;
  }

  /**
   * Take one call, walking the configured chain when a member fails.
   *
   * The chain is Yama's contract with the operator: "if the first model is
   * unavailable, use the second." Honouring it here rather than delegating to
   * the runtime's own pool is deliberate — a pool that silently resolves to some
   * third provider whose credentials happen to be in the environment is worse
   * than a failure, because the run succeeds on a model nobody chose and the
   * report says it worked.
   *
   * This is failover, not retry: each member is tried once. A member that fails
   * for a reason no other member can fix — a malformed request, a bad
   * credential shared by the whole chain — fails the same way everywhere, so
   * the loop stops rather than fanning one clear error into several.
   */
  private async generateOverChain(
    build: (member: ModelChainMember | undefined) => Record<string, unknown>,
  ): Promise<GenerateResponse> {
    const { members } = this.options.chain;
    if (members.length === 0) {
      return this.options.host.generate(build(undefined));
    }

    if (this.chainExhausted) {
      throw this.chainExhausted;
    }

    let lastError: Error | undefined;
    for (let index = this.memberIndex; index < members.length; index += 1) {
      const member = members[index];
      try {
        const response = await this.options.host.generate({
          ...build(member),
          // The runtime's own fallback is pointed back at Yama's chain. Left to
          // itself it resolves to whichever provider happens to have credentials
          // in the environment — the run then succeeds on a model nobody chose
          // and the report says it worked, which is worse than failing.
          providerFallback: async () => null,
        });

        if (isEmptyTurn(response)) {
          // A model can return success with nothing in it: a reasoning model
          // that spends its whole output budget thinking, or a gateway that
          // swallows an upstream error. Nothing is thrown, so without this the
          // turn counts as done and the review quietly reviews nothing.
          lastError = new Error(
            `${describe(member)} returned an empty response (stopReason ` +
              `${response.stopReason ?? "none"}, ` +
              `${response.usage?.output ?? 0} output tokens) and called no tools.`,
          );
          this.options.onFailover?.({
            from: member,
            to: members[index + 1],
            reason: lastError.message,
          });
          continue;
        }

        // Stay on whichever member worked: re-trying a member that just failed
        // costs a full timeout on every subsequent turn of the run.
        this.memberIndex = index;
        return response;
      } catch (error) {
        lastError = error as Error;
        if (
          this.options.context.signal.aborted ||
          !isFailoverWorthy(lastError)
        ) {
          // A bad request or a credential the whole chain shares fails the same
          // way on every stage. Latch it for the same reason as an exhausted
          // chain: the operator needs one clear error, not seven.
          if (!this.options.context.signal.aborted) {
            this.chainExhausted = lastError;
            this.options.onChainExhausted?.(lastError);
          }
          throw lastError;
        }
        this.options.onFailover?.({
          from: member,
          to: members[index + 1],
          reason: lastError.message,
        });
      }
    }

    this.chainExhausted = new Error(
      `Every model in the chain failed. Last error: ${lastError?.message ?? "unknown"}. ` +
        `Chain: ${members
          .map((member) =>
            [member.provider, member.model].filter(Boolean).join("/"),
          )
          .join(" → ")}. No further model calls will be attempted in this run.`,
      { cause: lastError },
    );
    this.options.onChainExhausted?.(this.chainExhausted);
    throw this.chainExhausted;
  }

  /** Inject supervisor guidance as a turn in the same conversation. */
  async guide(
    verdict: SupervisorVerdict,
    stage: StageName,
  ): Promise<TurnResult> {
    return this.turn(verdict.guidance, {
      stage,
      operation: `supervise-${verdict.signals.join("-") || "nudge"}`,
    });
  }

  /** Read back what the agent has actually been doing. */
  async history(): Promise<unknown[]> {
    return (
      (await this.options.host.getConversationHistory?.(
        this.options.context.sessionId,
      )) ?? []
    );
  }
}

/** Normalise a provider response into what the supervisor can reason about. */
export function normalizeTurn(
  turn: number,
  response: GenerateResponse,
): TurnResult {
  const toolCalls = (response.toolExecutions ?? []).map((execution) => ({
    name: execution.toolName ?? "unknown",
    params: safeStringify(execution.params),
    error: execution.isError === true,
    empty: isEmptyResult(execution.result),
  }));

  // What the specialists came back with. Kept apart from `toolCalls` because
  // this is DATA the run acts on — cross-agent agreement raises a finding's
  // confidence — while `toolCalls` is only ever used to detect waste.
  const delegateResults = (response.toolExecutions ?? [])
    .filter((execution) =>
      (execution.toolName ?? "").startsWith(DELEGATE_PREFIX),
    )
    .map((execution) => ({
      agent: (execution.toolName ?? "").slice(DELEGATE_PREFIX.length),
      result: execution.result,
    }));

  return {
    turn,
    content: response.content ?? "",
    structuredData: response.structuredData,
    stopReason: response.stopReason,
    toolCalls,
    delegateResults,
    partial: !NATURAL_STOP.has(response.stopReason),
    usage: response.usage,
    ...(response.jsonRepaired === true ? { jsonRepaired: true } : {}),
    ...(response.jsonTruncated === true ? { jsonTruncated: true } : {}),
  };
}

/**
 * Did a tool come back with nothing useful?
 *
 * Used only for waste detection, so a false positive costs a nudge and a false
 * negative costs nothing. Conservative accordingly.
 */
function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) {
    return true;
  }
  if (typeof result === "string") {
    return result.trim().length === 0;
  }
  if (Array.isArray(result)) {
    return result.length === 0;
  }
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.entries)) {
      return record.entries.length === 0;
    }
    if (typeof record.count === "number") {
      return record.count === 0;
    }
    return Object.keys(record).length === 0;
  }
  return false;
}

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    const text = JSON.stringify(value);
    // Bounded: params only need to be comparable for duplicate detection, and a
    // giant blob would make every comparison expensive and every log unreadable.
    return text.length > 300 ? text.slice(0, 300) : text;
  } catch {
    // Circular or otherwise unserialisable params. The string form is only
    // used to compare calls for duplicate detection, so an approximation is fine.
    return String(value);
  }
}

/**
 * Is this failure worth trying the next model for?
 *
 * A different model fixes an outage, a rate limit, or a context-window
 * overflow. It does not fix a bad request or a credential the whole chain
 * shares, so those stop the loop and surface as themselves — one clear error
 * beats the same error repeated once per member.
 */
export function isFailoverWorthy(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Checked FIRST, because providers phrase a context overflow as an "invalid
  // request" (400). The non-failover test below would match that phrasing and
  // latch the chain dead — when a longer-window fallback member is precisely
  // what fixes a context overflow.
  if (
    /context length|too many tokens|context.*exceed|maximum.*context/.test(
      message,
    )
  ) {
    return true;
  }

  if (
    /invalid[_ ]api[_ ]key|unauthenticated|permission[_ ]denied|invalid request|400 bad request/.test(
      message,
    )
  ) {
    return false;
  }

  return (
    /5\d\d|internal|unavailable|overloaded|timeout|timed out|econn|socket hang up|fetch failed|network|rate limit|429|quota|capacity|not found|context length|too many tokens/.test(
      message,
    ) ||
    // An unrecognised failure is treated as worth one more model. The cost is a
    // second attempt; the cost of the opposite is a review that stops because a
    // provider returned something this list has not seen.
    true
  );
}

const describe = (member: ModelChainMember): string =>
  [member.provider, member.model].filter(Boolean).join("/");

/**
 * A turn that did nothing.
 *
 * Empty content is only a failure when the model also called no tools: a turn
 * that reads three files and says nothing has done real work, and the next turn
 * builds on it. A turn with neither is indistinguishable from the model being
 * unavailable, and counting it as success is how a review ends having reviewed
 * nothing while reporting that it ran.
 */
export function isEmptyTurn(response: GenerateResponse): boolean {
  return (
    (response.content ?? "").trim().length === 0 &&
    (response.toolExecutions ?? []).length === 0
  );
}
