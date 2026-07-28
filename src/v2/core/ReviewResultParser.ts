/**
 * ReviewResultParser — turns a NeuroLink `generate()` response (plus the
 * recorded tool-call trace) into a structured review result.
 *
 * Extracted verbatim from YamaOrchestrator to lift the ~600-line
 * parsing/normalizing cluster out of the god-object and make it independently
 * testable. Behaviour is unchanged: the only external inputs it needs are the
 * session store (injected), the active VCS provider (passed per call, since it
 * can change within a process), and the optional severity overrides.
 */

import { SessionManager } from "./SessionManager.js";
import {
  deriveDecision,
  DEFAULT_MAJOR_BLOCK_THRESHOLD,
} from "./reviewDecision.js";
import { isVerdictShaped } from "./reviewSchema.js";
import { reconcileVerdictWithGate } from "../harness/verdictReconciler.js";

import {
  LocalDiffContext,
  ReviewCompletion,
  ReviewDecisionResult,
  ReviewGateSnapshot,
  ReviewResult,
  IssuesBySeverity,
  TokenUsage,
  LocalReviewRequest,
  LocalReviewResult,
  LocalReviewFinding,
} from "../types/index.js";

export class ReviewResultParser {
  constructor(private readonly sessionManager: SessionManager) {}

  /**
   * Parse a PR-mode review response into a ReviewResult. The verdict comes from
   * the STRUCTURED findings the agent returns (not from tool-name matching), then
   * {@link deriveDecision} enforces the safety policy: any CRITICAL finding — or
   * enough MAJORs — blocks, regardless of the AI's own `decision`. Provider- and
   * tool-agnostic.
   */
  parseReviewResult(
    aiResponse: any,
    startTime: number,
    sessionId: string,
    severityOverrides?: Record<string, string>,
    gate?: ReviewGateSnapshot,
  ): ReviewResult {
    const session = this.sessionManager.getSession(sessionId);
    const duration = Math.round((Date.now() - startTime) / 1000);

    const parsed = this.extractStructured(aiResponse);
    // Fail safe on an unparseable verdict: when the final message carries
    // neither a decision nor an issues array (prose, truncation, wrong shape),
    // NOTHING may be approved — the model may still have posted CRITICAL
    // comments via tools. Defaulting to APPROVED here would let a parse
    // failure green-light the PR.
    const conforming = isVerdictShaped(parsed);
    if (!conforming) {
      console.warn(
        "   ⚠️  Review verdict was not parseable as structured output — " +
          "failing safe to CHANGES_REQUESTED. " +
          `(structuredData keys: ${parsed ? Object.keys(parsed).join(", ") || "<empty>" : "<absent>"})`,
      );
    }
    const verdictIssues = this.normalizeFindings(
      parsed?.issues,
      "issue",
      severityOverrides,
    );

    // Anchor the verdict to the gate: once the agent has used submit_review,
    // only gate-accepted (deduped + critic-verified) findings may drive the
    // decision. Verdict issues that never passed the gate are quarantined as
    // advisory — on partial runs the verdict recovery has been observed to
    // fabricate whole issue lists out of the rules prompt, and counting those
    // would block PRs on findings nobody verified.
    const gateAnchored = gate?.invoked === true;
    let issues = verdictIssues;
    let ungatedIssues: LocalReviewFinding[] = [];
    if (gateAnchored) {
      const gatedFindings = this.normalizeFindings(
        gate.accepted,
        "issue",
        severityOverrides,
      );
      const reconciled = reconcileVerdictWithGate({
        gatedFindings,
        verdictIssues,
      });
      issues = reconciled.issues;
      ungatedIssues = reconciled.ungatedIssues;
      if (ungatedIssues.length > 0) {
        console.warn(
          `   🛡️  ${ungatedIssues.length} verdict issue(s) never passed the ` +
            `submit_review gate — quarantined as advisory (not posted, not ` +
            `decision-driving): ` +
            ungatedIssues.map((issue) => `"${issue.title}"`).join(", "),
        );
      }
    }

    const issuesBySeverity = this.countFindingsBySeverity(issues);
    const aiDecision: ReviewDecisionResult = conforming
      ? this.normalizeDecision(parsed?.decision, issuesBySeverity)
      : "CHANGES_REQUESTED";
    const completion = this.buildCompletion(aiResponse);
    if (completion.partial) {
      console.warn(
        `   ⚠️  Review loop ended early (stopReason=${completion.stopReason}` +
          `${completion.jsonTruncated ? ", jsonTruncated" : ""}) — result is PARTIAL.`,
      );
    }
    let decision = deriveDecision(aiDecision, issuesBySeverity, {
      partial: completion.partial,
    });
    // Unverified (ungated) blocking claims are fail-safe in BOTH directions:
    // they may not block on their own, but they may not be approved-over
    // either — a human should look before this PR is greenlit.
    const ungatedCounts = this.countFindingsBySeverity(ungatedIssues);
    if (
      decision === "APPROVED" &&
      (ungatedCounts.critical > 0 ||
        ungatedCounts.major >= DEFAULT_MAJOR_BLOCK_THRESHOLD)
    ) {
      decision = "CHANGES_REQUESTED";
      console.log(
        `   🛡️  ${ungatedCounts.critical} critical / ${ungatedCounts.major} major ` +
          `unverified claim(s) exist — APPROVED capped at CHANGES_REQUESTED.`,
      );
    }
    if (decision !== aiDecision) {
      console.log(
        `   🛡️  Decision reconciled: AI reported ${aiDecision}, Yama enforces ${decision} ` +
          `(critical=${issuesBySeverity.critical}, major=${issuesBySeverity.major}).`,
      );
    }

    // A partial (or verdict-less) run's model summary is untrustworthy — it is
    // reconstructed from a compacted session and has described entirely
    // different PRs. With gate data available, build the summary from what was
    // actually verified instead.
    const summary =
      gateAnchored && (completion.partial || !conforming)
        ? this.buildGateAnchoredSummary(issues, ungatedIssues, completion)
        : this.sanitizeLocalSummary(parsed?.summary) ||
          this.extractSummary(aiResponse);

    const toolCalls = session.toolCalls || [];
    const filesReviewed = new Set(
      issues.map((i) => i.filePath).filter((p): p is string => !!p),
    ).size;

    return {
      mode: "pr",
      prId: session.request.pullRequestId ?? session.request.prNumber ?? 0,
      decision,
      statistics: {
        filesReviewed,
        issuesFound: issuesBySeverity,
        requirementCoverage: 0,
        codeQualityScore: 0,
        toolCallsMade: toolCalls.length,
        cacheHits: 0,
        // With the gate active this is the number of verified findings
        // cleared for posting — not the length of whatever the model claimed.
        totalComments: issues.length,
      },
      summary,
      duration,
      tokenUsage: {
        input: this.toSafeNumber(aiResponse?.usage?.input),
        output: this.toSafeNumber(aiResponse?.usage?.output),
        total: this.toSafeNumber(aiResponse?.usage?.total),
      },
      costEstimate: this.calculateCost(aiResponse),
      sessionId,
      completion,
      issues,
      ungatedIssues: ungatedIssues.length > 0 ? ungatedIssues : undefined,
      resolvedIssueIds: Array.isArray(parsed?.resolvedIssueIds)
        ? parsed.resolvedIssueIds.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : undefined,
    };
  }

  /**
   * Deterministic summary for runs whose model-written summary can't be
   * trusted (partial loop or missing verdict): lists exactly the gate-verified
   * findings, flags the early stop, and mentions quarantined claims.
   */
  private buildGateAnchoredSummary(
    issues: LocalReviewFinding[],
    ungatedIssues: LocalReviewFinding[],
    completion: ReviewCompletion,
  ): string {
    const lines: string[] = ["## 🤖 Yama Review Summary", ""];
    if (completion.partial) {
      lines.push(
        `⚠️ The review loop ended early (\`${completion.stopReason}\`` +
          `${completion.stepsUsed ? `, ${completion.stepsUsed} steps` : ""}) — ` +
          `this verdict is built strictly from gate-verified findings.`,
        "",
      );
    }
    if (issues.length === 0) {
      lines.push("No verified findings were accepted by the review gate.");
    } else {
      lines.push(`**Verified findings (${issues.length}):**`, "");
      for (const issue of issues) {
        const location = issue.filePath
          ? ` — \`${issue.filePath}${issue.line ? `:${issue.line}` : ""}\``
          : "";
        lines.push(`- **${issue.severity}**: ${issue.title}${location}`);
      }
    }
    if (ungatedIssues.length > 0) {
      lines.push(
        "",
        `_${ungatedIssues.length} additional claim(s) in the model verdict ` +
          `never passed verification and were quarantined (see ungatedIssues)._`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Honest completion metadata: how the agentic loop actually ended. NeuroLink
   * surfaces `stopReason` (step-cap / context-cap / time-limit / stalled / …)
   * plus `jsonTruncated`/`jsonRepaired`; anything other than a natural finish
   * marks the review PARTIAL, which the decision policy refuses to approve.
   */
  buildCompletion(aiResponse: any): ReviewCompletion {
    const known = [
      "completed",
      "step-cap",
      "context-cap",
      "time-limit",
      "stalled",
      "aborted",
      "provider-error",
    ] as const;
    const raw =
      typeof aiResponse?.stopReason === "string"
        ? aiResponse.stopReason
        : undefined;
    const stopReason: ReviewCompletion["stopReason"] =
      raw === undefined
        ? "completed" // older NeuroLink paths omit stopReason on success
        : (known as readonly string[]).includes(raw)
          ? (raw as ReviewCompletion["stopReason"])
          : "unknown";
    const jsonTruncated = aiResponse?.jsonTruncated === true;
    const jsonRepaired = aiResponse?.jsonRepaired === true;
    const stepsUsed =
      typeof aiResponse?.stepsUsed === "number"
        ? aiResponse.stepsUsed
        : undefined;
    return {
      stopReason,
      stepsUsed,
      jsonTruncated,
      jsonRepaired,
      partial: stopReason !== "completed" || jsonTruncated,
    };
  }

  /**
   * The structured verdict as produced by NeuroLink. With `schema` passed to
   * `generate()`, NeuroLink enforces the shape at the wire where the provider
   * supports it and otherwise extracts/repairs JSON out of the final text into
   * `structuredData` (`coerceJsonToSchema`) — so there is deliberately NO
   * project-level JSON parsing here. Absent structuredData means NeuroLink
   * could not recover a verdict at all.
   */
  private extractStructured(aiResponse: any): Record<string, any> | null {
    const sd = aiResponse?.structuredData;
    return sd && typeof sd === "object" && !Array.isArray(sd)
      ? (sd as Record<string, any>)
      : null;
  }

  /** Copy the AI response's tool-call trace into the session store. */
  recordToolCallsFromResponse(sessionId: string, aiResponse: any): void {
    const toolCalls = Array.isArray(aiResponse?.toolCalls)
      ? aiResponse.toolCalls
      : [];
    const toolResults = Array.isArray(aiResponse?.toolResults)
      ? aiResponse.toolResults
      : [];

    for (const call of toolCalls) {
      const toolName =
        call?.toolName || call?.name || call?.tool || "unknown_tool";
      const args = call?.parameters || call?.args || {};
      // Correlate by the stable call id (NeuroLink 9.95: `toolCallId`, legacy
      // `id` as fallback). Tool NAME must not be the primary key — file-by-file
      // reviews call the same diff/comment tool repeatedly, so name-matching
      // would pair every repeated call with the first result.
      const callId = call?.toolCallId ?? call?.id;
      const matchingResult =
        (callId !== undefined
          ? toolResults.find((result: any) => result?.toolCallId === callId)
          : undefined) ||
        toolResults.find((result: any) => result?.toolName === toolName) ||
        null;

      this.sessionManager.recordToolCall(
        sessionId,
        toolName,
        args,
        matchingResult,
        0,
        matchingResult?.error,
      );
    }
  }

  /**
   * Parse local SDK mode response into strict LocalReviewResult.
   *
   * `severityOverrides` (projectStandards.severityOverrides) remaps a finding's
   * severity by its rule/category key when provided.
   */
  parseLocalReviewResult(
    aiResponse: any,
    sessionId: string,
    startTime: number,
    request: LocalReviewRequest,
    diffContext: LocalDiffContext,
    severityOverrides?: Record<string, string>,
  ): LocalReviewResult {
    const rawContent = aiResponse?.content || aiResponse?.outputs?.text || "";
    // NeuroLink's structuredData is the single source of the parsed verdict
    // (schema-enforced or coerced by NeuroLink itself; see extractStructured).
    const parsed = this.extractStructured(aiResponse);
    const jsonTruncated = aiResponse?.jsonTruncated === true;
    const usage = aiResponse?.usage || {};
    const tokenUsage: TokenUsage = {
      // NeuroLink 9.70.x usage shape is { input, output, total }.
      input: this.toSafeNumber(usage.input),
      output: this.toSafeNumber(usage.output),
      total: this.toSafeNumber(usage.total),
    };

    if (!parsed) {
      // Distinguish a truncated response (model ran out of output budget mid-JSON)
      // from a genuinely malformed one, and advise raising maxTokens in that case
      // rather than emitting the generic format-violation guidance.
      const fallbackIssue: LocalReviewFinding = jsonTruncated
        ? {
            id: "OUTPUT_TRUNCATED",
            severity: "MAJOR",
            category: "review-engine",
            title: "Model output was truncated before valid JSON completed",
            description:
              "The local review response was cut off (jsonTruncated), so the JSON could not be parsed and findings cannot be trusted.",
            suggestion:
              "Raise ai.maxTokens (output budget) and/or reduce review scope (smaller diff / includePaths) so the structured JSON can finish.",
          }
        : {
            id: "OUTPUT_FORMAT_VIOLATION",
            severity: "MAJOR",
            category: "review-engine",
            title: "Model did not return structured JSON",
            description:
              "Local review response was unstructured (likely tool-call trace or partial output), so findings cannot be trusted.",
            suggestion:
              "Retry with a tool-calling capable model or reduce review scope (smaller diff / includePaths) to keep responses structured.",
          };
      const issuesBySeverity = this.countFindingsBySeverity([fallbackIssue]);

      return {
        mode: "local",
        decision: "CHANGES_REQUESTED",
        summary:
          this.sanitizeLocalSummary(rawContent) ||
          (jsonTruncated
            ? "Local review output was truncated before valid JSON completed."
            : "Local review could not produce structured JSON output."),
        issues: [fallbackIssue],
        enhancements: [],
        statistics: {
          filesChanged: diffContext.changedFiles.length,
          additions: diffContext.additions,
          deletions: diffContext.deletions,
          issuesFound: 1,
          enhancementsFound: 0,
          issuesBySeverity,
        },
        duration: Math.round((Date.now() - startTime) / 1000),
        tokenUsage,
        costEstimate: this.calculateCost(aiResponse),
        sessionId,
        schemaVersion: request.outputSchemaVersion || "1.0",
        metadata: {
          repoPath: diffContext.repoPath,
          diffSource: diffContext.diffSource,
          baseRef: diffContext.baseRef,
          headRef: diffContext.headRef,
          truncated: diffContext.truncated,
        },
      };
    }

    const issues = this.normalizeFindings(
      parsed?.issues,
      "issue",
      severityOverrides,
    );
    const enhancements = this.normalizeFindings(
      parsed?.enhancements,
      "enhancement",
      severityOverrides,
    );
    const issuesBySeverity = this.countFindingsBySeverity(issues);
    const fallbackForTruncatedNoFindings =
      diffContext.truncated && issues.length === 0 && enhancements.length === 0;
    const normalizedDecision = fallbackForTruncatedNoFindings
      ? "CHANGES_REQUESTED"
      : this.normalizeDecision(parsed?.decision, issuesBySeverity);
    // Reconcile through the shared safety policy so a model "APPROVED" cannot
    // stand when the (possibly severity-overridden) findings are CRITICAL or
    // hit the MAJOR-block threshold — same guarantee as PR mode (M2).
    const decision = deriveDecision(normalizedDecision, issuesBySeverity);

    return {
      mode: "local",
      decision,
      summary:
        this.sanitizeLocalSummary(parsed?.summary) ||
        this.sanitizeLocalSummary(this.extractSummary(aiResponse)) ||
        "Local review completed",
      issues,
      enhancements,
      statistics: {
        filesChanged: diffContext.changedFiles.length,
        additions: diffContext.additions,
        deletions: diffContext.deletions,
        issuesFound: issues.length,
        enhancementsFound: enhancements.length,
        issuesBySeverity,
      },
      duration: Math.round((Date.now() - startTime) / 1000),
      tokenUsage,
      costEstimate: this.calculateCost(aiResponse),
      sessionId,
      schemaVersion: request.outputSchemaVersion || "1.0",
      metadata: {
        repoPath: diffContext.repoPath,
        diffSource: diffContext.diffSource,
        baseRef: diffContext.baseRef,
        headRef: diffContext.headRef,
        truncated: diffContext.truncated,
      },
    };
  }

  // ---- internal helpers ----------------------------------------------------

  private sanitizeLocalSummary(summary: unknown): string {
    if (typeof summary !== "string") {
      return "";
    }
    // Use string splitting instead of backtracking [\s\S]*? regex to avoid ReDoS.
    let result = this.removeDelimitedSections(
      summary,
      "<|tool_calls_section_begin|>",
      "<|tool_calls_section_end|>",
    );
    result = this.removeDelimitedSections(
      result,
      "<|tool_call_begin|>",
      "<|tool_call_end|>",
    );
    return result.replace(/\s+/g, " ").trim();
  }

  private removeDelimitedSections(
    text: string,
    open: string,
    close: string,
  ): string {
    let result = "";
    let pos = 0;
    while (pos < text.length) {
      const start = text.indexOf(open, pos);
      if (start === -1) {
        result += text.slice(pos);
        break;
      }
      result += text.slice(pos, start);
      const end = text.indexOf(close, start + open.length);
      pos = end === -1 ? text.length : end + close.length;
    }
    return result;
  }

  private normalizeFindings(
    findings: unknown,
    prefix: "issue" | "enhancement",
    severityOverrides?: Record<string, string>,
  ): LocalReviewFinding[] {
    if (!Array.isArray(findings)) {
      return [];
    }

    return findings
      .map((raw, index) => {
        const value = (raw || {}) as Record<string, unknown>;
        const ruleKey =
          (typeof value.rule === "string" && value.rule) ||
          (typeof value.category === "string" && value.category) ||
          (typeof value.id === "string" && value.id) ||
          undefined;
        const severity = this.normalizeSeverity(
          value.severity,
          ruleKey,
          severityOverrides,
        );
        if (!severity) {
          return null;
        }
        const lineValue =
          typeof value.line === "number" ? value.line : undefined;

        const finding: LocalReviewFinding = {
          id:
            (typeof value.id === "string" && value.id.trim()) ||
            `${prefix}-${index + 1}`,
          severity,
          category:
            (typeof value.category === "string" && value.category.trim()) ||
            "general",
          title:
            (typeof value.title === "string" && value.title.trim()) ||
            "Untitled finding",
          description:
            (typeof value.description === "string" &&
              value.description.trim()) ||
            "",
        };

        if (typeof value.filePath === "string" && value.filePath.trim()) {
          finding.filePath = value.filePath;
        }
        if (lineValue && lineValue > 0) {
          finding.line = lineValue;
        }
        if (typeof value.suggestion === "string" && value.suggestion.trim()) {
          finding.suggestion = value.suggestion;
        }

        return finding;
      })
      .filter((item): item is LocalReviewFinding => item !== null);
  }

  private normalizeSeverity(
    severity: unknown,
    ruleKey?: string,
    severityOverrides?: Record<string, string>,
  ): LocalReviewFinding["severity"] | null {
    // Calibration: allow projectStandards.severityOverrides to remap a finding's
    // severity by its rule/category key (defensive — config is optional and the
    // override value is itself validated against the known severity set). This
    // takes precedence over the model-reported severity.
    if (severityOverrides && ruleKey) {
      const overridden = this.coerceSeverity(severityOverrides[ruleKey]);
      if (overridden) {
        return overridden;
      }
    }

    return this.coerceSeverity(severity) ?? "MINOR";
  }

  /**
   * Map an arbitrary value to a known severity, or null if it is not one of the
   * recognised levels. Unlike normalizeSeverity this does NOT default to MINOR,
   * so callers can distinguish "unknown" from a real level.
   */
  private coerceSeverity(
    severity: unknown,
  ): LocalReviewFinding["severity"] | null {
    if (typeof severity !== "string") {
      return null;
    }
    const value = severity.toUpperCase();
    if (
      value === "CRITICAL" ||
      value === "MAJOR" ||
      value === "MINOR" ||
      value === "SUGGESTION"
    ) {
      return value;
    }
    return null;
  }

  private countFindingsBySeverity(
    findings: LocalReviewFinding[],
  ): IssuesBySeverity {
    const counts: IssuesBySeverity = {
      critical: 0,
      major: 0,
      minor: 0,
      suggestions: 0,
    };

    for (const finding of findings) {
      if (finding.severity === "CRITICAL") {
        counts.critical += 1;
      } else if (finding.severity === "MAJOR") {
        counts.major += 1;
      } else if (finding.severity === "MINOR") {
        counts.minor += 1;
      } else {
        counts.suggestions += 1;
      }
    }

    return counts;
  }

  private normalizeDecision(
    decision: unknown,
    issuesBySeverity: IssuesBySeverity,
  ): ReviewDecisionResult {
    if (typeof decision === "string") {
      const upper = decision.toUpperCase();
      if (
        upper === "APPROVED" ||
        upper === "CHANGES_REQUESTED" ||
        upper === "BLOCKED"
      ) {
        return upper;
      }
    }

    if (issuesBySeverity.critical > 0) {
      return "BLOCKED";
    }
    if (issuesBySeverity.major + issuesBySeverity.minor > 0) {
      return "CHANGES_REQUESTED";
    }
    return "APPROVED";
  }

  private extractSummary(aiResponse: any): string {
    // NeuroLink 9.95 GenerateResult exposes text via `content` (primary) and
    // `outputs.text` (multi-modal); the old top-level `.text` no longer exists.
    return (
      aiResponse?.content || aiResponse?.outputs?.text || "Review completed"
    );
  }

  /**
   * Calculate cost estimate from an AI response.
   *
   * Prefers NeuroLink's own analytics cost (`response.analytics.cost`, a USD
   * number computed per-provider/model when enableAnalytics is true). Only when
   * the analytics cost is unavailable do we fall back to a clearly labeled rough
   * estimate based on the { input, output } token usage.
   */
  private calculateCost(aiResponse: any): number {
    const analyticsCost = aiResponse?.analytics?.cost;
    if (typeof analyticsCost === "number" && Number.isFinite(analyticsCost)) {
      return Number(analyticsCost.toFixed(6));
    }

    const usage = aiResponse?.usage;
    if (!usage) {
      return 0;
    }

    // ROUGH FALLBACK ONLY — provider/model agnostic placeholder pricing used
    // when NeuroLink analytics cost is unavailable. Not accurate for any
    // specific model; treat as an order-of-magnitude estimate.
    const inputCostPer1M = 0.25;
    const outputCostPer1M = 1.0;

    const inputTokens = this.toSafeNumber(usage.input);
    const outputTokens = this.toSafeNumber(usage.output);

    const inputCost = (inputTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * outputCostPer1M;

    const totalCost = inputCost + outputCost;
    return Number.isFinite(totalCost) ? Number(totalCost.toFixed(4)) : 0;
  }

  private toSafeNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
