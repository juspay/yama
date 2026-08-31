/**
 * Collate and decide (TASKS:Y3.4) — terminal for local and dry-run.
 *
 * The agent reads the banked reports back, fills the gaps with its own tool calls, dedupes
 * and ranks. It does NOT decide the verdict: that is `decideVerdict`, a pure function of
 * the findings and the repository's `verdict:` block, so what a run decided is re-derivable
 * from the store without re-running a model (TASKS:Y5.5).
 *
 * The shell ranks the deduped list itself as well. A model asked to sort by severity will
 * mostly do it; "mostly" is not an ordering, and the posting cap reads off this order.
 */
import {
  checkpointWithSchemaGate,
  decideVerdict,
  rankFindings,
} from "../gates/index.js";
import { READ_ONLY_TOOLS, mergeFindings } from "../tools/index.js";
import type {
  TargetFacts,
  ChecklistGateResult,
  CollateStageResult,
  Finding,
  InsertionPlan,
  OperatingBrief,
  RankedFindings,
  ResolvedConfig,
  RunStorePaths,
  SessionRunner,
  WorkerReport,
} from "../types/index.js";
import { CollationSchema } from "./schema.js";
import { renderTargetFacts } from "./target.js";

/** Enough to page through the banked reports and check the claims that need it. */
const COLLATE_MAX_STEPS = 64;

const describeFinding = (finding: Finding): string =>
  `  ${finding.id}  ${finding.severity}  ${finding.file}:${finding.line}  ${finding.summary}`;

const describeWorker = (worker: WorkerReport): string =>
  `  ${worker.workerId} (${worker.status}${worker.taskId ? `, item ${worker.taskId}` : ""}) — banked at ${worker.reportPath || "(nowhere: the worker produced no report)"}`;

/** What was gathered, what is still open, and what "collated" has to mean here. */
export const buildCollatePrompt = (input: {
  brief: OperatingBrief;
  plan: InsertionPlan;
  findings: readonly Finding[];
  workers: readonly WorkerReport[];
  checklist: ChecklistGateResult;
  /** Still open from the previous review; already counted, never re-reported (Y7.1). */
  carriedOver?: readonly Finding[];
  /** The change itself, so this stage never depends on the last one's prose. */
  facts?: TargetFacts;
}): string => {
  const { brief, plan, findings, workers, checklist } = input;
  const lines: string[] = [
    "COLLATE AND DECIDE. Everything below is what this run gathered. Turn it into the final list.",
    "",
    ...(input.facts !== undefined ? [renderTargetFacts(input.facts), ""] : []),
    "Page the banked reports and check what you need to check — read_file takes a whole file in one call, and its offset and limit are LINES. What this stage does NOT do is review the change again: the findings below are the review.",
    "",
    `Review posture: ${brief.persona}`,
    `What the earlier stage said this change does: ${plan.changeSummary}`,
    "",
    findings.length > 0
      ? `Findings reported while working the checklist (${findings.length}):`
      : "You reported no findings while working the checklist.",
    ...findings.map(describeFinding),
    "",
  ];

  if (workers.length > 0) {
    lines.push(
      "Worker reports, banked in full — read any of them back with retrieve_context before you rely on it:",
      ...workers.map(describeWorker),
      "",
    );
  }

  const carriedOver = input.carriedOver ?? [];
  if (carriedOver.length > 0) {
    lines.push(
      `Still open from the previous review of this target (${carriedOver.length}) — the verdict is taken over these AND yours together:`,
      ...carriedOver.map(describeFinding),
      "They are already counted and already commented on. Do not repeat them in your list; if you found one of them again yourself, keep your version and its id, and it will replace the old one.",
      "",
    );
  }

  lines.push(
    "The checklist as it stands:",
    ...checklist.tasks.map(
      (task) =>
        `  ${task.id} [${task.status}] ${task.title}${task.note ? ` — ${task.note}` : ""}`,
    ),
    "",
  );

  if (!checklist.complete) {
    lines.push(
      "This checklist is NOT finished. Say so in your summary and do not present the review as complete:",
      ...checklist.pending.map(
        (task) => `  unfinished: ${task.id} ${task.title}`,
      ),
      ...checklist.unexplained.map(
        (task) => `  closed with no reason: ${task.id} ${task.title}`,
      ),
      "",
    );
  }

  lines.push(
    "How to do it:",
    "  1. Fill the gaps first. Where a finding rests on something you have not actually read, read it now — retrieve_context for a banked report, read_file for the code.",
    "  2. Merge duplicates: the same problem in the same place is ONE finding. Keep the id that is most specific, keep the fullest wording, and list every dropped id against the id it merged into.",
    "  3. Drop anything you cannot evidence, and anything that turned out to be wrong. A finding you would not defend in review does not belong in the list.",
    "  4. Keep every surviving id exactly as it was. The ids are what a re-review dedupes on; renaming one posts it twice.",
    "  5. Order the list most serious first.",
    "",
    "You do not decide the verdict. The policy decides it from these findings and this repository's configuration — your job is that the list is true, deduped and ranked. Finish with one paragraph saying what was reviewed and what it amounts to.",
  );
  return lines.join("\n");
};

/**
 * Runs the collate stage, then applies the policy.
 *
 * The verdict is decided over the FULL OPEN SET (TASKS:Y7.1): what this run found, plus
 * every finding the previous review left open that this run did not show to be fixed. A
 * re-review that only weighed its own new findings would approve a change whose blocking
 * problem it had already reported and nobody had fixed.
 *
 * The ledger is REPLACED rather than merged, and that is the point: it is "what is open
 * now", not a history. A finding classified fixed or moot leaves it, and the next run
 * therefore does not carry it forward for ever.
 */
export const runCollate = async (options: {
  session: SessionRunner;
  paths: RunStorePaths;
  config: ResolvedConfig;
  brief: OperatingBrief;
  plan: InsertionPlan;
  findings: readonly Finding[];
  workers: readonly WorkerReport[];
  checklist: ChecklistGateResult;
  /**
   * Findings the previous review left open that this run did not show to be fixed
   * (TASKS:Y7.1). They join the ranked list and the verdict; the agent is told they are
   * already counted so it does not report them a second time.
   */
  carriedOver?: readonly Finding[];
  /** Live review-phase capability tools (TASKS:Y5.1); never a posting tool. */
  extraTools?: readonly string[];
  /** The change under review, restated so this stage stands on its own. */
  facts?: TargetFacts;
}): Promise<CollateStageResult> => {
  const output = await checkpointWithSchemaGate({
    session: options.session,
    request: {
      stage: "collate",
      prompt: buildCollatePrompt({
        brief: options.brief,
        plan: options.plan,
        findings: options.findings,
        workers: options.workers,
        checklist: options.checklist,
        ...(options.carriedOver !== undefined
          ? { carriedOver: options.carriedOver }
          : {}),
        ...(options.facts !== undefined ? { facts: options.facts } : {}),
      }),
      schema: CollationSchema,
      tools: [...READ_ONLY_TOOLS, ...(options.extraTools ?? [])],
      maxSteps: COLLATE_MAX_STEPS,
    },
  });

  const merged = Object.fromEntries(
    output.data.merged.map((entry) => [entry.from, entry.into]),
  );
  // A carried-over finding this run found again shares its id, so the new version wins
  // and the old one does not appear twice.
  const ranked: RankedFindings = {
    findings: rankFindings(
      mergeFindings(options.carriedOver ?? [], output.data.findings),
    ),
    ...(Object.keys(merged).length > 0 ? { merged } : {}),
  };

  // No ledger write here: grounding runs AFTER collate, and a ledger written before
  // the gate recorded dropped findings as real — a later run then carried them as
  // prior-open, blessing their own resurrection past the gate (found live on #91).
  // The shell writes the ledger from the GROUNDED list.
  return {
    output,
    ranked,
    verdict: decideVerdict(ranked.findings, options.config.yama.verdict),
  };
};
