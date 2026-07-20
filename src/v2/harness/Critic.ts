/**
 * Critic — adversarial verification of candidate findings BEFORE they reach
 * the pull request. The agent proposes; the critic refutes or confirms.
 *
 * Modes:
 *  - off:    everything passes (dedup still applies in the harness).
 *  - basic:  one tools-off, temperature-0 pass over the batch — kills
 *            incoherent, non-actionable, severity-inflated, or evidence-free
 *            findings.
 *  - strict: basic, then findings still standing must survive an evidence
 *            check through the explorer (read-only research sub-agent). No
 *            explorer configured → falls back to basic.
 */

import { NeuroLink } from "@juspay/neurolink";
import { z } from "zod";
import {
  CriticVerdict,
  SubmitReviewAccepted,
  VerificationMode,
  YamaConfig,
} from "../types/index.js";
import { ContextExplorerService } from "../exploration/ContextExplorerService.js";
import { ExploreRuntimeContext } from "../types/index.js";
import { clampMaxTokens } from "../utils/tokenLimits.js";

const criticSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["confirmed", "refuted", "uncertain"]),
      reason: z.string(),
    }),
  ),
});

const CRITIC_PROMPT = `You are the verification critic for an AI code reviewer.
You receive candidate review findings BEFORE they are posted to a colleague's
pull request. Your only job is to keep bad findings out. For each finding,
judge:

- REFUTED: the finding is incoherent, not actionable, a pure style nit dressed
  up as a defect, a duplicate of another finding in this batch, contradicts its
  own evidence, claims behaviour its evidence cannot support, or would clearly
  be caught by a compiler/linter.
- CONFIRMED: specific, plausible, actionable, evidence-backed (file:line or
  quoted code), severity proportionate to impact.
- UNCERTAIN: plausible but the evidence provided does not establish it.

Severity inflation counts against a finding: a SUGGESTION-grade nit labelled
MAJOR is REFUTED unless re-argued. When in doubt between confirmed and
uncertain, choose uncertain. Return ONLY the JSON verdict object.`;

export class Critic {
  constructor(
    private readonly neurolink: NeuroLink,
    private readonly config: YamaConfig,
    private readonly explorer: ContextExplorerService | null,
  ) {}

  async verify(
    findings: SubmitReviewAccepted[],
    mode: VerificationMode,
    sessionId: string,
    runtimeContext?: ExploreRuntimeContext,
  ): Promise<CriticVerdict[]> {
    if (mode === "off" || findings.length === 0) {
      return findings.map((finding) => ({
        id: finding.id,
        verdict: "confirmed",
        reason: "verification disabled",
      }));
    }

    const basic = await this.basicPass(findings, sessionId);
    if (mode === "basic" || !this.explorer || !runtimeContext) {
      return basic;
    }

    // strict: uncertain/confirmed findings get an evidence check; refuted stay dead.
    const standing = findings.filter((finding) => {
      const verdict = basic.find((v) => v.id === finding.id);
      return verdict?.verdict !== "refuted";
    });
    if (standing.length === 0) {
      return basic;
    }
    const evidence = await this.evidencePass(standing, runtimeContext);
    return basic.map((verdict) => evidence.get(verdict.id) ?? verdict);
  }

  private async basicPass(
    findings: SubmitReviewAccepted[],
    sessionId: string,
  ): Promise<CriticVerdict[]> {
    const payload = findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      description: finding.description,
      filePath: finding.filePath,
      line: finding.line,
      suggestion: finding.suggestion,
      evidence: finding.evidence,
    }));

    try {
      const response = await this.neurolink.generate({
        input: {
          text: `${CRITIC_PROMPT}\n\nCandidate findings:\n${JSON.stringify(payload, null, 2)}`,
        },
        provider: this.config.ai.explore.provider || this.config.ai.provider,
        model: this.config.ai.explore.model || this.config.ai.model,
        temperature: 0,
        maxTokens: clampMaxTokens(8000),
        timeout: "3m",
        schema: criticSchema,
        disableTools: true,
        skipToolPromptInjection: true,
        context: { sessionId, operation: "finding-verification" },
        memory: { enabled: false },
      } as unknown as Parameters<NeuroLink["generate"]>[0]);

      const verdicts = (response as { structuredData?: { verdicts?: unknown } })
        ?.structuredData?.verdicts;
      if (!Array.isArray(verdicts)) {
        // Fail OPEN on critic malfunction: verification must never silently
        // swallow real findings, so an unverifiable batch passes as uncertain.
        return this.passthrough(findings, "critic returned no verdicts");
      }
      return findings.map((finding) => {
        const match = verdicts.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry as CriticVerdict).id === finding.id,
        ) as CriticVerdict | undefined;
        return match &&
          ["confirmed", "refuted", "uncertain"].includes(match.verdict)
          ? {
              id: finding.id,
              verdict: match.verdict,
              reason: match.reason || "",
            }
          : {
              id: finding.id,
              verdict: "uncertain" as const,
              reason: "critic did not address this finding",
            };
      });
    } catch (error) {
      return this.passthrough(
        findings,
        `critic failed: ${(error as Error).message}`,
      );
    }
  }

  private async evidencePass(
    findings: SubmitReviewAccepted[],
    runtimeContext: ExploreRuntimeContext,
  ): Promise<Map<string, CriticVerdict>> {
    const results = new Map<string, CriticVerdict>();
    if (!this.explorer) {
      return results;
    }
    const list = findings
      .map(
        (finding) =>
          `- [${finding.id}] ${finding.severity} ${finding.filePath || "?"}${
            finding.line !== null && finding.line !== undefined
              ? `:${finding.line}`
              : ""
          } — ${finding.title}: ${finding.description || ""}`,
      )
      .join("\n");
    try {
      const { result } = await this.explorer.explore(
        {
          task:
            `Verify each of these candidate code-review findings against the actual code. ` +
            `For every id, state whether the claim is SUPPORTED or NOT SUPPORTED by what the code really does, with file:line evidence:\n${list}`,
          focus: findings
            .map((finding) => finding.filePath)
            .filter((path): path is string => !!path),
        },
        runtimeContext,
      );
      for (const finding of findings) {
        const supported = result.findings.some(
          (claim) =>
            claim.claim.includes(finding.id) &&
            /supported|confirmed|correct|valid/i.test(claim.claim) &&
            !/not supported|unsupported|refuted|incorrect|invalid/i.test(
              claim.claim,
            ),
        );
        const refuted = result.findings.some(
          (claim) =>
            claim.claim.includes(finding.id) &&
            /not supported|unsupported|refuted|incorrect|invalid/i.test(
              claim.claim,
            ),
        );
        if (refuted) {
          results.set(finding.id, {
            id: finding.id,
            verdict: "refuted",
            reason: "evidence check: claim not supported by the code",
          });
        } else if (supported) {
          results.set(finding.id, {
            id: finding.id,
            verdict: "confirmed",
            reason: "evidence check: supported by the code",
          });
        }
      }
    } catch {
      // Evidence pass is best-effort; basic verdicts stand.
    }
    return results;
  }

  private passthrough(
    findings: SubmitReviewAccepted[],
    reason: string,
  ): CriticVerdict[] {
    return findings.map((finding) => ({
      id: finding.id,
      verdict: "uncertain",
      reason,
    }));
  }
}
