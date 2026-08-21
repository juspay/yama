/**
 * Where a prompt's text comes from.
 *
 * Yama ships every prompt it needs (`./local.ts`). A prompt manager is an
 * optional override on top of that, so wording can be iterated without cutting
 * a release — which matters most for the review instruction, where a one-line
 * change to the false-positive taxonomy is a config change in spirit and a
 * package publish in practice.
 *
 * Three properties hold, in this order of importance:
 *
 *  1. **The platform can never fail a review.** Every failure path — no
 *     credentials, no network, no such prompt, a timeout, the SDK not installed
 *     — resolves to the local text and adds a warning. Nothing throws.
 *  2. **Resolution happens once, before the first turn.** The text is then
 *     fixed for the run, so every turn sends byte-identical bytes and provider
 *     prompt caching still applies. A prompt that changed mid-run would also
 *     mean two halves of one review ran under different instructions.
 *  3. **The source is always reported.** `doctor` and the run report name which
 *     prompts came from the platform and which fell back, because "we are
 *     running the prompt we think we are running" is not something to assume.
 */

import type {
  PromptCatalog,
  PromptFetcher,
  PromptId,
  PromptStoreOptions,
  PromptsConfig,
  ResolvedPrompt,
} from "../types/index.js";
import { LOCAL_PROMPTS, PROMPT_IDS } from "./local.js";

/** Env vars the credentials are read from when config does not rename them. */
const DEFAULT_PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";
const DEFAULT_SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";
const DEFAULT_BASE_URL_ENV = "LANGFUSE_BASE_URL";
const DEFAULT_TIMEOUT_MS = 10_000;

/** The text Yama ships for one prompt. Always available, never null. */
export function localPrompt(id: PromptId): string {
  return LOCAL_PROMPTS[id];
}

/** A catalog that never consults a platform. The default everywhere. */
export function localCatalog(): PromptCatalog {
  return {
    get: localPrompt,
    resolved: PROMPT_IDS.map((id) => ({
      id,
      text: LOCAL_PROMPTS[id],
      source: "local" as const,
    })),
    warnings: [],
  };
}

/** Which ids this configuration wants from the platform. */
export function requestedIds(config: PromptsConfig): PromptId[] {
  if (!config.only || config.only.length === 0) {
    return PROMPT_IDS;
  }
  const wanted = new Set(config.only);
  return PROMPT_IDS.filter((id) => wanted.has(id));
}

/**
 * Resolve every prompt for a run.
 *
 * Fetches happen in parallel and each is individually recoverable: one prompt
 * missing from the platform must not push the other ten back to local text,
 * because a half-configured platform is the normal state of one being adopted.
 */
export async function resolvePrompts(
  options: PromptStoreOptions,
): Promise<PromptCatalog> {
  const { config, env } = options;

  if (config.enabled !== true) {
    return localCatalog();
  }

  const fetcher: { fetch: PromptFetcher } | { error: string } = options.fetcher
    ? { fetch: options.fetcher }
    : await createFetcher(config, env);
  if ("error" in fetcher) {
    const catalog = localCatalog();
    return {
      ...catalog,
      resolved: catalog.resolved.map((entry) => ({
        ...entry,
        reason: fetcher.error,
      })),
      warnings: [
        `Prompt manager is enabled but unavailable: ${fetcher.error}. Every prompt ` +
          `falls back to the text Yama ships, so the review is unaffected.`,
      ],
    };
  }

  const wanted = new Set(requestedIds(config));
  const warnings: string[] = [];

  const resolved = await Promise.all(
    PROMPT_IDS.map(async (id): Promise<ResolvedPrompt> => {
      const fallback = LOCAL_PROMPTS[id];
      if (!wanted.has(id)) {
        return { id, text: fallback, source: "local" };
      }
      try {
        const remote = await fetcher.fetch(id, fallback);
        const text = remote.text.trim();
        if (text.length === 0 || text === fallback) {
          // The platform answered with the fallback, or with nothing usable.
          // Either way this prompt is not managed there yet — normal during
          // adoption, and not worth a warning.
          return { id, text: fallback, source: "local" };
        }
        return {
          id,
          text,
          source: "remote",
          ...(remote.version ? { version: remote.version } : {}),
        };
      } catch (error) {
        const reason = (error as Error).message;
        warnings.push(
          `Prompt "${id}" could not be fetched (${reason}); using the text Yama ships.`,
        );
        return { id, text: fallback, source: "local", reason };
      }
    }),
  );

  // Enabled, asked for prompts, and got none. The platform SDK answers with the
  // fallback it was handed both when a prompt does not exist and when it could
  // not be reached, so those two cannot be told apart per prompt — but ALL of
  // them coming back unmanaged is far more likely a credential or connectivity
  // problem than a platform where nobody has written anything yet. Worth one
  // line, because the alternative is a team believing their edits are live.
  if (
    warnings.length === 0 &&
    resolved.every((entry) => entry.source === "local")
  ) {
    warnings.push(
      `Prompt management is enabled but every prompt resolved to the text Yama ships. ` +
        `Either nothing is published under these ids yet, or the platform could not be ` +
        `reached — check the credentials and base URL. The review is unaffected.`,
    );
  }

  const byId = new Map(resolved.map((entry) => [entry.id, entry.text]));
  return {
    get: (id) => byId.get(id) ?? LOCAL_PROMPTS[id],
    resolved,
    warnings,
  };
}

/** One line per prompt for `yama doctor`, so the source is visible not implied. */
export function describePrompts(catalog: PromptCatalog): string[] {
  return catalog.resolved.map((entry) =>
    entry.source === "remote"
      ? `${entry.id.padEnd(28)} platform${entry.version ? ` v${entry.version}` : ""}`
      : `${entry.id.padEnd(28)} built in${entry.reason ? ` (${entry.reason})` : ""}`,
  );
}

/**
 * Build the platform fetcher.
 *
 * The SDK is imported dynamically so that a deployment which pruned the
 * optional dependency still starts — it degrades to local prompts with a
 * warning rather than failing at module load, which would take the whole CLI
 * down over an optional feature.
 */
async function createFetcher(
  config: PromptsConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ fetch: PromptFetcher } | { error: string }> {
  const publicKey = env[config.publicKeyEnv ?? DEFAULT_PUBLIC_KEY_ENV];
  const secretKey = env[config.secretKeyEnv ?? DEFAULT_SECRET_KEY_ENV];
  const baseUrl = env[config.baseUrlEnv ?? DEFAULT_BASE_URL_ENV];

  if (!publicKey || !secretKey) {
    return {
      error:
        `${config.publicKeyEnv ?? DEFAULT_PUBLIC_KEY_ENV} and ` +
        `${config.secretKeyEnv ?? DEFAULT_SECRET_KEY_ENV} are not both set`,
    };
  }

  let Client: new (options: Record<string, unknown>) => LangfuseLike;
  try {
    const module = (await import("langfuse")) as unknown as {
      Langfuse: new (options: Record<string, unknown>) => LangfuseLike;
    };
    Client = module.Langfuse;
  } catch (error) {
    return {
      error: `the prompt platform SDK is not installed (${(error as Error).message})`,
    };
  }

  let client: LangfuseLike;
  try {
    client = new Client({
      publicKey,
      secretKey,
      ...(baseUrl ? { baseUrl } : {}),
    });
  } catch (error) {
    return { error: (error as Error).message };
  }

  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    fetch: async (id, fallback) => {
      const prompt = await client.getPrompt(id, config.version, {
        type: "text",
        fallback,
        fetchTimeoutMs: timeout,
        ...(config.label ? { label: config.label } : {}),
        // Cached for the process, which lasts one run. Re-fetching per prompt
        // id within a run would be a network call for a value that cannot have
        // changed since the run started.
        cacheTtlSeconds: 0,
      });
      return {
        text: typeof prompt.prompt === "string" ? prompt.prompt : fallback,
        ...(prompt.isFallback !== true && prompt.version !== undefined
          ? { version: String(prompt.version) }
          : {}),
      };
    },
  };
}

/** The slice of the platform SDK this module uses. Structural, so it is fakeable. */
type LangfuseLike = {
  getPrompt(
    name: string,
    version?: number,
    options?: Record<string, unknown>,
  ): Promise<{ prompt: unknown; version?: number; isFallback?: boolean }>;
};
