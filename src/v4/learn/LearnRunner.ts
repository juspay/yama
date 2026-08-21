/**
 * Learning from a merged pull request.
 *
 * The expensive work happens here, on merge, where nobody is waiting — which is
 * the whole point of the design. A review gets better without ever getting
 * slower, because everything it knows was computed after the last merge rather
 * than during this review.
 *
 * What a merge teaches:
 *   - what a human said in review that Yama did not say  → a convention
 *   - what Yama said that the author acted on            → confirmation
 *   - what Yama said that the author dismissed unchanged → a suppression candidate
 *
 * Classification is the only step that needs a model, and it is bounded: one
 * structured call per pull request over that pull request's comments, on the
 * cheap chain. Everything after it is deterministic and tested.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  LearnRunOptions,
  LearnRunResult,
  RuleEntry,
  TriagedHumanComment,
  TriagedYamaComment,
  WindowEntry,
} from "../types/index.js";
import { CapabilityResolver } from "../connections/Capabilities.js";
import { createRuntime } from "../core/Runtime.js";
import { SessionRunner } from "../core/SessionRunner.js";
import { normalizeComments } from "../connections/Comments.js";
import { capabilityParams, targetParams } from "../connections/invoke.js";
import { scanMarkers } from "../findings/Markers.js";
import {
  applyHumanComments,
  triageSchema,
  applyYamaOutcomes,
  computePrecision,
  renderLearningSummary,
  retireDormantRules,
} from "./Triage.js";
import {
  LEARNED_RULES_PATH,
  authoredRuleIds,
  partitionLearned,
  writeLearnedRules,
} from "./KnowledgeWriter.js";
import { commitAndPush, learnCommitMessage } from "./GitWriter.js";
import { saveWatermark, watermarkRelativePath } from "./WatermarkStore.js";
import { resolvePrompts } from "../prompts/PromptStore.js";
import { appendImpactLog } from "./KnowledgeWriter.js";
import { consumeArtifact } from "../artifacts/PrArtifact.js";
import { capabilitiesForPaths } from "../product/Capabilities.js";
import { computeQuality, renderScorecard } from "../judge/scorecard.js";
import { advanceWatermark } from "./Window.js";

/**
 * Persist the scorecard next to the knowledge it measures.
 *
 * One file, overwritten each run, holding the latest measured quality. History
 * lives in git — which is the point of committing it rather than uploading it
 * somewhere: `git log -p` on this file is the record of whether the reviewer is
 * getting better.
 */
async function writeScorecard(
  projectRoot: string,
  learnedFrom: number[],
  scorecard: string,
): Promise<string> {
  const relative = join(".yama", "knowledge", "scorecard.md");
  const path = join(projectRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `<!-- Written by \`yama learn\`. Measured on merges: ` +
      `${learnedFrom.map((id) => `#${id}`).join(", ") || "none"}. -->\n\n` +
      `${scorecard}\n`,
    "utf-8",
  );
  return relative;
}

/**
 * When the merge that taught us this actually landed.
 *
 * Read from the window entry rather than stamped with the current time: the
 * impact ledger is a history, and a catch-up run processing five merges must
 * not record all five as having happened at once.
 */
function entryTimestamp(entries: WindowEntry[], pullRequestId: number): string {
  const entry = entries.find((item) => item.pullRequestId === pullRequestId);
  return entry?.mergedAt ?? entry?.sha ?? "";
}

/** One merge's worth of learning, applied to the rule set in memory. */
export async function learnFromEntry(options: {
  entry: WindowEntry;
  rules: RuleEntry[];
  session: SessionRunner;
  comments: Array<{ id: string; body: string; author?: string }>;
  botIdentity?: string;
}): Promise<{
  rules: RuleEntry[];
  changes: string[];
  human: TriagedHumanComment[];
  yama: TriagedYamaComment[];
}> {
  const { entry, session, comments } = options;
  const scan = scanMarkers(comments, options.botIdentity);
  const yamaCommentIds = new Set(scan.commentByFinding.values());

  const rendered = comments
    .map((comment, index) => {
      const isYama = yamaCommentIds.has(comment.id);
      return (
        `--- comment ${index + 1} (${isYama ? "YAMA" : `human: ${comment.author ?? "unknown"}`}) ---\n` +
        comment.body.slice(0, 4_000)
      );
    })
    .join("\n\n");

  const result = await session.turn(
    `Pull request #${entry.pullRequestId} has been merged.\n\n` +
      `Its review conversation:\n\n${rendered}\n\n` +
      `Classify it.`,
    {
      stage: "verdict",
      schema: triageSchema,
      // No tools: this is a classification over text already in the message.
      // Tools would only invite the model to go exploring on a cheap chain.
      disableTools: true,
      operation: `learn-triage-${entry.pullRequestId}`,
    },
  );

  const parsed = triageSchema.safeParse(result.structuredData);
  if (!parsed.success) {
    return { rules: options.rules, changes: [], human: [], yama: [] };
  }

  // No cast. The schema and the declared types are the same vocabulary now, and
  // keeping it that way is what makes a future drift a compile error.
  const human: TriagedHumanComment[] = parsed.data.human;
  const yama: TriagedYamaComment[] = parsed.data.yama;

  const afterHuman = applyHumanComments(
    options.rules,
    human,
    entry.pullRequestId,
  );
  const afterYama = applyYamaOutcomes(
    afterHuman.rules,
    yama,
    entry.pullRequestId,
  );

  return {
    rules: afterYama.rules,
    changes: [...afterHuman.changes, ...afterYama.changes],
    human,
    yama,
  };
}

/**
 * Learn from every merge in the window, then commit once.
 *
 * One commit for the whole window, not one per merge: a catch-up run after CI
 * was down would otherwise push five commits that each trigger the next
 * workflow. The watermark advances only over merges that actually succeeded.
 */
export async function runLearn(
  options: LearnRunOptions,
): Promise<LearnRunResult> {
  const { config, context, chains, window } = options;
  const warnings: string[] = [];
  const changes: string[] = [];
  const learnedFrom: number[] = [];

  const prompts = await resolvePrompts({
    config: config.prompts,
    env: options.env ?? process.env,
  });
  warnings.push(...prompts.warnings);

  const runtime = await createRuntime({
    config,
    chains,
    context,
    role: "main",
    ...(options.logger ? { logger: options.logger } : {}),
  });

  try {
    const resolver = new CapabilityResolver(runtime.capabilities);
    const listComments = resolver.find("listComments", "verdict");
    if (!listComments) {
      return {
        learnedFrom: [],
        changes: [],
        committed: false,
        warnings: [
          "No listComments capability is exposed during the verdict stage, so there " +
            'is no review conversation to learn from. Add "verdict" to that server\'s ' +
            "stages in .yama/mcp.yaml.",
        ],
      };
    }

    const session = new SessionRunner({
      host: runtime.host,
      context,
      // The cheap chain: classification is a small, well-specified task, and
      // learning runs on every merge.
      chain: chains.judge,
      systemInstruction: prompts.get("yama-triage"),
    });

    let rules = config.rules;
    const allYama: TriagedYamaComment[] = [];
    const allHuman: TriagedHumanComment[] = [];

    for (const entry of window.entries) {
      let comments;
      try {
        comments = normalizeComments(
          await runtime.invoke(
            listComments.toolName,
            capabilityParams(
              listComments,
              targetParams({
                owner: context.identity.owner,
                repo: context.identity.repo,
                pullRequestId: entry.pullRequestId,
              }),
            ),
          ),
        );
      } catch (error) {
        warnings.push(
          `Could not read the conversation on #${entry.pullRequestId}: ` +
            `${(error as Error).message}. The watermark will not advance past it, so a ` +
            `later run will retry.`,
        );
        break;
      }

      if (comments.length === 0) {
        learnedFrom.push(entry.pullRequestId);
        continue;
      }

      try {
        const learned = await learnFromEntry({
          entry,
          rules,
          session,
          comments,
          ...(config.learn.botIdentity
            ? { botIdentity: config.learn.botIdentity }
            : {}),
        });
        rules = learned.rules;
        changes.push(...learned.changes);
        allHuman.push(...learned.human);
        allYama.push(...learned.yama);
        learnedFrom.push(entry.pullRequestId);
      } catch (error) {
        warnings.push(
          `Classification failed for #${entry.pullRequestId}: ${(error as Error).message}. ` +
            `Stopping here so the watermark does not skip it.`,
        );
        break;
      }
    }

    // Retirement needs how many merges each rule has gone unseen for. The
    // occurrence counters carry that: a rule touched during this window has
    // been seen now, everything else has aged by the number of merges handled.
    const seen = new Set(
      [...allHuman.map((entry) => entry.conventionKey)].map(
        (key) => `convention.${key}`,
      ),
    );
    const aged = new Map(
      rules.map((rule) => [
        rule.id,
        seen.has(rule.id)
          ? 0
          : (rule.occurrences ?? 0) === 0
            ? learnedFrom.length
            : 0,
      ]),
    );
    const retired = retireDormantRules(rules, aged);
    rules = retired.rules;
    changes.push(...retired.changes);

    if (changes.length === 0) {
      return { learnedFrom, changes: [], committed: false, warnings };
    }

    // ── write ───────────────────────────────────────────────────────────────
    const authored = await authoredRuleIds(config.projectRoot, config.rules);
    const { learned } = partitionLearned(rules, authored);
    const write = await writeLearnedRules(config.projectRoot, learned);
    const written = [...write.paths];

    // The PR artifact is an INPUT to learning and is then discarded. What it
    // carried that is worth keeping — the impact narrative and which product
    // capabilities the change touched — is promoted to the repository's impact
    // log here; everything else was scoped to a pull request that no longer
    // exists. Leaving artifacts behind would accumulate one directory per pull
    // request forever.
    for (const pullRequestId of learnedFrom) {
      const consumed = await consumeArtifact(config.state.path, pullRequestId);
      const artifact = consumed.artifact;
      if (!artifact) {
        continue;
      }
      const paths = [
        ...new Set(
          artifact.findings.posted
            .map((finding) => finding.filePath)
            .filter((path): path is string => typeof path === "string"),
        ),
      ];
      if (paths.length === 0 && !artifact.impact) {
        continue;
      }
      try {
        written.push(
          await appendImpactLog(config.projectRoot, pullRequestId, {
            at: entryTimestamp(window.entries, pullRequestId),
            capabilities: capabilitiesForPaths(config.product, paths).map(
              (capability) => capability.id,
            ),
            paths,
            summary: artifact.impact ?? artifact.context.slice(0, 2_000),
          }),
        );
      } catch (error) {
        warnings.push(
          `The impact log for #${pullRequestId} could not be written: ` +
            `${(error as Error).message}. Learning is unaffected.`,
        );
      }
    }

    // Ground truth — the only numbers that justify changing a rule. Precision
    // comes from what authors actually did with Yama's comments, recall from
    // what humans raised that Yama did not. Both exist only after a merge,
    // which is why they are computed here and never during a review.
    const quality = computeQuality({
      postedFindings: allYama.length,
      actedOn: allYama.filter((comment) => comment.outcome === "acted-on")
        .length,
      dismissed: allYama.filter(
        (comment) => comment.outcome === "dismissed-no-change",
      ).length,
      missedByYama: allHuman.filter(
        (comment) =>
          comment.classification === "missed-convention" ||
          comment.classification === "missed-bug",
      ).length,
      byRule: [],
    });

    const precision = computePrecision(allYama);
    const summary = renderLearningSummary(
      learnedFrom[learnedFrom.length - 1] ?? 0,
      learnedFrom.length > 1
        ? [
            `Window covered ${learnedFrom.length} merges: #${learnedFrom.join(", #")}.`,
            ...changes,
          ]
        : changes,
      precision,
    );

    // Committed alongside what it measures: a scorecard stored apart from the
    // knowledge it scores can disagree with it after one failed push.
    const scorecard = renderScorecard(
      {
        coverage: 1,
        filesPlanned: 0,
        filesExamined: 0,
        noisePer100Lines: 0,
        findingsPosted: allYama.length,
        changedLines: 0,
        gateAcceptRate: 0,
        unposted: 0,
        degradedStages: [],
        durationMs: 0,
        turns: 0,
        delegations: 0,
      },
      quality,
    );

    // Committed with the knowledge it scores. Stored apart, the two can
    // disagree after one failed push: a scorecard claiming precision the
    // knowledge base never received is worse than no scorecard.
    try {
      written.push(
        await writeScorecard(config.projectRoot, learnedFrom, scorecard),
      );
    } catch (error) {
      warnings.push(
        `The scorecard could not be written: ${(error as Error).message}. ` +
          `What was learned is unaffected.`,
      );
    }

    // The watermark is written BEFORE the commit and staged WITH the
    // knowledge it tracks — WatermarkStore's own contract: stored apart, the
    // two can disagree. The old order (push first, then write the watermark to
    // local disk only) lost the watermark entirely on ephemeral CI runners, so
    // every learn run reprocessed every merge and doubled the occurrence
    // counts it had already recorded.
    const learnedSet = new Set(learnedFrom);
    const advanced = advanceWatermark(
      options.watermark,
      window.entries.filter((entry) => learnedSet.has(entry.pullRequestId)),
    );

    if (context.mode === "dry-run") {
      return {
        learnedFrom,
        changes,
        committed: false,
        summary: `${summary}\n\n${scorecard}`,
        warnings: [
          ...warnings,
          `Dry run: ${write.ruleCount} rule(s) were written to ${LEARNED_RULES_PATH} ` +
            `but nothing was committed or pushed.`,
        ],
      };
    }

    // ── commit ──────────────────────────────────────────────────────────────
    if (!config.learn.git?.remote) {
      return {
        learnedFrom,
        changes,
        committed: false,
        summary,
        warnings: [
          ...warnings,
          `learn.git.remote is not configured, so what was learned stays on this ` +
            `runner and is lost. ${write.ruleCount} rule(s) are in ${LEARNED_RULES_PATH}.`,
        ],
      };
    }

    await saveWatermark(config.projectRoot, advanced);
    written.push(watermarkRelativePath());

    const commit = await commitAndPush({
      runner: options.gitRunner,
      cwd: config.projectRoot,
      config: config.learn.git,
      env: options.env ?? process.env,
      botIdentity: config.learn.botIdentity ?? "yama-bot",
      message: `${learnCommitMessage(learnedFrom[learnedFrom.length - 1] ?? 0)}\n\n${summary}`,
      paths: written,
    });

    if (!commit.pushed) {
      warnings.push(
        `Nothing was pushed (${commit.reason ?? "push rejected"}). The watermark file ` +
          `was written locally but not published, so the next run re-reads these ` +
          `merges — re-learning is idempotent on rule content, unlike a lost watermark.`,
      );
    }

    return {
      learnedFrom,
      changes,
      committed: commit.committed,
      pushed: commit.pushed,
      summary: `${summary}\n\n${scorecard}`,
      warnings,
    };
  } finally {
    await runtime.shutdown();
  }
}
