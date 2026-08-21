/**
 * Yama's own tools, and the rule for which of them an agent may see.
 *
 * Stage scoping is a security control, not bookkeeping. The agent reviewing a
 * diff is reading attacker-controlled text; if posting tools are in its reach
 * during that turn, a prompt injection in a comment can write to the pull
 * request. So a tool exists for an agent only when the current stage needs it.
 */

import type {
  GateResult,
  IdentifiedFinding,
  McpRole,
  RecallQuery,
  StageName,
  ToolDependencies,
  YamaTool,
} from "../types/index.js";
import { gateFindings } from "../findings/Gate.js";
import { evaluateGuards } from "../policy/guards.js";
import { checkOutcomes } from "../checks/Runner.js";
import { evaluateOwnership } from "../checks/builtin/owners.js";
import { recall } from "./recall.js";

/** The single context door. */
export function recallTool(dependencies: ToolDependencies): YamaTool {
  return {
    name: "recall",
    description:
      "Retrieve this project's conventions, rules, prior learnings, and what earlier " +
      "runs on this pull request already established. Call it before judging code " +
      "against a standard, and cite the ids it returns. Pass `paths` to scope to the " +
      "files you are looking at.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to know." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Scope to entries governing these files.",
        },
        scope: {
          type: "string",
          enum: ["all", "rule", "convention", "suppression", "product", "pr"],
          description:
            "Restrict to one kind of entry. 'pr' returns earlier runs' notes.",
        },
        limit: { type: "number" },
      },
    },
    stages: ["orient", "review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const result = recall(dependencies.entries, params as RecallQuery);
      return {
        text: result.text,
        count: result.entries.length,
        omitted: result.omitted,
      };
    },
  };
}

/** Ownership and guards for a set of paths. */
export function policyCheckTool(dependencies: ToolDependencies): YamaTool {
  return {
    name: "policy_check",
    description:
      "Report who owns the given paths, how many approvals they require, and which " +
      "guards apply (forbidden paths, required checks, severity floors).",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
      },
    },
    stages: ["orient", "review", "checks"],
    roles: ["main", "sub"],
    execute: async () => {
      if (!dependencies.changeSet) {
        return {
          ownership: [],
          guards: [],
          note: "No change set is available yet.",
        };
      }
      const ownership = evaluateOwnership({
        rules: dependencies.ownership,
        changeSet: dependencies.changeSet,
        approvals: dependencies.approvals,
        author: dependencies.author,
      });
      const guards = evaluateGuards(
        dependencies.guards,
        dependencies.changeSet,
        // The real outcomes. Defaulting this told the agent every required
        // check "did not run" even when they had all passed.
        checkOutcomes(dependencies.checkResults),
      );
      return {
        ownership: ownership.matches.map((match) => ({
          rule: match.rule.id,
          owners: match.rule.owners,
          required: match.required,
          satisfied: match.satisfied,
          pending: match.pendingOwners,
          paths: match.paths,
        })),
        approvalsUnknown: ownership.approvalsUnknown,
        guards: guards.findings.map((finding) => ({
          rule: finding.ruleId,
          title: finding.title,
        })),
        requiredChecks: guards.requiredCheckIds,
      };
    },
  };
}

/** What the project's own tools already said. */
export function checkResultsTool(dependencies: ToolDependencies): YamaTool {
  return {
    name: "check_results",
    description:
      "What this project's linters, type checkers and tests reported for this change. " +
      "Read it before reporting anything a tool already reports — duplicating a linter " +
      "is noise.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Restrict to findings in these files.",
        },
      },
    },
    stages: ["review", "checks", "enhance"],
    roles: ["main", "sub"],
    execute: async (params) => {
      const files = Array.isArray(params.files)
        ? (params.files as string[])
        : undefined;
      return {
        checks: dependencies.checkResults.map((result) => ({
          checkId: result.checkId,
          status: result.status,
          reason: result.reason,
          dropped: result.droppedFindings,
          findings: result.findings
            .filter(
              (finding) =>
                !files || !finding.filePath || files.includes(finding.filePath),
            )
            .map((finding) => ({
              file: finding.filePath,
              line: finding.line,
              severity: finding.severity,
              rule: finding.ruleId,
              message: finding.message,
            })),
        })),
      };
    },
  };
}

/**
 * The gate, as a tool.
 *
 * Rejection messages are written for the agent, not for a log: each says what
 * was wrong and what could be done about it, because an agent that is told
 * "rejected" learns nothing and an agent that is told why can act.
 */
export function submitFindingTool(dependencies: ToolDependencies): YamaTool {
  return {
    name: "submit_finding",
    description:
      "Submit candidate findings for review before posting them. Returns which ones " +
      "you may post and why the rest were refused. Never post a comment for a finding " +
      "this tool did not accept.",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"],
              },
              title: { type: "string" },
              description: { type: "string" },
              filePath: { type: "string" },
              line: { type: "number" },
              suggestion: {
                type: "string",
                description:
                  "The concrete fix. Required for CRITICAL and MAJOR.",
              },
              impact: {
                type: "string",
                description: "What breaks, and for whom.",
              },
              evidence: { type: "string" },
              ruleId: { type: "string" },
              category: { type: "string" },
            },
            required: ["severity", "title"],
          },
        },
      },
      required: ["findings"],
    },
    stages: ["review", "checks"],
    roles: ["main"],
    execute: async (params) => {
      const submitted = Array.isArray(params.findings) ? params.findings : [];
      const candidates = (submitted as Array<Record<string, unknown>>)
        .filter(
          (raw) =>
            raw &&
            typeof raw.title === "string" &&
            ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"].includes(
              String(raw.severity),
            ),
        )
        .map((raw) => {
          // Identity is CONTENT-DERIVED, always. A model that invents its own
          // `id` ("finding-1") would defeat cross-run dedup (different id every
          // run → the same comment re-posted forever) and can produce ids the
          // marker pattern cannot re-scan. Whatever the model sent is dropped
          // and the gate recomputes from content.
          const { id: _modelSuppliedId, ...candidate } = raw;
          return {
            ...candidate,
            source: "agent" as const,
          };
        }) as Array<Omit<IdentifiedFinding, "id">>;

      const gate = (confidence?: ReadonlyMap<string, number>): GateResult =>
        gateFindings({
          findings: candidates,
          changeSet: dependencies.changeSet,
          alreadyReported: dependencies.alreadyReported,
          alreadyAccepted: dependencies.ledger.acceptedIds,
          suppressed: dependencies.suppressed,
          checkFlagged: dependencies.checkFlagged,
          ...(confidence ? { confidence } : {}),
          confidenceThreshold: dependencies.confidenceThreshold,
          changedLinesOnly: dependencies.changedLinesOnly,
          guards: dependencies.guards,
          dryRun: dependencies.dryRun,
        });

      // Two passes, and the order is the point. The deterministic invariants run
      // FIRST, so the judge is only ever asked about findings that are already
      // structurally valid, not yet reported, and not already covered by a
      // check. Scoring a batch that the gate was going to reject anyway would
      // spend a model call to change nothing.
      let result = gate(dependencies.confidence);

      if (dependencies.judge) {
        const survivors = result.accepted;
        if (survivors.length > 0) {
          const judged = await dependencies.judge(survivors);
          dependencies.onWarnings?.(judged.warnings);
          if (judged.scores.size > 0) {
            // Re-gating with the scores rather than filtering here keeps every
            // accept/reject decision, and every rejection message, in the gate.
            const merged = new Map(dependencies.confidence ?? []);
            for (const [id, score] of judged.scores) {
              merged.set(id, score);
            }
            result = gate(merged);
          }
        }
      }

      dependencies.ledger.recordGate(result);

      return {
        instruction: result.instruction,
        accepted: result.accepted.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          title: finding.title,
          filePath: finding.filePath,
          line: finding.line,
        })),
        rejected: result.rejected.map((entry) => ({
          title: entry.finding.title,
          reason: entry.reason,
          detail: entry.detail,
        })),
      };
    },
  };
}

/** Every Yama tool, in registration order. */
export function buildYamaTools(dependencies: ToolDependencies): YamaTool[] {
  return [
    recallTool(dependencies),
    policyCheckTool(dependencies),
    checkResultsTool(dependencies),
    submitFindingTool(dependencies),
  ];
}

/** Filter tools to those a given agent may see right now. */
export function toolsForStage(
  tools: YamaTool[],
  stage: StageName,
  role: McpRole,
): YamaTool[] {
  return tools.filter(
    (tool) => tool.stages.includes(stage) && tool.roles.includes(role),
  );
}
