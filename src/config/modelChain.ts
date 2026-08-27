/**
 * Model fallback-chain normalization (TASKS:Y1.4).
 *
 * A chain is written as parallel fields. A scalar broadcasts across the whole chain; an
 * array gives one value per link. Two arrays of different lengths are a mistake, not a
 * thing to guess at, so they fail loudly and name both lengths.
 *
 *   models:
 *     main:
 *       provider: [vertex, anthropic]   # 2 links
 *       model: claude-opus-4-5          # broadcast to both
 */
// Needs `export * from "./config.js"` in src/types/index.ts (TASKS:Y1.1 integrate step).
import type {
  ModelChainLink,
  ModelChainSpec,
  ModelChains,
  ModelChainsSpec,
  ModelRole,
} from "../types/index.js";
import { ConfigError } from "./errors.js";

const toArray = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? [...value] : [value];

/** A single-entry field broadcasts; a multi-entry one is indexed. */
const at = (values: string[], index: number): string =>
  values.length === 1 ? values[0] : values[index];

/** Expands one role's spec into an ordered list of links. */
export const normalizeModelChain = (
  role: ModelRole,
  spec: ModelChainSpec,
  file?: string,
): ModelChainLink[] => {
  const provider = Array.isArray(spec.provider)
    ? [...spec.provider]
    : [spec.provider];
  const model = toArray(spec.model);
  const region = toArray(spec.region);

  const fields: [string, string[] | undefined][] = [
    ["provider", provider],
    ["model", model],
    ["region", region],
  ];
  const multi: [string, number][] = fields
    .filter((entry): entry is [string, string[]] => (entry[1]?.length ?? 0) > 1)
    .map(([name, values]) => [name, values.length]);

  const width = multi.length > 0 ? multi[0][1] : 1;
  if (multi.some(([, length]) => length !== width)) {
    throw new ConfigError(
      `models.${role}: fallback chain fields disagree in length — ${multi
        .map(([name, length]) => `${name} has ${length}`)
        .join(", ")}`,
      {
        file,
        hint: "give every multi-valued field the same number of entries, or use a single value to broadcast it across the chain",
      },
    );
  }

  return Array.from({ length: width }, (_unused, index) => ({
    provider: at(provider, index),
    ...(model ? { model: at(model, index) } : {}),
    ...(region ? { region: at(region, index) } : {}),
  }));
};

/**
 * Normalizes every role. `worker` falls back to `main` and `summarizer` to `worker`, so the
 * shell never has to ask whether a role was configured.
 */
export const resolveModelChains = (
  spec: ModelChainsSpec,
  file?: string,
): ModelChains => {
  const main = normalizeModelChain("main", spec.main, file);
  const worker = spec.worker
    ? normalizeModelChain("worker", spec.worker, file)
    : main;
  const summarizer = spec.summarizer
    ? normalizeModelChain("summarizer", spec.summarizer, file)
    : worker;
  return { main, worker, summarizer };
};

/** One-line rendering of a chain, for `yama doctor` and startup logs. */
export const formatModelChain = (chain: ModelChainLink[]): string =>
  chain
    .map((link) => [link.provider, link.model].filter(Boolean).join("/"))
    .join(" -> ");
