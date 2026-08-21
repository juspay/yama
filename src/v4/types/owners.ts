/**
 * Types for the owners layer.
 *
 * Every exported type lives here rather than beside its logic: the barrel
 * re-exports this folder, so a type declared in a feature module is unreachable
 * through the sanctioned import path.
 */
import type { ChangeSet } from "./changes.js";
import type { OwnershipRule } from "./config.js";

/** One rule that applies to this change, with its current approval state. */
export type OwnershipMatch = {
  rule: OwnershipRule;
  /** Changed paths this rule covers. */
  paths: string[];
  /** Owners still needed. Excludes the author and anyone who already approved. */
  pendingOwners: string[];
  /** Owners who have approved. */
  approvedBy: string[];
  required: number;
  satisfied: boolean;
};

export type OwnershipResult = {
  matches: OwnershipMatch[];
  /** Rules that are blocking and not yet satisfied. Feeds the verdict. */
  unsatisfiedBlockingRuleIds: string[];
  /** True when approvals could not be read; status is reported as unknown. */
  approvalsUnknown: boolean;
  /** The comment body, or undefined when no rule applies. */
  comment?: string;
};

export type EvaluateOwnershipInput = {
  rules: OwnershipRule[];
  changeSet: ChangeSet;
  /** Handles that have approved. Undefined means approvals could not be read. */
  approvals?: string[];
  /** PR author, excluded from their own review requirement. */
  author?: string;
};
