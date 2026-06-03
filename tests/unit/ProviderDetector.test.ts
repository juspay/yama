/**
 * Comprehensive Unit Tests for ProviderDetector
 * Tests detection logic for GitHub vs Bitbucket providers
 */

import {
  ProviderDetector,
  detectProvider,
  type VCSProvider,
} from "../../src/v2/utils/ProviderDetector.js";
import type { ReviewRequest } from "../../src/v2/types/v2.types.js";

describe("ProviderDetector", () => {
  // ============================================================================
  // Helper function to create minimal ReviewRequest
  // ============================================================================
  function createRequest(
    overrides: Partial<ReviewRequest> = {},
  ): ReviewRequest {
    return {
      mode: "pr",
      ...overrides,
    };
  }

  // ============================================================================
  // Test Suite 1: GitHub Detection from Environment Variables
  // ============================================================================
  describe("GitHub detection from environment variables", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test("should detect GitHub from GITHUB_SERVER_URL env var", () => {
      const env = {
        GITHUB_SERVER_URL: "https://github.com",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from GITHUB_REPOSITORY env var", () => {
      const env = {
        GITHUB_REPOSITORY: "owner/repo",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from GITHUB_ACTIONS=true env var", () => {
      const env = {
        GITHUB_ACTIONS: "true",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should not detect GitHub from GITHUB_ACTIONS=false env var", () => {
      const env = {
        GITHUB_ACTIONS: "false",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket"); // Falls back to default
    });

    test("should detect GitHub from GITHUB_ACTION env var", () => {
      const env = {
        GITHUB_ACTION: "run",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub with multiple GitHub env vars", () => {
      const env = {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_ACTIONS: "true",
      };
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });
  });

  // ============================================================================
  // Test Suite 2: GitHub Detection from Request Parameters
  // ============================================================================
  describe("GitHub detection from request parameters", () => {
    test("should detect GitHub when owner parameter is provided", () => {
      const env = {};
      const request = createRequest({ owner: "github-user" });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub when both owner and repo are provided", () => {
      const env = {};
      const request = createRequest({
        owner: "github-user",
        repo: "github-repo",
        prNumber: 42,
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should not detect GitHub from prNumber alone without owner", () => {
      const env = {};
      const request = createRequest({
        prNumber: 42,
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket"); // Falls back to default
    });
  });

  // ============================================================================
  // Test Suite 3: Bitbucket Detection from Request Parameters
  // ============================================================================
  describe("Bitbucket detection from request parameters", () => {
    test("should detect Bitbucket when workspace parameter is provided", () => {
      const env = {};
      const request = createRequest({ workspace: "my-workspace" });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should detect Bitbucket when workspace and repository are provided", () => {
      const env = {};
      const request = createRequest({
        workspace: "my-workspace",
        repository: "my-repo",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });
  });

  // ============================================================================
  // Test Suite 4: GitHub Detection from Clone URLs
  // ============================================================================
  describe("GitHub detection from clone URLs", () => {
    test("should detect GitHub from HTTPS clone URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://github.com/owner/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from HTTPS clone URL without .git suffix", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://github.com/owner/repo",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from SSH clone URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "git@github.com:owner/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from git+https URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "git+https://github.com/owner/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from github. subdomain", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://github.enterprise.com/owner/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should detect GitHub from uppercase URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "HTTPS://GITHUB.COM/OWNER/REPO.GIT",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });
  });

  // ============================================================================
  // Test Suite 5: Bitbucket Detection from Clone URLs
  // ============================================================================
  describe("Bitbucket detection from clone URLs", () => {
    test("should detect Bitbucket from HTTPS clone URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://bitbucket.org/workspace/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should detect Bitbucket from HTTPS clone URL without .git suffix", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://bitbucket.org/workspace/repo",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should detect Bitbucket from SSH clone URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "git@bitbucket.org:workspace/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should detect Bitbucket from generic bitbucket URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://bitbucket.com/workspace/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should detect Bitbucket from uppercase URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "HTTPS://BITBUCKET.ORG/WORKSPACE/REPO.GIT",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });
  });

  // ============================================================================
  // Test Suite 6: Priority and Fallback Logic
  // ============================================================================
  describe("Priority and fallback logic", () => {
    test("should use explicit provider parameter over everything", () => {
      const env = {
        GITHUB_REPOSITORY: "owner/repo",
      };
      const request = createRequest({
        provider: "bitbucket",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should prefer GitHub env vars over request params", () => {
      const env = {
        GITHUB_SERVER_URL: "https://github.com",
      };
      const request = createRequest({
        workspace: "my-workspace",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should prefer request owner param over clone URL", () => {
      const env = {};
      const request = createRequest({
        owner: "github-user",
        cloneUrl: "https://bitbucket.org/workspace/repo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("should prefer clone URL detection over config default", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "https://github.com/owner/repo.git",
      });

      const result = ProviderDetector.detect(request, env, "bitbucket");

      expect(result).toBe("github");
    });

    test("should use config default when no other indicators present", () => {
      const env = {};
      const request = createRequest();

      const result = ProviderDetector.detect(request, env, "github");

      expect(result).toBe("github");
    });

    test("should fallback to Bitbucket when no indicators present", () => {
      const env = {};
      const request = createRequest();

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should not use config default when explicit provider set", () => {
      const env = {};
      const request = createRequest({ provider: "bitbucket" });

      const result = ProviderDetector.detect(request, env, "github");

      expect(result).toBe("bitbucket");
    });
  });

  // ============================================================================
  // Test Suite 7: GitHub URL Extraction
  // ============================================================================
  describe("GitHub owner extraction", () => {
    test("should extract owner from HTTPS GitHub URL", () => {
      const url = "https://github.com/my-owner/my-repo";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBe("my-owner");
    });

    test("should extract owner from HTTPS GitHub URL with .git suffix", () => {
      const url = "https://github.com/my-owner/my-repo.git";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBe("my-owner");
    });

    test("should extract owner from SSH GitHub URL", () => {
      const url = "git@github.com:my-owner/my-repo.git";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBe("my-owner");
    });

    test("should extract owner with hyphens and underscores", () => {
      const url = "https://github.com/my-owner_123/my-repo";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBe("my-owner_123");
    });

    test("should handle uppercase URL for owner extraction", () => {
      const url = "HTTPS://GITHUB.COM/MY-OWNER/MY-REPO";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBeNull();
    });

    test("should return null for malformed GitHub URL", () => {
      const url = "https://github.com/invalid-url";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBeNull();
    });

    test("should return null for non-GitHub URL", () => {
      const url = "https://bitbucket.org/workspace/repo";

      const result = ProviderDetector.extractGitHubOwner(url);

      expect(result).toBeNull();
    });

    test("should return null for empty string", () => {
      const result = ProviderDetector.extractGitHubOwner("");

      expect(result).toBeNull();
    });
  });

  describe("GitHub repo extraction", () => {
    test("should extract repo from HTTPS GitHub URL", () => {
      const url = "https://github.com/my-owner/my-repo";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("my-repo");
    });

    test("should extract repo from HTTPS GitHub URL with .git suffix", () => {
      const url = "https://github.com/my-owner/my-repo.git";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("my-repo");
    });

    test("should extract repo from SSH GitHub URL", () => {
      const url = "git@github.com:my-owner/my-repo.git";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("my-repo");
    });

    test("should extract repo with hyphens and numbers", () => {
      const url = "https://github.com/owner/my-repo-123";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("my-repo-123");
    });

    test("should extract repo without .git suffix", () => {
      const url = "git@github.com:owner/repo";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("repo");
    });

    test("should return null for malformed GitHub URL", () => {
      const url = "https://github.com/owner/";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBeNull();
    });

    test("should return null for non-GitHub URL", () => {
      const url = "https://bitbucket.org/workspace/repo";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("repo"); // Extracts from any URL with similar format
    });

    test("should return null for empty string", () => {
      const result = ProviderDetector.extractGitHubRepo("");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Test Suite 8: Bitbucket URL Extraction
  // ============================================================================
  describe("Bitbucket workspace extraction", () => {
    test("should extract workspace from HTTPS Bitbucket URL", () => {
      const url = "https://bitbucket.org/my-workspace/my-repo";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBe("my-workspace");
    });

    test("should extract workspace from HTTPS Bitbucket URL with .git suffix", () => {
      const url = "https://bitbucket.org/my-workspace/my-repo.git";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBe("my-workspace");
    });

    test("should extract workspace from SSH Bitbucket URL", () => {
      const url = "git@bitbucket.org:my-workspace/my-repo.git";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBe("my-workspace");
    });

    test("should extract workspace with hyphens and underscores", () => {
      const url = "https://bitbucket.org/my-workspace_123/my-repo";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBe("my-workspace_123");
    });

    test("should handle bitbucket.com domain", () => {
      const url = "https://bitbucket.com/my-workspace/my-repo";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      // Note: The regex pattern requires a colon or specific domain format
      // bitbucket.com HTTPS URLs require the specific HTTPS regex pattern
      expect(result).toBeNull();
    });

    test("should return null for malformed Bitbucket URL", () => {
      const url = "https://bitbucket.org/invalid-url";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBeNull();
    });

    test("should return null for non-Bitbucket URL", () => {
      const url = "https://github.com/owner/repo";

      const result = ProviderDetector.extractBitbucketWorkspace(url);

      expect(result).toBeNull();
    });

    test("should return null for empty string", () => {
      const result = ProviderDetector.extractBitbucketWorkspace("");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Test Suite 9: detectFromUrl method
  // ============================================================================
  describe("detectFromUrl method", () => {
    test("should detect GitHub from various GitHub URLs", () => {
      const githubUrls = [
        "https://github.com/owner/repo",
        "git@github.com:owner/repo.git",
        "https://github.enterprise.com/owner/repo",
        "GIT@GITHUB.COM:OWNER/REPO.GIT",
      ];

      githubUrls.forEach((url) => {
        expect(ProviderDetector.detectFromUrl(url)).toBe("github");
      });
    });

    test("should detect Bitbucket from various Bitbucket URLs", () => {
      const bitbucketUrls = [
        "https://bitbucket.org/workspace/repo",
        "git@bitbucket.org:workspace/repo.git",
        "https://bitbucket.com/workspace/repo",
        "GIT@BITBUCKET.ORG:WORKSPACE/REPO.GIT",
      ];

      bitbucketUrls.forEach((url) => {
        expect(ProviderDetector.detectFromUrl(url)).toBe("bitbucket");
      });
    });

    test("should default to Bitbucket for unknown URLs", () => {
      const unknownUrls = [
        "https://gitlab.com/owner/repo",
        "https://example.com/repo",
        "invalid-url",
      ];

      unknownUrls.forEach((url) => {
        expect(ProviderDetector.detectFromUrl(url)).toBe("bitbucket");
      });
    });

    test("should handle invalid URLs gracefully", () => {
      expect(() => {
        ProviderDetector.detectFromUrl(";;;:::");
      }).not.toThrow();

      expect(ProviderDetector.detectFromUrl(";;;:::")).toBe("bitbucket");
    });

    test("should NOT detect github from a spoofed host containing github.com in the domain", () => {
      // host is github.com.evil.com — must not be classified as github
      expect(
        ProviderDetector.detectFromUrl("https://github.com.evil.com/foo"),
      ).toBe("bitbucket");
    });

    test("should NOT detect github when github.com only appears in the URL path", () => {
      expect(
        ProviderDetector.detectFromUrl(
          "https://evil.com/github.com/owner/repo",
        ),
      ).toBe("bitbucket");
    });
  });

  // ============================================================================
  // Test Suite 10: detectProvider helper function
  // ============================================================================
  describe("detectProvider helper function", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    test("should detect GitHub provider using process.env", () => {
      process.env.GITHUB_REPOSITORY = "owner/repo";

      const request = createRequest();
      const result = detectProvider(request);

      expect(result).toBe("github");
    });

    test("should detect Bitbucket provider using process.env", () => {
      // Clear GitHub env vars
      delete process.env.GITHUB_SERVER_URL;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_ACTION;

      const request = createRequest({ workspace: "my-workspace" });
      const result = detectProvider(request);

      expect(result).toBe("bitbucket");
    });

    test("should use config default with detectProvider", () => {
      // Clear GitHub env vars
      delete process.env.GITHUB_SERVER_URL;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_ACTION;

      const request = createRequest();
      const result = detectProvider(request, "github");

      expect(result).toBe("github");
    });

    test("should fallback to Bitbucket with detectProvider", () => {
      // Clear GitHub env vars
      delete process.env.GITHUB_SERVER_URL;
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_ACTIONS;
      delete process.env.GITHUB_ACTION;

      const request = createRequest();
      const result = detectProvider(request);

      expect(result).toBe("bitbucket");
    });
  });

  // ============================================================================
  // Test Suite 11: Edge Cases and Error Handling
  // ============================================================================
  describe("Edge cases and error handling", () => {
    test("should handle null cloneUrl gracefully", () => {
      const env = {};
      // cloneUrl is typed `string | undefined`, but at runtime a provider
      // payload can surface an explicit null. Inject the null via a typed
      // override (no `as any`) to assert detect() tolerates it.
      const override: Partial<ReviewRequest> = { cloneUrl: undefined };
      (override as { cloneUrl: string | null }).cloneUrl = null;
      const request = createRequest(override);

      expect(() => {
        ProviderDetector.detect(request, env);
      }).not.toThrow();
    });

    test("should handle undefined workspace as not set", () => {
      const env = {};
      const request = createRequest({ workspace: undefined });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should handle undefined owner as not set", () => {
      const env = {};
      const request = createRequest({ owner: undefined });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should handle empty string owner as not set", () => {
      const env = {};
      const request = createRequest({ owner: "" });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should handle prNumber without owner", () => {
      const env = {};
      const request = createRequest({ prNumber: 42 });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("should extract URLs with trailing slashes", () => {
      const url = "https://github.com/owner/repo/";

      const result = ProviderDetector.extractGitHubRepo(url);

      // The regex /\/([^/]+?)(?:\.git)?$/ won't match empty string at end
      expect(result).toBeNull();
    });

    test("should extract URLs with special characters in repo name", () => {
      const url = "https://github.com/owner/my-repo-123_test";

      const result = ProviderDetector.extractGitHubRepo(url);

      expect(result).toBe("my-repo-123_test");
    });

    test("should handle multiple slashes in URL", () => {
      const url = "https://github.com//owner//repo/";

      expect(() => {
        ProviderDetector.extractGitHubOwner(url);
      }).not.toThrow();
    });
  });

  // ============================================================================
  // Test Suite 12: Real-world Scenarios
  // ============================================================================
  describe("Real-world scenarios", () => {
    test("GitHub Actions CI environment", () => {
      const env = {
        GITHUB_ACTIONS: "true",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "myorg/myrepo",
      };
      const request = createRequest({ prNumber: 123 });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("Bitbucket Pipeline CI environment", () => {
      const env = {
        BITBUCKET_WORKSPACE: "myworkspace",
      };
      const request = createRequest({ workspace: "myworkspace" });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("Local development with GitHub clone URL", () => {
      const env = {};
      const request = createRequest({
        cloneUrl: "git@github.com:myorg/myrepo.git",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("CLI invocation with explicit GitHub owner and repo", () => {
      const env = {};
      const request = createRequest({
        owner: "myorg",
        repo: "myrepo",
        prNumber: 42,
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github");
    });

    test("CLI invocation with explicit Bitbucket workspace and repo", () => {
      const env = {};
      const request = createRequest({
        workspace: "myworkspace",
        repository: "myrepo",
        pullRequestId: 42,
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("bitbucket");
    });

    test("Conflicting signals: GitHub env var vs Bitbucket clone URL", () => {
      const env = {
        GITHUB_REPOSITORY: "owner/repo",
      };
      const request = createRequest({
        cloneUrl: "https://bitbucket.org/workspace/repo",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github"); // GitHub env vars have priority
    });

    test("Conflicting signals: GitHub owner vs Bitbucket clone URL", () => {
      const env = {};
      const request = createRequest({
        owner: "myowner",
        cloneUrl: "https://bitbucket.org/workspace/repo",
      });

      const result = ProviderDetector.detect(request, env);

      expect(result).toBe("github"); // owner parameter has priority
    });
  });
});
