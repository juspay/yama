/**
 * Specialist sub-agents.
 *
 * These are delegation targets, not a fixed fan-out. The main agent decides
 * whether a question is worth isolating — the concurrency tier only caps how
 * many may run at once. That ordering matters: a mandatory seven-way fan-out on
 * a one-line change is waste, and no amount of parallelism makes it thorough.
 *
 * Each specialist has one job, a narrow prompt, read-only tools, and a schema.
 * None of them can post: the main agent owns every posting decision, because
 * only it can see the whole change and dedupe across specialists.
 */

import { z } from "zod";
import type {
  ConcurrencyPower,
  FindingSeverity,
  SubAgentDefinition,
  SubAgentReport,
} from "../types/index.js";

export const subAgentFindingSchema = z.object({
  severity: z.enum(["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]),
  title: z.string(),
  description: z.string().optional(),
  filePath: z.string().optional(),
  line: z.number().nullish(),
  suggestion: z.string().optional(),
  impact: z.string().optional(),
  evidence: z.string().optional(),
  ruleId: z.string().optional(),
});

export const subAgentReportSchema = z.object({
  summary: z.string(),
  findings: z.array(subAgentFindingSchema),
  /** What the specialist could not determine. Honesty beats false completeness. */
  openQuestions: z.array(z.string()).optional(),
});

// These are Yama's own tool names, not a server's. They must match what
// `buildYamaTools` and `buildWorkspaceTools` register, or a specialist starts
// with a tool list naming things that do not exist.
const READ_TOOLS = [
  "recall",
  "check_results",
  "read_file",
  "list_files",
  "search_code",
];
const GIT_TOOLS = [...READ_TOOLS, "git"];

/**
 * The specialists.
 *
 * `impact` is the one nothing else does, and the reason Yama is more than a
 * linter with opinions: it asks what a change does to the running product, not
 * whether the diff is well-formed.
 */
export const SUB_AGENTS: SubAgentDefinition[] = [
  {
    id: "investigate_impact",
    name: "Impact",
    description:
      "Trace what a change does to the running product: which callers and " +
      "dependents are affected, what behaviour changes for them, what breaks " +
      "silently, and what a rollback would cost. Delegate when a change touches " +
      "shared code, a contract, or anything with callers you cannot see in the diff.",
    instructions:
      "You assess blast radius. For each changed symbol, find its callers and " +
      "dependents, then reason about what changes for them: contracts, error " +
      "paths, ordering, concurrency, and backward compatibility. Recall the " +
      "product capability map for the paths involved and use its recorded failure " +
      "modes and change history. Report what will break and for whom — not what " +
      "the diff says, what the system will do. Say plainly what you could not " +
      "trace rather than assuming it is safe.",
    tools: GIT_TOOLS,
    tier: "strong",
  },
  {
    id: "investigate_security",
    name: "Security",
    description:
      "Look for injection, unsafe deserialization, authz gaps, exposed secrets, " +
      "SSRF, and unsafe handling of external input. Delegate when a change touches " +
      "input handling, authentication, or anything reachable from outside.",
    instructions:
      "You look for security defects in the changed code. Trace how external " +
      "input reaches the change and what it can do there. Report only what you " +
      "can demonstrate a path to — a theoretical vulnerability with no reachable " +
      "path wastes the author's time. Every finding names the entry point and the " +
      "sink.",
    tools: GIT_TOOLS,
    tier: "strong",
  },
  {
    id: "investigate_history",
    name: "History",
    description:
      "Read git history and blame on the changed lines to see whether this change " +
      "undoes something deliberate. Delegate when a change modifies code that looks " +
      "unusual, defensive, or hard to explain from the diff alone.",
    instructions:
      "You provide historical context. Use blame and log on the changed lines to " +
      "find why the current code is the way it is. Look for a fix being reverted, " +
      "a workaround being removed, or a comment explaining a constraint the change " +
      "ignores. Report only where history genuinely contradicts the change.",
    tools: GIT_TOOLS,
    tier: "cheap",
  },
  {
    id: "investigate_tests",
    name: "Tests",
    description:
      "Judge whether the change is adequately tested and name the specific cases " +
      "that are missing. Delegate when a change alters behaviour, and always when " +
      "it touches something the project treats as critical.",
    instructions:
      "You assess test adequacy. Find the tests covering the changed code. Judge " +
      "whether they exercise the new behaviour, its edge cases, and its failure " +
      "paths. Where coverage is missing, write the specific test cases that should " +
      "exist — names and the condition each asserts, not a general request for " +
      "'more tests'. Follow the project's existing test conventions.",
    tools: READ_TOOLS,
    tier: "cheap",
  },
  {
    id: "investigate_conventions",
    name: "Conventions",
    description:
      "Check the change against this project's recorded conventions and rules. " +
      "Delegate when you want a focused compliance pass over a group of files.",
    instructions:
      "You check compliance with this project's recorded conventions. Recall the " +
      "rules governing each file before judging it, and cite the rule id in every " +
      "finding. Report nothing that no recorded rule covers — an unwritten " +
      "preference is not a convention, and inventing one erodes trust in all of them.",
    tools: READ_TOOLS,
    tier: "cheap",
  },
];

export function findSubAgent(id: string): SubAgentDefinition | undefined {
  return SUB_AGENTS.find((agent) => agent.id === id);
}

/** Delegation caps per concurrency tier. */
export const DELEGATION_CAPS: Record<
  ConcurrencyPower,
  { maxConcurrent: number; maxPerTurn: number; poolQueueTimeoutMs: number }
> = {
  high: { maxConcurrent: 8, maxPerTurn: 6, poolQueueTimeoutMs: 60_000 },
  medium: { maxConcurrent: 4, maxPerTurn: 3, poolQueueTimeoutMs: 45_000 },
  low: { maxConcurrent: 1, maxPerTurn: 1, poolQueueTimeoutMs: 30_000 },
};

/**
 * Normalise a specialist's report into gate-ready candidate findings.
 *
 * Severity is preserved as reported — the gate applies severity floors and the
 * judge scores confidence, so re-grading here would be a third opinion nobody
 * asked for.
 */
export function reportToCandidates(
  report: SubAgentReport,
  agentId: string,
): Array<{
  severity: FindingSeverity;
  title: string;
  description?: string;
  filePath?: string;
  line?: number | null;
  suggestion?: string;
  impact?: string;
  evidence?: string;
  ruleId?: string;
  source: "agent";
  category: string;
}> {
  return report.findings.map((finding) => ({
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    filePath: finding.filePath,
    line: finding.line ?? null,
    suggestion: finding.suggestion,
    impact: finding.impact,
    evidence: finding.evidence,
    ruleId: finding.ruleId,
    source: "agent" as const,
    category: agentId,
  }));
}
