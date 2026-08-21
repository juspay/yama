/**
 * The stage machine.
 *
 * Every stage has an exit predicate. Failing it re-prompts the agent in the same
 * session, naming exactly what is missing. This exists because of a specific,
 * repeated production failure: the agent reviewed a pull request thoroughly and
 * never posted the comments, and nothing noticed. Asking the model more nicely
 * does not fix that. Checking does.
 *
 * Two rules govern the failure messages:
 *   - Name specifics, never counts. "findings a1, a7 accepted but unposted" is
 *     actionable; "3 findings unposted" is not.
 *   - Bound the retries. After `maxAttempts` the stage is marked degraded and
 *     the run says so, out loud, in the summary. A silent partial reported as
 *     success is the failure mode this whole design exists to prevent.
 */

import type {
  StageCheck,
  StageDefinition,
  StageMachineOptions,
  StageMachineResult,
  StageName,
  StageOutcome,
  StageStatus,
} from "../types/index.js";

/**
 * Run the stages in order.
 *
 * A stage that throws is recorded as failed and the run CONTINUES. That is
 * deliberate: if the checks stage cannot execute, the review still has findings
 * worth posting, and abandoning the run would throw away work the author needs.
 * The verdict layer sees `partial` and refuses to approve.
 */
export async function runStages(
  stages: StageDefinition[],
  options: StageMachineOptions,
): Promise<StageMachineResult> {
  const now = options.now ?? (() => Date.now());
  const outcomes: StageOutcome[] = [];
  const maxAttempts = Math.max(1, options.maxAttemptsPerStage);

  for (const stage of stages) {
    if (options.signal?.aborted) {
      const outcome: StageOutcome = {
        stage: stage.name,
        status: "failed",
        attempts: 0,
        durationMs: 0,
        detail: "The run was cancelled before this stage started.",
      };
      outcomes.push(outcome);
      options.onStage?.(outcome);
      continue;
    }

    if (stage.enabled === false) {
      const outcome: StageOutcome = {
        stage: stage.name,
        status: "skipped",
        attempts: 0,
        durationMs: 0,
        detail: "Disabled in configuration.",
      };
      outcomes.push(outcome);
      options.onStage?.(outcome);
      continue;
    }

    const outcome = await runStage(stage, maxAttempts, now, options.signal);
    outcomes.push(outcome);
    options.onStage?.(outcome);
  }

  const degradedStages = outcomes
    .filter(
      (outcome) => outcome.status === "degraded" || outcome.status === "failed",
    )
    .map((outcome) => outcome.stage);

  return { outcomes, partial: degradedStages.length > 0, degradedStages };
}

async function runStage(
  stage: StageDefinition,
  maxAttempts: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<StageOutcome> {
  const startedAt = now();
  let attempts = 0;
  let lastCheck: StageCheck = { ok: false, missing: [], guidance: "" };

  try {
    await stage.run(0);
    attempts = 1;
    lastCheck = await stage.check();

    // Remediation only makes sense when the stage knows how to ask for the gap
    // to be closed. Re-running the whole stage blindly would repeat work that
    // already succeeded.
    while (!lastCheck.ok && attempts < maxAttempts && stage.remediate) {
      if (signal?.aborted) {
        break;
      }
      await stage.remediate(lastCheck);
      attempts += 1;
      lastCheck = await stage.check();
    }
  } catch (error) {
    return {
      stage: stage.name,
      status: "failed",
      attempts: Math.max(1, attempts),
      durationMs: now() - startedAt,
      detail: (error as Error).message,
    };
  }

  const status: StageStatus = lastCheck.ok ? "passed" : "degraded";
  return {
    stage: stage.name,
    status,
    attempts,
    durationMs: now() - startedAt,
    ...(lastCheck.ok
      ? {}
      : { missing: lastCheck.missing, detail: lastCheck.guidance }),
  };
}

/** Build a failing check, enforcing that specifics are named. */
export function missing(items: string[], guidance: string): StageCheck {
  return { ok: false, missing: items, guidance };
}

export const passed: StageCheck = { ok: true };

/**
 * Render the guidance an agent receives when a stage predicate fails.
 *
 * Listing the specific items is the entire mechanism: an agent told "post the
 * missing comments" does not know which are missing, and will either re-post
 * everything (duplicates) or nothing (silence).
 */
export function renderRemediation(
  stage: StageName,
  check: Extract<StageCheck, { ok: false }>,
): string {
  const items =
    check.missing.length > 0
      ? `\n\nSpecifically:\n${check.missing.map((item) => `- ${item}`).join("\n")}`
      : "";
  return `The ${stage} stage is not complete. ${check.guidance}${items}`;
}

/** Summarize outcomes for the run report. */
export function describeOutcomes(outcomes: StageOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const detail =
        outcome.status === "passed" || outcome.status === "skipped"
          ? ""
          : ` — ${outcome.detail ?? "no detail"}`;
      return `${outcome.stage}: ${outcome.status} (${outcome.attempts} attempt${
        outcome.attempts === 1 ? "" : "s"
      })${detail}`;
    })
    .join("\n");
}
