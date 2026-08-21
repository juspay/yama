/**
 * Types for the prompt layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

/**
 * The prompts Yama can serve from a prompt manager.
 *
 * One id per model-facing instruction. Ids are stable and are the names a
 * prompt-management platform stores them under, so renaming one is a breaking
 * change for every repository whose platform already holds an override.
 */
export type PromptId =
  | "yama-review"
  | "yama-judge"
  | "yama-triage"
  | "yama-bootstrap"
  | "yama-description"
  | "yama-extraction"
  | "yama-subagent-impact"
  | "yama-subagent-security"
  | "yama-subagent-history"
  | "yama-subagent-tests"
  | "yama-subagent-conventions";

/** Where a prompt's text actually came from. Always reported, never implied. */
export type PromptSource = "remote" | "local";

export type ResolvedPrompt = {
  id: PromptId;
  text: string;
  source: PromptSource;
  /** The remote version or label that served it, when the source was remote. */
  version?: string;
  /** Why the remote copy was not used. Present only when source is "local". */
  reason?: string;
};

/**
 * Prompt management configuration.
 *
 * Absent means every prompt resolves locally — the same behaviour Yama has
 * without a prompt platform at all, which is what makes this optional rather
 * than a new required dependency.
 */
export type PromptsConfig = {
  /**
   * Whether to consult the remote prompt manager. Default false: a repository
   * that has not configured one must not pay a network timeout per run.
   */
  enabled?: boolean;
  /** Which platform serves prompts. Only one is implemented today. */
  provider?: "langfuse";
  /**
   * Label to fetch, e.g. "production". Mutually exclusive with `version`.
   * Absent means the platform's own default (its production label).
   */
  label?: string;
  /** Pin an exact version instead of a moving label. */
  version?: number;
  /** Per-fetch timeout. A prompt platform must never hold up a review. */
  timeoutMs?: number;
  /**
   * Env var names holding the platform credentials. Named rather than inlined
   * so a secret never lands in a config file that gets committed.
   */
  publicKeyEnv?: string;
  secretKeyEnv?: string;
  baseUrlEnv?: string;
  /**
   * Prompt ids to resolve remotely. Absent means all of them. Useful when a
   * team manages only the main review prompt on the platform.
   */
  only?: PromptId[];
};

/** What a prompt store hands back after resolving everything it was asked for. */
export type PromptCatalog = {
  get(id: PromptId): string;
  resolved: ResolvedPrompt[];
  warnings: string[];
};

/**
 * The remote fetch, isolated behind a function type.
 *
 * Structural, so the store is testable without a network and without the
 * platform SDK installed.
 */
export type PromptFetcher = (
  id: PromptId,
  fallback: string,
) => Promise<{ text: string; version?: string }>;

export type PromptStoreOptions = {
  config: PromptsConfig;
  env: NodeJS.ProcessEnv;
  /** Overrides the built-in fetcher. Tests pass a stub; production omits it. */
  fetcher?: PromptFetcher;
};
