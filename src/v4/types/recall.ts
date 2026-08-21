/**
 * Types for the recall layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */

/** One retrievable item, whatever its origin. */
export type RecallEntry = {
  /** Citation id. Appears in findings as `[id]`. */
  id: string;
  title: string;
  summary: string;
  /** Full text, returned only for top matches. */
  body?: string;
  /** Where it came from, so the agent can weigh it. */
  kind: RecallKind;
  paths?: string[];
  aliases?: string[];
  keywords?: string[];
  domain?: string;
  severity?: string;
  blocking?: boolean;
  /** Grows as `yama learn` sees a convention recur. Ranks, never gates. */
  weight?: number;
};

export type RecallKind =
  | "rule"
  | "convention"
  | "suppression"
  | "product"
  | "profile"
  | "pr-context"
  | "doc";

export type RecallQuery = {
  /** Free text. Optional when scoping by path alone. */
  query?: string;
  /** Restrict to entries governing these paths. */
  paths?: string[];
  /** Restrict to one origin. `pr` returns this pull request's accumulated notes. */
  scope?: RecallKind | "pr" | "all";
  limit?: number;
};

export type RecallResult = {
  entries: RecallEntry[];
  /** Entries that matched but did not fit the limit. */
  omitted: number;
  /** Rendered for the agent, with citation ids. */
  text: string;
};
