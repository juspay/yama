/**
 * Types for the triage layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { FindingSeverity, RuleEntry } from "./config.js";

/** How a human comment was classified. */
export type CommentClassification =
  | "missed-convention"
  | "missed-bug"
  | "preference"
  | "context-specific";

/** What happened to a Yama comment. */
export type YamaCommentOutcome =
  | "acted-on"
  | "dismissed-no-change"
  | "argued-down"
  | "unresolved";

export type TriagedHumanComment = {
  classification: CommentClassification;
  /** Slug of the convention this comment expresses, for clustering. */
  conventionKey: string;
  title: string;
  summary: string;
  paths?: string[];
  severity?: FindingSeverity;
  author?: string;
  /** The comment's own permalink or id, kept as evidence. */
  evidence?: string;
};

export type TriagedYamaComment = {
  findingId: string;
  outcome: YamaCommentOutcome;
  title: string;
  /** Why the author pushed back, when they did. */
  reason?: string;
};

export type LearningUpdate = {
  rules: RuleEntry[];
  /** Human-readable account of what changed, for the commit body. */
  changes: string[];
};

/** What a knowledge write produced, for the commit that carries it. */
export type KnowledgeWriteResult = {
  /** Repository-relative paths written. The git writer scopes its add to these. */
  paths: string[];
  ruleCount: number;
};
