/**
 * The local prompt catalog — the text Yama ships with.
 *
 * This is the fallback every prompt resolves to when no prompt manager is
 * configured, when the platform is unreachable, or when it holds no entry for a
 * given id. That ordering is deliberate: a prompt platform is a convenience for
 * iterating on wording without a release, and it must never be a dependency a
 * review cannot run without. A network outage at a vendor should slow nothing
 * and change nothing.
 *
 * Two rules hold for every entry here and for every remote override of one:
 *
 *  1. **No interpolation.** A prompt is a constant, not a template. Everything
 *     project-specific reaches the agent through tools, which is what keeps the
 *     bytes identical across runs and provider prompt caching applicable.
 *  2. **No config values.** If a prompt would need to know a path, a threshold
 *     or a tool name, that knowledge belongs in a tool result instead.
 */

import { SYSTEM_INSTRUCTION } from "../agents/systemInstruction.js";
import { SUB_AGENTS } from "../agents/subAgents.js";
import { CONFIDENCE_RUBRIC } from "../judge/inline.js";
import { BOOTSTRAP_INSTRUCTIONS } from "../learn/Bootstrap.js";
import type { PromptId } from "../types/index.js";

/**
 * Classifying what a merged pull request taught.
 *
 * Runs once per merged pull request on the cheap chain, over text already in
 * the message. The strictness is the point: this is the one model output that
 * becomes repository content, and a wrong classification teaches the reviewer a
 * lie that persists until someone reverts it.
 */
export const TRIAGE_INSTRUCTION = `You are reading the review conversation on a pull request that has been merged, to work out what it teaches about this repository.

Two questions, and only these two:

1. What did a HUMAN reviewer say that expresses a standing expectation of this codebase?
   - "missed-convention": a rule that would apply to any similar change, and Yama did
     not raise it. Name it in the imperative.
   - "missed-bug": a real defect a human found and Yama did not.
   - "preference": a style choice this team has, weaker than a convention.
   - "context-specific": true only for this change. Most review comments are this, and
     so is anything that teaches nothing at all — praise, questions, chatter.
   Be strict. A comment is a convention only if you could state it as a rule that a
   future author could follow without knowing this pull request existed.

2. For each comment YAMA left, what happened to it?
   - "acted-on": the code changed in response, or the author agreed to change it.
   - "dismissed-no-change": the author ignored it and merged anyway.
   - "argued-down": the author pushed back with a reason. Record the reason.
   - "unresolved": you cannot tell. Use this rather than guessing.

Getting question 2 wrong is expensive: a wrongly-dismissed finding trains Yama to stop
reporting a real defect class. When in doubt, "unresolved".

Return only the structured result.`;

/**
 * Rewriting a pull request description.
 *
 * Separate from the review instruction because it is a different job with a
 * different failure mode: a review that overstates costs the author time, while
 * a description that overstates misleads every future reader of the history.
 */
export const DESCRIPTION_INSTRUCTION = `You are writing the description of a pull request you have just reviewed, for the people who will read it: the reviewer approving it today and whoever bisects to it in two years.

Write what the change does and why, its impact on the running product, the blast radius, and how it should be tested. Prefer what you verified over what the diff implies.

Keep the author's own words where they are already accurate — you are completing a description, not replacing one. Never remove a section a human wrote, never invent a ticket reference, and never claim a test exists that you did not see.

Say plainly what you could not determine rather than filling the section with something plausible.`;

/**
 * Extracting findings from an arbitrary tool's output.
 *
 * The escape hatch for a bespoke script no named parser understands. It reads a
 * command's raw output and nothing else — it never judges the code, because
 * anything it invented here would bypass every check the reviewer's own
 * findings go through.
 */
export const EXTRACTION_INSTRUCTION = `You convert one command's raw output into structured findings. You are a parser, not a reviewer.

Report only what the output itself states. Every finding must correspond to a line the tool actually emitted — never infer a problem the tool did not report, never add advice of your own, and never repeat a summary line as if it were a finding.

Where the output gives a file and a line, carry them through exactly. Where it does not, leave them empty rather than guessing at them.

If the output reports no problems, return no findings. An empty list is the correct answer for a command that succeeded.`;

/** The local text for every prompt id. */
export const LOCAL_PROMPTS: Record<PromptId, string> = {
  "yama-review": SYSTEM_INSTRUCTION,
  "yama-judge": CONFIDENCE_RUBRIC,
  "yama-triage": TRIAGE_INSTRUCTION,
  "yama-bootstrap": BOOTSTRAP_INSTRUCTIONS,
  "yama-description": DESCRIPTION_INSTRUCTION,
  "yama-extraction": EXTRACTION_INSTRUCTION,
  "yama-subagent-impact": subAgentInstruction("investigate_impact"),
  "yama-subagent-security": subAgentInstruction("investigate_security"),
  "yama-subagent-history": subAgentInstruction("investigate_history"),
  "yama-subagent-tests": subAgentInstruction("investigate_tests"),
  "yama-subagent-conventions": subAgentInstruction("investigate_conventions"),
};

/** Every id, in a stable order — what `doctor` walks when it reports sources. */
export const PROMPT_IDS = Object.keys(LOCAL_PROMPTS) as PromptId[];

/** The prompt id serving a given specialist, so one platform entry maps to one agent. */
export function promptIdForSubAgent(agentId: string): PromptId | undefined {
  const id = `yama-subagent-${agentId.replace(/^investigate_/, "")}`;
  return PROMPT_IDS.includes(id as PromptId) ? (id as PromptId) : undefined;
}

function subAgentInstruction(id: string): string {
  const definition = SUB_AGENTS.find((agent) => agent.id === id);
  /* c8 ignore next 3 — unreachable while the ids above match SUB_AGENTS */
  if (!definition) {
    throw new Error(`No sub-agent definition for "${id}".`);
  }
  return definition.instructions;
}
