/**
 * Comprehensive Unit Tests for ProviderToolset
 *
 * Validates the provider-specific behaviour that the AI review loop depends on:
 *  - decision interpretation (approve/block signal extraction)
 *  - comment / diff / mutation tool-name registries
 *  - the <pr_context> identifier blocks
 *  - the <tool-usage> system-prompt section
 *  - the numbered review workflow instructions
 *
 * All assertions are pure-function checks: no network, no time/clock reliance.
 */

import {
  getProviderToolset,
  type ProviderToolset,
  type ProviderToolCall,
} from "../../src/v2/providers/ProviderToolset.js";

describe("ProviderToolset", () => {
  // ==========================================================================
  // Factory
  // ==========================================================================
  describe("getProviderToolset factory", () => {
    test('returns a github toolset with provider="github"', () => {
      const toolset = getProviderToolset("github");
      expect(toolset.provider).toBe("github");
    });

    test('returns a bitbucket toolset with provider="bitbucket"', () => {
      const toolset = getProviderToolset("bitbucket");
      expect(toolset.provider).toBe("bitbucket");
    });

    test("returns a stable singleton instance per provider", () => {
      expect(getProviderToolset("github")).toBe(getProviderToolset("github"));
      expect(getProviderToolset("bitbucket")).toBe(
        getProviderToolset("bitbucket"),
      );
      expect(getProviderToolset("github")).not.toBe(
        getProviderToolset("bitbucket"),
      );
    });
  });

  // ==========================================================================
  // GitHub: interpretDecision
  // ==========================================================================
  describe("GitHub interpretDecision", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("github");
    });

    test("submit with event=APPROVE -> APPROVED", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "submit", event: "APPROVE" },
      };
      expect(toolset.interpretDecision(call)).toBe("APPROVED");
    });

    test("submit with event=REQUEST_CHANGES -> BLOCKED", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "submit", event: "REQUEST_CHANGES" },
      };
      expect(toolset.interpretDecision(call)).toBe("BLOCKED");
    });

    test("submit with event=COMMENT -> null", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "submit", event: "COMMENT" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("submit with an unrecognized event -> null", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "submit", event: "SOMETHING_ELSE" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("submit with no event -> null", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "submit" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("create method (not submit) -> null even with event", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
        args: { method: "create", event: "APPROVE" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("review write with missing args -> null", () => {
      const call: ProviderToolCall = {
        toolName: "pull_request_review_write",
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("non-review tool -> null", () => {
      const call: ProviderToolCall = {
        toolName: "add_comment_to_pending_review",
        args: { method: "submit", event: "APPROVE" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("missing toolName -> null", () => {
      const call: ProviderToolCall = {
        args: { method: "submit", event: "APPROVE" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("does NOT interpret Bitbucket decision tools", () => {
      expect(
        toolset.interpretDecision({
          toolName: "set_pr_approval",
          args: { approved: true },
        }),
      ).toBeNull();
      expect(
        toolset.interpretDecision({
          toolName: "set_review_status",
          args: { request_changes: true },
        }),
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Bitbucket: interpretDecision
  // ==========================================================================
  describe("Bitbucket interpretDecision", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("bitbucket");
    });

    test("set_pr_approval(approved=true) -> APPROVED", () => {
      const call: ProviderToolCall = {
        toolName: "set_pr_approval",
        args: { approved: true },
      };
      expect(toolset.interpretDecision(call)).toBe("APPROVED");
    });

    test("set_pr_approval(approved=false) -> null", () => {
      const call: ProviderToolCall = {
        toolName: "set_pr_approval",
        args: { approved: false },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("set_pr_approval with non-boolean approved -> null", () => {
      const call: ProviderToolCall = {
        toolName: "set_pr_approval",
        args: { approved: "true" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("set_pr_approval with no args -> null", () => {
      const call: ProviderToolCall = { toolName: "set_pr_approval" };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("set_review_status(request_changes=true) -> BLOCKED", () => {
      const call: ProviderToolCall = {
        toolName: "set_review_status",
        args: { request_changes: true },
      };
      expect(toolset.interpretDecision(call)).toBe("BLOCKED");
    });

    test("set_review_status(request_changes=false) -> null", () => {
      const call: ProviderToolCall = {
        toolName: "set_review_status",
        args: { request_changes: false },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("set_review_status with non-boolean request_changes -> null", () => {
      const call: ProviderToolCall = {
        toolName: "set_review_status",
        args: { request_changes: "yes" },
      };
      expect(toolset.interpretDecision(call)).toBeNull();
    });

    test("legacy approve_pull_request -> APPROVED", () => {
      expect(
        toolset.interpretDecision({ toolName: "approve_pull_request" }),
      ).toBe("APPROVED");
    });

    test("legacy unapprove_pull_request -> null", () => {
      expect(
        toolset.interpretDecision({ toolName: "unapprove_pull_request" }),
      ).toBeNull();
    });

    test("legacy request_changes -> BLOCKED", () => {
      expect(toolset.interpretDecision({ toolName: "request_changes" })).toBe(
        "BLOCKED",
      );
    });

    test("legacy remove_requested_changes -> null", () => {
      expect(
        toolset.interpretDecision({ toolName: "remove_requested_changes" }),
      ).toBeNull();
    });

    test("unrelated tool -> null", () => {
      expect(
        toolset.interpretDecision({
          toolName: "get_pull_request",
          args: { approved: true },
        }),
      ).toBeNull();
    });

    test("missing toolName -> null", () => {
      expect(
        toolset.interpretDecision({ args: { approved: true } }),
      ).toBeNull();
    });

    test("does NOT interpret the GitHub review-write tool", () => {
      expect(
        toolset.interpretDecision({
          toolName: "pull_request_review_write",
          args: { method: "submit", event: "APPROVE" },
        }),
      ).toBeNull();
    });
  });

  // ==========================================================================
  // Tool-name registries
  // ==========================================================================
  describe("GitHub tool-name registries", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("github");
    });

    test("commentToolNames contains the pending-review and issue comment tools", () => {
      expect(toolset.commentToolNames).toEqual(
        expect.arrayContaining([
          "add_comment_to_pending_review",
          "add_issue_comment",
        ]),
      );
    });

    test("diffToolNames is the consolidated pull_request_read tool", () => {
      expect(toolset.diffToolNames).toEqual(["pull_request_read"]);
    });

    test("mutationToolNames includes review-write and repo-mutation tools", () => {
      expect(toolset.mutationToolNames).toEqual(
        expect.arrayContaining([
          "pull_request_review_write",
          "add_comment_to_pending_review",
          "add_issue_comment",
          "update_pull_request",
          "push_files",
          "create_or_update_file",
          "create_branch",
          "delete_file",
        ]),
      );
    });

    test("mutationToolNames does NOT contain Bitbucket-only names", () => {
      expect(toolset.mutationToolNames).not.toContain("set_pr_approval");
      expect(toolset.mutationToolNames).not.toContain("merge_pull_request");
    });
  });

  describe("Bitbucket tool-name registries", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("bitbucket");
    });

    test("commentToolNames is add_comment", () => {
      expect(toolset.commentToolNames).toEqual(["add_comment"]);
    });

    test("diffToolNames is get_pull_request_diff", () => {
      expect(toolset.diffToolNames).toEqual(["get_pull_request_diff"]);
    });

    test("mutationToolNames includes the blocked Bitbucket mutation names", () => {
      expect(toolset.mutationToolNames).toEqual(
        expect.arrayContaining([
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
        ]),
      );
    });

    test("mutationToolNames does NOT contain GitHub-only names", () => {
      expect(toolset.mutationToolNames).not.toContain(
        "pull_request_review_write",
      );
      expect(toolset.mutationToolNames).not.toContain("push_files");
    });
  });

  // ==========================================================================
  // identifierXml
  // ==========================================================================
  describe("GitHub identifierXml", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("github");
    });

    test("includes owner / repo / pull_number from params", () => {
      const xml = toolset.identifierXml({
        owner: "my-org",
        repo: "my-repo",
        prNumber: 42,
      });
      expect(xml).toContain("<owner>my-org</owner>");
      expect(xml).toContain("<repo>my-repo</repo>");
      expect(xml).toContain("<pull_number>42</pull_number>");
    });

    test("falls back to find-by-branch when prNumber is missing", () => {
      const xml = toolset.identifierXml({ owner: "o", repo: "r" });
      expect(xml).toContain("<pull_number>find-by-branch</pull_number>");
    });

    test("keeps pull_number 0 rather than falling back", () => {
      const xml = toolset.identifierXml({ owner: "o", repo: "r", prNumber: 0 });
      expect(xml).toContain("<pull_number>0</pull_number>");
    });

    test("does NOT emit Bitbucket identifier fields", () => {
      const xml = toolset.identifierXml({
        owner: "o",
        repo: "r",
        prNumber: 1,
      });
      expect(xml).not.toContain("<workspace>");
      expect(xml).not.toContain("<pull_request_id>");
    });

    test("escapes XML special characters in owner/repo", () => {
      const xml = toolset.identifierXml({
        owner: "a&b",
        repo: "<r>",
        prNumber: 7,
      });
      expect(xml).toContain("<owner>a&amp;b</owner>");
      expect(xml).toContain("<repo>&lt;r&gt;</repo>");
    });
  });

  describe("Bitbucket identifierXml", () => {
    let toolset: ProviderToolset;

    beforeEach(() => {
      toolset = getProviderToolset("bitbucket");
    });

    test("includes workspace / repository / pull_request_id / branch from params", () => {
      const xml = toolset.identifierXml({
        workspace: "ws",
        repository: "repo",
        pullRequestId: 99,
        branch: "feature/x",
      });
      expect(xml).toContain("<workspace>ws</workspace>");
      expect(xml).toContain("<repository>repo</repository>");
      expect(xml).toContain("<pull_request_id>99</pull_request_id>");
      expect(xml).toContain("<branch>feature/x</branch>");
    });

    test("falls back to find-by-branch when pullRequestId is missing", () => {
      const xml = toolset.identifierXml({
        workspace: "ws",
        repository: "repo",
      });
      expect(xml).toContain(
        "<pull_request_id>find-by-branch</pull_request_id>",
      );
    });

    test("defaults branch to N/A when missing", () => {
      const xml = toolset.identifierXml({
        workspace: "ws",
        repository: "repo",
        pullRequestId: 1,
      });
      expect(xml).toContain("<branch>N/A</branch>");
    });

    test("does NOT emit GitHub identifier fields", () => {
      const xml = toolset.identifierXml({
        workspace: "ws",
        repository: "repo",
        pullRequestId: 1,
      });
      expect(xml).not.toContain("<owner>");
      expect(xml).not.toContain("<pull_number>");
    });

    test("escapes XML special characters in workspace/repository", () => {
      const xml = toolset.identifierXml({
        workspace: "a&b",
        repository: "<r>",
        pullRequestId: 1,
      });
      expect(xml).toContain("<workspace>a&amp;b</workspace>");
      expect(xml).toContain("<repository>&lt;r&gt;</repository>");
    });
  });

  // ==========================================================================
  // systemPromptToolsSection
  // ==========================================================================
  describe("GitHub systemPromptToolsSection", () => {
    let section: string;

    beforeEach(() => {
      section = getProviderToolset("github").systemPromptToolsSection();
    });

    test("mentions the GitHub consolidated tools", () => {
      expect(section).toContain("pull_request_read");
      expect(section).toContain("add_comment_to_pending_review");
      expect(section).toContain("pull_request_review_write");
    });

    test("does NOT mention Bitbucket-only tools", () => {
      expect(section).not.toContain("get_pull_request_diff");
      expect(section).not.toContain("set_pr_approval");
    });
  });

  describe("Bitbucket systemPromptToolsSection", () => {
    let section: string;

    beforeEach(() => {
      section = getProviderToolset("bitbucket").systemPromptToolsSection();
    });

    test("mentions the Bitbucket tools", () => {
      expect(section).toContain("get_pull_request");
      expect(section).toContain("add_comment");
      expect(section).toContain("set_pr_approval");
    });

    test("does NOT mention GitHub-only tools", () => {
      expect(section).not.toContain("pull_request_review_write");
      expect(section).not.toContain("add_comment_to_pending_review");
    });
  });

  // ==========================================================================
  // reviewWorkflowInstructions
  // ==========================================================================
  describe("reviewWorkflowInstructions", () => {
    test("GitHub references the pending-review submit flow", () => {
      const instructions = getProviderToolset(
        "github",
      ).reviewWorkflowInstructions({});
      // Opens a single pending review and submits it with a decision event.
      expect(instructions).toContain("pending review");
      expect(instructions).toContain('method="create"');
      expect(instructions).toContain('method="submit"');
      expect(instructions).toContain('event="APPROVE"');
      expect(instructions).toContain('event="REQUEST_CHANGES"');
    });

    test("Bitbucket references the set_pr_approval / set_review_status decision", () => {
      const instructions = getProviderToolset(
        "bitbucket",
      ).reviewWorkflowInstructions({});
      expect(instructions).toContain("set_pr_approval");
      expect(instructions).toContain("set_review_status");
      // Bitbucket has no pending-review batch model.
      expect(instructions).not.toContain("pending review");
    });
  });
});
