/**
 * ProviderToolset — the single source of truth for everything that differs
 * between VCS providers (Bitbucket vs GitHub) when Yama drives an AI review.
 *
 * Every provider-specific string the AI sees (the <available_tools> section,
 * the numbered review workflow, the PR-context identifier block, the
 * description-enhancement steps) and every provider-specific signal Yama reads
 * back (which tool call is a comment, a diff fetch, a repo mutation, or an
 * approve/block decision) lives behind this interface.
 *
 * The Bitbucket toolset reproduces the CURRENT prompt wording verbatim, so
 * behaviour for Bitbucket stays byte-identical. The GitHub toolset teaches the
 * official github/github-mcp-server consolidated API and pending-review flow,
 * keeping the same review philosophy and severity rules.
 */

export type VCSProviderName = "github" | "bitbucket";

export interface ReviewPromptParams {
  workspace?: string;
  repository?: string;
  pullRequestId?: number | string;
  owner?: string;
  repo?: string;
  prNumber?: number;
  branch?: string;
}

export interface ProviderToolCall {
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface ProviderToolset {
  readonly provider: VCSProviderName;
  /** Tool name the AI calls to read a PR's metadata/comments
   *  (Bitbucket: get_pull_request; GitHub: pull_request_read). */
  readonly prReadToolName: string;
  /** <pr_context> identifier block injected into review/enhancement prompts */
  identifierXml(params: ReviewPromptParams): string;
  /** The <available_tools> section listing the tools the AI may call (provider idiom) */
  systemPromptToolsSection(): string;
  /** Provider-specific numbered review workflow instructions (prose the AI follows) */
  reviewWorkflowInstructions(params: ReviewPromptParams): string;
  /** Provider-specific PR-description-enhancement workflow instructions */
  descriptionEnhancementInstructions(params: ReviewPromptParams): string;
  /** Tool names whose calls represent an inline/PR comment (statistics counting) */
  readonly commentToolNames: string[];
  /** Tool names representing diff/file retrieval (statistics counting) */
  readonly diffToolNames: string[];
  /** Plain tool names that mutate PR/repo state (explore_context block list) */
  readonly mutationToolNames: string[];
  /** Interpret a single tool call as an approve/block decision signal, else null.
   *  Bitbucket: set_pr_approval/set_review_status (+ args). GitHub: pull_request_review_write with args.event. */
  interpretDecision(call: ProviderToolCall): "APPROVED" | "BLOCKED" | null;
}

/**
 * Escape XML special characters. Mirrors PromptBuilder.escapeXML so the
 * identifier blocks emitted here are byte-identical to the current prompt.
 */
function escapeXML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ============================================================================
// Bitbucket toolset — reproduces the CURRENT prompt text VERBATIM
// ============================================================================

class BitbucketToolset implements ProviderToolset {
  readonly provider: VCSProviderName = "bitbucket";

  // get_pull_request reads PR metadata and existing comments today.
  readonly prReadToolName = "get_pull_request";

  // add_comment is the inline/PR comment tool today.
  readonly commentToolNames: string[] = ["add_comment"];

  // get_pull_request_diff is the per-file diff retrieval tool today.
  readonly diffToolNames: string[] = ["get_pull_request_diff"];

  // Plain Bitbucket mutation names currently blocked in
  // ContextExplorerService.shouldExcludeTool. Copied verbatim from the regex
  // alternation so explore_context cannot mutate PR/repo state.
  readonly mutationToolNames: string[] = [
    "add_comment",
    "set_pr_approval",
    "set_review_status",
    "approve_pull_request",
    "unapprove_pull_request",
    "request_changes",
    "remove_requested_changes",
    "update_pull_request",
    "merge_pull_request",
    "delete_branch",
  ];

  /**
   * <pr_context> identifier block — mirrors the <workspace>/<repository>/
   * <pull_request_id>/<branch> fields PromptBuilder emits today (~lines
   * 119-122), with the same escaping and the same "find-by-branch" fallback.
   */
  identifierXml(params: ReviewPromptParams): string {
    const workspace = escapeXML((params.workspace || "").trim());
    const repository = escapeXML((params.repository || "").trim());
    const pullRequestId = params.pullRequestId || "find-by-branch";
    const branch = escapeXML((params.branch || "N/A").trim());

    return `  <workspace>${workspace}</workspace>
  <repository>${repository}</repository>
  <pull_request_id>${pullRequestId}</pull_request_id>
  <branch>${branch}</branch>`;
  }

  /**
   * The <available_tools>/<tool-usage> section. Reproduced verbatim from
   * ReviewSystemPrompt.ts (the <tool-usage> block, lines 28-69).
   */
  systemPromptToolsSection(): string {
    return `  <tool-usage>
    <tool name="get_pull_request">
      <use-when>Once at the start, to read PR metadata and existing comments.</use-when>
    </tool>

    <tool name="get_pull_request_diff">
      <use-when>For ONE file at a time, immediately before reviewing it.</use-when>
      <do-not-use-when>Never call this without a file_path argument. Never request the full PR diff.</do-not-use-when>
    </tool>

    <tool name="search_code">
      <use-when>A single direct lookup answers your question (function definition, single file).</use-when>
      <do-not-use-when>The investigation needs more than one call or spans multiple files — delegate to explore_context instead.</do-not-use-when>
    </tool>

    <tool name="get_file_content">
      <use-when>You already know the path and need the file's contents.</use-when>
    </tool>

    <!-- EXPLORE_BEGIN -->
    <tool name="explore_context">
      <use-when>Multi-step research, multi-file tracing, history lookup, ambiguous behavior, or anything that would otherwise need 3+ tool calls in the main loop.</use-when>
      <do-not-use-when>A single search_code or get_file_content would answer it. Delegating cheap lookups wastes a turn.</do-not-use-when>
      <how>Pass a one-sentence research question as task and optional file paths/PR refs as focus. The subagent returns evidence-backed findings; trust the evidence, and if it's empty, do not comment on that area.</how>
      <example positive>Diff adds a retry guard in PaymentProcessor → explore_context(task="Is this retry guard consistent with how other payment handlers retry, and does it match the convention from PR 842?", focus=["src/payments/", "PR 842"])</example>
      <example negative>Don't: explore_context(task="What does validatePayment do?"). Do: search_code(search_query="function validatePayment").</example>
    </tool>
    <!-- EXPLORE_END -->

    <tool name="add_comment">
      <fields>file_path, line_number, line_type (ADDED|REMOVED|CONTEXT), comment_text, and suggestion (required for CRITICAL and MAJOR — must be real, executable code).</fields>
      <do-not-use-when>You only have a code_snippet but no line_number/line_type from the diff JSON.</do-not-use-when>
    </tool>

    <tool name="set_pr_approval">
      <use-when>No blocking issues found. Pass approved=true.</use-when>
    </tool>

    <tool name="set_review_status">
      <use-when>Blocking criteria met. Pass request_changes=true.</use-when>
    </tool>
  </tool-usage>`;
  }

  /**
   * Numbered review workflow. Reproduced verbatim from
   * PromptBuilder.buildReviewWorkflow (the <instructions> body, lines 142-178),
   * minus the dynamic modeLine/additional tail which the caller still appends.
   */
  reviewWorkflowInstructions(_params: ReviewPromptParams): string {
    return `    Begin your autonomous review. Follow this order.

    STEP 1 — Read project standards
    Read the <project-standards> block above carefully. Treat any reviewer-expectation
    entry with severity=BLOCKING as a blocking criterion for this PR. If the block is
    missing or empty, fall back to <focus-areas> and <blocking-criteria>.

    STEP 2 — Read the PR shell
    Call get_pull_request once to get changed files, branch info, and existing comments.
    Build a mental map of which files exist and which already have comments.
    Do NOT request the full PR diff.

    STEP 3 — Walk files one at a time
    For each changed file, in order:
      a. Call get_pull_request_diff(file_path=&lt;this file&gt;).
      b. Cross-check the diff against project-standards and existing comments on this file.
      c. If anything is non-trivial — multi-file impact, unfamiliar pattern, unclear intent,
         history-dependent behavior — <!-- EXPLORE_BEGIN -->call explore_context with a precise
         task and wait for its evidence before commenting<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->use search_code or get_file_content to verify before commenting<!-- EXPLORE_DISABLED_END -->.
      d. For every confirmed issue, call add_comment immediately with line_number and
         line_type from the diff JSON. Begin comment_text with the exact severity marker as
         its first token — "🔒 CRITICAL:", "⚠️ MAJOR:", "💡 MINOR:", or "💬 SUGGESTION:" —
         then the message. Include a real-code suggestion for CRITICAL/MAJOR.
      e. Move to the next file. Never request another file's diff before finishing the
         current one. Never request a multi-file diff.

    STEP 4 — Decision
    After the last file, count issues by severity, apply <blocking-criteria>, and call
    set_pr_approval(approved=true) OR set_review_status(request_changes=true).

    STEP 5 — Summary comment
    Post one summary comment with file count, issue counts by severity, and next steps.

    Budget guidance: roughly 10 tool calls per file in the main loop. If you exceed
    that on a single file, <!-- EXPLORE_BEGIN -->delegate the rest to explore_context<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->stop investigating<!-- EXPLORE_DISABLED_END --> and move on.`;
  }

  /**
   * Description-enhancement workflow. Reproduced verbatim from
   * PromptBuilder.buildDescriptionEnhancementInstructions (the <instructions>
   * body, lines 421-437), minus the dynamic mode/additional tail.
   */
  descriptionEnhancementInstructions(_params: ReviewPromptParams): string {
    return `    Enhance the PR description now.

    1. Call get_pull_request() to read current PR and description
    2. Call get_pull_request_diff() to analyze code changes
    3. Use search_code() to find configuration patterns, API changes
    4. Extract information for each required section
    5. Build enhanced description following section structure
    6. Call update_pull_request() with enhanced description

    CRITICAL: Return ONLY the enhanced description markdown.
    Do NOT include meta-commentary or explanations.
    Start directly with section content.`;
  }

  /**
   * Replicates the orchestrator's extractDecision logic
   * (YamaV2Orchestrator.extractDecision, ~lines 1132-1163) for a single call.
   * set_review_status(request_changes=true) -> BLOCKED;
   * set_pr_approval(approved=true) -> APPROVED. Legacy names handled too.
   */
  interpretDecision(call: ProviderToolCall): "APPROVED" | "BLOCKED" | null {
    const name = call.toolName;
    const args = call.args || {};

    if (name === "set_review_status") {
      if (typeof args.request_changes === "boolean") {
        return args.request_changes ? "BLOCKED" : null;
      }
      return null;
    }
    if (name === "request_changes") {
      return "BLOCKED";
    }
    if (name === "remove_requested_changes") {
      return null;
    }
    if (name === "set_pr_approval") {
      if (typeof args.approved === "boolean") {
        return args.approved ? "APPROVED" : null;
      }
      return null;
    }
    if (name === "approve_pull_request") {
      return "APPROVED";
    }
    if (name === "unapprove_pull_request") {
      return null;
    }

    return null;
  }
}

// ============================================================================
// GitHub toolset — teaches the github/github-mcp-server consolidated API
// ============================================================================

class GitHubToolset implements ProviderToolset {
  readonly provider: VCSProviderName = "github";

  // pull_request_read (method="get") reads PR metadata and existing comments.
  readonly prReadToolName = "pull_request_read";

  // Inline comments go through the pending-review batch; non-line PR comments
  // through add_issue_comment.
  readonly commentToolNames: string[] = [
    "add_comment_to_pending_review",
    "add_issue_comment",
  ];

  // pull_request_read serves PR meta, unified diff, and changed files.
  readonly diffToolNames: string[] = ["pull_request_read"];

  // Tools that mutate PR/repo state — review-write, comment-write, PR update,
  // and the raw repo-mutation tools. Blocked for explore_context.
  readonly mutationToolNames: string[] = [
    "pull_request_review_write",
    "add_comment_to_pending_review",
    "add_issue_comment",
    "update_pull_request",
    "push_files",
    "create_or_update_file",
    "create_branch",
    "delete_file",
    "create_pull_request_with_copilot",
    "assign_copilot_to_issue",
  ];

  /**
   * <pr_context> identifier block for GitHub: owner / repo / pull_number.
   */
  identifierXml(params: ReviewPromptParams): string {
    const owner = escapeXML((params.owner || "").trim());
    const repo = escapeXML((params.repo || "").trim());
    const pullNumber =
      params.prNumber !== undefined ? params.prNumber : "find-by-branch";

    return `  <owner>${owner}</owner>
  <repo>${repo}</repo>
  <pull_number>${pullNumber}</pull_number>`;
  }

  /**
   * <tool-usage> section for the GitHub consolidated MCP API.
   */
  systemPromptToolsSection(): string {
    return `  <tool-usage>
    <tool name="pull_request_read">
      <use-when>Read PR state by method: "get" for PR metadata; "get_review_comments" to load EXISTING inline review comments (each thread carries isResolved/isOutdated) so you never repeat an already-raised point; "get_reviews" for prior submitted reviews; "get_files" to list changed files; "get_diff" for the unified diff. Always pass owner, repo, pullNumber.</use-when>
      <important>method="get" does NOT include review comments on GitHub — you MUST call method="get_review_comments" to see them.</important>
    </tool>

    <tool name="search_code">
      <use-when>A single direct lookup answers your question (function definition, single file). Pass a query.</use-when>
      <do-not-use-when>The investigation needs more than one call or spans multiple files — delegate to explore_context instead.</do-not-use-when>
    </tool>

    <tool name="get_file_contents">
      <use-when>You already know the path and need the file's contents. Pass owner, repo, path, and optionally ref.</use-when>
    </tool>

    <!-- EXPLORE_BEGIN -->
    <tool name="explore_context">
      <use-when>Multi-step research, multi-file tracing, history lookup, ambiguous behavior, or anything that would otherwise need 3+ tool calls in the main loop.</use-when>
      <do-not-use-when>A single search_code or get_file_contents would answer it. Delegating cheap lookups wastes a turn.</do-not-use-when>
      <how>Pass a one-sentence research question as task and optional file paths/PR refs as focus. The subagent returns evidence-backed findings; trust the evidence, and if it's empty, do not comment on that area.</how>
      <example positive>Diff adds a retry guard in PaymentProcessor → explore_context(task="Is this retry guard consistent with how other payment handlers retry, and does it match the convention from PR 842?", focus=["src/payments/", "PR 842"])</example>
      <example negative>Don't: explore_context(task="What does validatePayment do?"). Do: search_code(query="function validatePayment").</example>
    </tool>
    <!-- EXPLORE_END -->

    <tool name="pull_request_review_write">
      <use-when>Open and close ONE pending review per PR. method="create" (owner, repo, pullNumber) opens the pending review BEFORE posting any inline comment. method="submit" (owner, repo, pullNumber, event, body) closes it: event="APPROVE" when clean, event="REQUEST_CHANGES" when blocking, event="COMMENT" otherwise. method="delete" discards an unsubmitted pending review.</use-when>
      <do-not-use-when>Never submit before all inline comments are added. Never open more than one pending review per PR.</do-not-use-when>
    </tool>

    <tool name="add_comment_to_pending_review">
      <fields>owner, repo, pullNumber, path, body, subjectType ("LINE"|"FILE"), and line (with optional side, startLine, startSide) for LINE comments. Each confirmed issue is one call. Include a real, executable code suggestion in body for CRITICAL and MAJOR.</fields>
      <do-not-use-when>No pending review has been created yet, or you have no path/line for a LINE comment.</do-not-use-when>
    </tool>

    <tool name="add_issue_comment">
      <fields>owner, repo, issue_number, body. Use for the general (non-line) PR summary comment.</fields>
    </tool>
  </tool-usage>`;
  }

  /**
   * Numbered review workflow mirroring the Bitbucket steps but using the
   * GitHub pending-review batch model. Same review philosophy and severity
   * rules — only the tool calls differ.
   */
  reviewWorkflowInstructions(_params: ReviewPromptParams): string {
    return `    Begin your autonomous review. Follow this order.

    STEP 1 — Read project standards
    Read the <project-standards> block above carefully. Treat any reviewer-expectation
    entry with severity=BLOCKING as a blocking criterion for this PR. If the block is
    missing or empty, fall back to <focus-areas> and <blocking-criteria>.

    STEP 2 — Read the PR shell + EXISTING review comments
    Call pull_request_read(method="get", owner, repo, pullNumber) for PR metadata,
    then pull_request_read(method="get_review_comments", owner, repo, pullNumber) to
    load existing inline review comments. (On GitHub, method="get" does NOT include
    review comments — you MUST call get_review_comments.) Build a map of which
    file+line locations already have comments. Treat any point an existing comment
    already raises as ALREADY HANDLED: do NOT post a duplicate, and do NOT re-raise it
    in your decision — especially threads marked isResolved or isOutdated. Then call
    pull_request_read(method="get_files", ...) to list the changed files. Do NOT
    request the full PR diff yet.

    STEP 3 — Open ONE pending review
    Call pull_request_review_write(method="create", owner, repo, pullNumber) to open a
    single pending review. Every inline comment in STEP 4 attaches to this review.

    STEP 4 — Walk files one at a time
    For each changed file, in order:
      a. Call pull_request_read(method="get_diff", owner, repo, pullNumber) and work the
         hunks for &lt;this file&gt; only. Finish this file before touching another.
      b. Cross-check the diff against project-standards and existing comments on this file.
      c. If anything is non-trivial — multi-file impact, unfamiliar pattern, unclear intent,
         history-dependent behavior — <!-- EXPLORE_BEGIN -->call explore_context with a precise
         task and wait for its evidence before commenting<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->use search_code or get_file_contents to verify before commenting<!-- EXPLORE_DISABLED_END -->.
      d. For every confirmed issue, call add_comment_to_pending_review immediately with
         path, line, subjectType="LINE", and body taken from the diff. Begin body with the
         exact severity marker as its first token — "🔒 CRITICAL:", "⚠️ MAJOR:", "💡 MINOR:",
         or "💬 SUGGESTION:" — then the message. Include a real-code suggestion in body for
         CRITICAL/MAJOR.
      e. Move to the next file. Never jump between files mid-review.

    STEP 5 — Decision (submit the review)
    Count ONLY the NEW issues you raised this run — exclude any point already covered by
    an existing review comment (from STEP 2), and exclude resolved/outdated threads. Apply
    <blocking-criteria> to that NEW set only. A concern that was already raised and
    answered/justified in an existing comment thread is NOT grounds to block again.
    Then call pull_request_review_write(method="submit", owner, repo, pullNumber,
    body=&lt;summary&gt;) with event="APPROVE" when there are no NEW blocking issues, or
    event="REQUEST_CHANGES" only when NEW blocking criteria are met this run.

    STEP 6 — Summary comment
    Use the submit body above for the summary (file count, issue counts by severity, next
    steps). For an extra non-line note, call add_issue_comment(owner, repo, issue_number, body).

    Budget guidance: roughly 10 tool calls per file in the main loop. If you exceed
    that on a single file, <!-- EXPLORE_BEGIN -->delegate the rest to explore_context<!-- EXPLORE_END --><!-- EXPLORE_DISABLED_BEGIN -->stop investigating<!-- EXPLORE_DISABLED_END --> and move on.`;
  }

  /**
   * Description-enhancement workflow using the GitHub consolidated API.
   */
  descriptionEnhancementInstructions(_params: ReviewPromptParams): string {
    return `    Enhance the PR description now.

    1. Call pull_request_read(method="get", owner, repo, pullNumber) to read current PR and description
    2. Call pull_request_read(method="get_diff", owner, repo, pullNumber) to analyze code changes
    3. Use search_code(query=...) to find configuration patterns, API changes
    4. Extract information for each required section
    5. Build enhanced description following section structure
    6. Call update_pull_request(owner, repo, pullNumber, body=...) with enhanced description

    CRITICAL: Return ONLY the enhanced description markdown.
    Do NOT include meta-commentary or explanations.
    Start directly with section content.`;
  }

  /**
   * A submitted review carries the decision: APPROVE -> APPROVED,
   * REQUEST_CHANGES -> BLOCKED, anything else (incl. COMMENT) -> null.
   */
  interpretDecision(call: ProviderToolCall): "APPROVED" | "BLOCKED" | null {
    if (call.toolName !== "pull_request_review_write") {
      return null;
    }
    const args = call.args || {};
    if (args.method !== "submit") {
      return null;
    }
    if (args.event === "APPROVE") {
      return "APPROVED";
    }
    if (args.event === "REQUEST_CHANGES") {
      return "BLOCKED";
    }
    return null;
  }
}

// ============================================================================
// Factory
// ============================================================================

const BITBUCKET_TOOLSET = new BitbucketToolset();
const GITHUB_TOOLSET = new GitHubToolset();

export function getProviderToolset(provider: VCSProviderName): ProviderToolset {
  return provider === "github" ? GITHUB_TOOLSET : BITBUCKET_TOOLSET;
}
