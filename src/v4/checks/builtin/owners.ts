/**
 * Ownership check — deterministic, no model involved.
 *
 * "Changes under src/payments need someone from @team/data to approve" is a
 * policy question with a factual answer: which files changed, which rules match,
 * who has already approved. None of that benefits from judgement, and all of it
 * suffers from probability. So it is computed.
 *
 * Output is ONE grouped comment, not per-file tags. Tagging is a notification;
 * per-file tagging on a fifty-file PR is a pager storm.
 */

import type {
  ChangeSet,
  EvaluateOwnershipInput,
  OwnershipMatch,
  OwnershipResult,
  OwnershipRule,
} from "../../types/index.js";
import { changedPaths } from "../../changes/ChangeSet.js";
import { matchesAnyPath } from "../../policy/paths.js";
import { renderMarker } from "../../findings/Markers.js";

const normalizeHandle = (handle: string): string =>
  handle.trim().toLowerCase().replace(/^@/, "");

/**
 * Select the rules that govern this change.
 *
 * Default semantics are UNION: every matching rule applies, because two teams
 * can legitimately both own a file. `exclusive: true` opts into CODEOWNERS'
 * last-match-wins, which is what an imported CODEOWNERS file needs to keep
 * behaving the way the team expects.
 */
export function selectOwnershipRules(
  rules: OwnershipRule[],
  changeSet: ChangeSet,
): Array<{ rule: OwnershipRule; paths: string[] }> {
  const paths = changedPaths(changeSet, { includeExcluded: true });

  const matched = rules
    .map((rule) => ({
      rule,
      paths: paths.filter((path) => matchesAnyPath(path, rule.paths)),
    }))
    .filter((entry) => entry.paths.length > 0);

  const exclusive = matched.filter((entry) => entry.rule.exclusive);
  if (exclusive.length === 0) {
    return matched;
  }

  // Last-match-wins, per path: an exclusive rule claims its paths outright, and
  // later exclusive rules override earlier ones.
  const claimed = new Map<string, OwnershipRule>();
  for (const entry of exclusive) {
    for (const path of entry.paths) {
      claimed.set(path, entry.rule);
    }
  }

  const result: Array<{ rule: OwnershipRule; paths: string[] }> = [];
  for (const entry of matched) {
    const owned = entry.paths.filter((path) => {
      const claimant = claimed.get(path);
      return claimant === undefined || claimant.id === entry.rule.id;
    });
    if (owned.length > 0) {
      result.push({ rule: entry.rule, paths: owned });
    }
  }
  return result;
}

export function evaluateOwnership(
  input: EvaluateOwnershipInput,
): OwnershipResult {
  const selected = selectOwnershipRules(input.rules, input.changeSet);
  if (selected.length === 0) {
    return {
      matches: [],
      unsatisfiedBlockingRuleIds: [],
      approvalsUnknown: false,
    };
  }

  const approvalsUnknown = input.approvals === undefined;
  const approved = new Set((input.approvals ?? []).map(normalizeHandle));
  const author = input.author ? normalizeHandle(input.author) : undefined;

  const matches: OwnershipMatch[] = selected.map(({ rule, paths }) => {
    // Most forges refuse an author's approval of their own PR, so counting the
    // author as an owner would produce a requirement nobody can satisfy.
    const owners = rule.owners.filter(
      (owner) => !author || normalizeHandle(owner) !== author,
    );
    const approvedBy = owners.filter((owner) =>
      approved.has(normalizeHandle(owner)),
    );
    const pendingOwners = owners.filter(
      (owner) => !approved.has(normalizeHandle(owner)),
    );
    // When the author-filter leaves NO owners, nothing is required: a rule
    // owned only by the author would otherwise demand approvals nobody can
    // give and block forever while mentioning no one. A non-empty owner list
    // keeps the configured count as-is — a team handle is a group, and two
    // approvals can legitimately come from one @team/x entry.
    const required =
      owners.length === 0 ? 0 : Math.max(0, rule.minApprovals ?? 1);

    return {
      rule,
      paths,
      pendingOwners,
      approvedBy,
      required,
      // Unknown approvals must not read as satisfied — that would silently
      // clear a blocking rule the moment the approvals API is unavailable.
      satisfied: approvalsUnknown ? false : approvedBy.length >= required,
    };
  });

  return {
    matches,
    unsatisfiedBlockingRuleIds: matches
      .filter((match) => match.rule.blocking && !match.satisfied)
      .map((match) => match.rule.id),
    approvalsUnknown,
    comment: renderOwnershipComment(matches, approvalsUnknown),
  };
}

/** One grouped comment: a status table, then the tags that notify people. */
export function renderOwnershipComment(
  matches: OwnershipMatch[],
  approvalsUnknown: boolean,
): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }

  const lines: string[] = ["### Ownership review required", ""];
  lines.push("| Area | Owners | Status |");
  lines.push("| --- | --- | --- |");

  for (const match of matches) {
    const area = match.rule.reason
      ? `${match.rule.id} — ${match.rule.reason}`
      : match.rule.id;
    const owners = match.rule.owners.join(", ");
    const status = approvalsUnknown
      ? "unknown"
      : match.satisfied
        ? `satisfied ${match.approvedBy.length}/${match.required}`
        : `pending ${match.approvedBy.length}/${match.required}`;
    lines.push(`| ${area} | ${owners} | ${status} |`);
  }

  const pending = matches.filter((match) => !match.satisfied);
  if (pending.length > 0) {
    lines.push("");
    for (const match of pending) {
      if (match.pendingOwners.length === 0) {
        continue;
      }
      const files = match.paths.slice(0, 8).join("`, `");
      const more =
        match.paths.length > 8 ? `, and ${match.paths.length - 8} more` : "";
      lines.push(
        `${match.pendingOwners.join(" ")} — ${match.paths.length} file(s) in your area: ` +
          `\`${files}\`${more}`,
      );
    }
  }

  if (approvalsUnknown) {
    lines.push("");
    lines.push(
      "_Approval status could not be read — no `listApprovals` capability is configured, " +
        "so these are listed as required rather than checked._",
    );
  }

  lines.push("");
  lines.push(renderMarker("owners"));
  return lines.join("\n");
}
