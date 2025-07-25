/**
 * Comprehensive unit tests for DescriptionEnhancer
 * Tests AI-powered PR description enhancement, content preservation, and section management
 */

import { DescriptionEnhancer } from "../../src/features/DescriptionEnhancer";
import { BitbucketProvider } from "../../src/core/providers/BitbucketProvider";
import { UnifiedContext } from "../../src/core/ContextGatherer";
import {
  AIProviderConfig,
  EnhancementOptions,
  DescriptionEnhancementConfig,
} from "../../src/types";

// Mock NeuroLink
const mockNeurolink = {
  generate: jest.fn(),
};

// Mock dynamic import for NeuroLink
global.eval = jest.fn().mockReturnValue(
  jest.fn().mockResolvedValue({
    NeuroLink: jest.fn().mockImplementation(() => mockNeurolink),
  }),
);

describe("DescriptionEnhancer", () => {
  let descriptionEnhancer: DescriptionEnhancer;
  let mockBitbucketProvider: jest.Mocked<BitbucketProvider>;
  let mockAIConfig: AIProviderConfig;
  let mockEnhancementConfig: DescriptionEnhancementConfig;
  let mockContext: UnifiedContext;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock BitbucketProvider
    mockBitbucketProvider = {
      updatePRDescription: jest.fn(),
      getPRDetails: jest.fn(),
      getPRDiff: jest.fn(),
      findPRForBranch: jest.fn(),
      getFileContent: jest.fn(),
      listDirectoryContent: jest.fn(),
      addComment: jest.fn(),
      initialize: jest.fn(),
      healthCheck: jest.fn(),
      getStats: jest.fn(),
      clearCache: jest.fn(),
      batchOperations: jest.fn(),
    } as any;

    mockAIConfig = {
      provider: "google-ai",
      model: "gemini-2.5-pro",
      enableAnalytics: true,
      enableEvaluation: true,
      enableFallback: true,
      timeout: "5m",
      temperature: 0.5,
      maxTokens: 1000000,
    };

    mockEnhancementConfig = {
      enabled: true,
      preserveContent: true,
      requiredSections: [
        {
          key: "changelog",
          name: "Changelog (Modules Modified)",
          required: true,
        },
        {
          key: "testcases",
          name: "Test Cases (What to be tested)",
          required: true,
        },
        {
          key: "config_changes",
          name: "CAC Config Or Service Config Changes",
          required: true,
        },
      ],
      autoFormat: true,
      systemPrompt: "Test enhancement system prompt",
      outputTemplate: "# Test Template",
      enhancementInstructions: "Test instructions",
    };

    mockContext = {
      pr: globalThis.testUtils.createMockPR({
        id: 12345,
        title: "Add user authentication feature",
        description: `This PR adds authentication functionality.

![screenshot](screenshot.png)

[Design Doc](design.md)

## Current Implementation
Basic login form added.`,
      }),
      identifier: {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
      },
      projectContext: {
        memoryBank: {
          summary: "Test project context",
          projectContext: "React authentication app",
          patterns: "JWT tokens, secure storage",
          standards: "Security-first approach",
        },
        clinerules: "Require changelog and test cases",
        filesProcessed: 3,
      },
      diffStrategy: {
        strategy: "whole",
        reason: "Small changeset",
        fileCount: 5,
        estimatedSize: "Small",
      },
      prDiff: globalThis.testUtils.createMockDiff({
        diff: `diff --git a/src/auth/Login.js b/src/auth/Login.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/auth/Login.js
@@ -0,0 +1,25 @@
+import React, { useState } from 'react';
+import { authenticateUser } from './authService';
+
+const Login = () => {
+  const [email, setEmail] = useState('');
+  const [password, setPassword] = useState('');
+
+  const handleSubmit = async (e) => {
+    e.preventDefault();
+    try {
+      await authenticateUser(email, password);
+    } catch (error) {
+      console.error('Login failed:', error);
+    }
+  };
+
+  return (
+    <form onSubmit={handleSubmit}>
+      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
+      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
+      <button type="submit">Login</button>
+    </form>
+  );
+};`,
        fileChanges: [
          "src/auth/Login.js",
          "src/auth/authService.js",
          "src/components/Header.js",
        ],
      }),
      contextId: "test-context-id",
      gatheredAt: "2024-01-01T00:00:00Z",
      cacheHits: [],
      gatheringDuration: 1000,
    } as UnifiedContext;

    descriptionEnhancer = new DescriptionEnhancer(
      mockBitbucketProvider,
      mockAIConfig,
    );

    // Pre-initialize neurolink to use our mock
    (descriptionEnhancer as any).neurolink = mockNeurolink;
  });

  describe("Constructor", () => {
    it("should create DescriptionEnhancer with providers", () => {
      expect(descriptionEnhancer).toBeDefined();
      expect((descriptionEnhancer as any).bitbucketProvider).toBe(
        mockBitbucketProvider,
      );
      expect((descriptionEnhancer as any).aiConfig).toBe(mockAIConfig);
    });
  });

  describe("enhanceWithContext", () => {
    it("should enhance PR description successfully", async () => {
      const mockEnhancementResponse = {
        content: `This PR adds comprehensive user authentication functionality to the application.

![screenshot](screenshot.png)

[Design Doc](design.md)

## Current Implementation
Basic login form added.

## Changelog (Modules Modified)
- \`src/auth/Login.js\` - New login component with form validation
- \`src/auth/authService.js\` - Authentication service with JWT handling
- \`src/components/Header.js\` - Updated to show login/logout state

## Test Cases (What to be tested)
- User can login with valid credentials
- Invalid credentials show appropriate error messages
- JWT token is properly stored and validated
- Logout functionality clears authentication state
- Protected routes redirect to login when unauthenticated

## CAC Config Or Service Config Changes
- Added \`AUTH_JWT_SECRET\` environment variable
- Updated CORS settings to allow authentication endpoints
- Added rate limiting for login attempts`,
      };

      mockNeurolink.generate.mockResolvedValue(mockEnhancementResponse);
      mockBitbucketProvider.updatePRDescription.mockResolvedValue({
        success: true,
        message: "Description updated successfully",
      });

      const options: EnhancementOptions = {
        workspace: "test-workspace",
        repository: "test-repo",
        pullRequestId: 12345,
        preserveContent: true,
        ensureRequiredSections: true,
      };

      const result = await descriptionEnhancer.enhanceWithContext(
        mockContext,
        options,
      );

      expect(result).toEqual({
        originalDescription: mockContext.pr.description,
        enhancedDescription: expect.stringContaining(
          "Changelog (Modules Modified)",
        ),
        sectionsAdded: [
          "Changelog (Modules Modified)",
          "Test Cases (What to be tested)",
          "CAC Config Or Service Config Changes",
        ],
        sectionsEnhanced: [],
        preservedItems: {
          media: 1,
          files: 0,
          links: 2,
        },
        statistics: {
          originalLength: mockContext.pr.description.length,
          enhancedLength: expect.any(Number),
          completedSections: 3,
          totalSections: 3,
        },
      });

      // Verify AI was called with correct parameters
      const aiCallArgs = mockNeurolink.generate.mock.calls[0][0];
      expect(aiCallArgs.input.text).toContain("PR INFORMATION");
      expect(aiCallArgs.provider).toBe("google-ai"); // Uses provided config
      expect(aiCallArgs.model).toBe("gemini-2.5-pro"); // Uses provided config
      expect(aiCallArgs.maxTokens).toBe(1000000); // From config
      expect(aiCallArgs.timeout).toBe("8m"); // From implementation
      expect(aiCallArgs.enableAnalytics).toBe(true);
      expect(aiCallArgs.enableEvaluation).toBe(true);

      // Verify PR description was updated
      expect(mockBitbucketProvider.updatePRDescription).toHaveBeenCalledWith(
        mockContext.identifier,
        expect.stringContaining("Changelog (Modules Modified)"),
      );
    });

    it("should handle dry run mode", async () => {
      const mockEnhancementResponse = {
        content: `This PR adds authentication functionality.

![screenshot](screenshot.png)

[Design Doc](design.md)

## Current Implementation
Basic login form added.

## Changelog (Modules Modified)
- Added authentication features`,
      };

      mockNeurolink.generate.mockResolvedValue(mockEnhancementResponse);

      const result = await descriptionEnhancer.enhanceWithContext(mockContext, {
        workspace: "test",
        repository: "test",
        pullRequestId: 123,
        dryRun: true,
      });

      expect(result.originalDescription).toBe(mockContext.pr.description);
      expect(mockBitbucketProvider.updatePRDescription).not.toHaveBeenCalled();
    });

    it("should handle AI service failures gracefully", async () => {
      mockNeurolink.generate.mockRejectedValue(
        new Error("AI service unavailable"),
      );

      await expect(
        descriptionEnhancer.enhanceWithContext(mockContext, {
          workspace: "test",
          repository: "test",
          pullRequestId: 123,
        }),
      ).rejects.toThrow(
        "Description enhancement failed: AI service unavailable",
      );
    });

    it("should handle PR update failures", async () => {
      const mockEnhancementResponse = {
        content: "Enhanced description with sections",
      };

      mockNeurolink.generate.mockResolvedValue(mockEnhancementResponse);
      mockBitbucketProvider.updatePRDescription.mockRejectedValue(
        new Error("Update failed"),
      );

      await expect(
        descriptionEnhancer.enhanceWithContext(mockContext, {
          workspace: "test",
          repository: "test",
          pullRequestId: 123,
        }),
      ).rejects.toThrow(
        "Description enhancement failed: Description update failed: Update failed",
      );
    });
  });

  describe("Content Analysis via Public Interface", () => {
    it("should preserve existing content when preserveContent is true", async () => {
      const mockEnhancementResponse = {
        content: `Enhanced description with new sections.

![screenshot](screenshot.png)
[Design Doc](design.md)

## Changelog (Modules Modified)
- Added authentication`,
      };

      mockNeurolink.generate.mockResolvedValue(mockEnhancementResponse);
      mockBitbucketProvider.updatePRDescription.mockResolvedValue({
        success: true,
        message: "Updated",
      });

      const result = await descriptionEnhancer.enhanceWithContext(mockContext, {
        workspace: "test",
        repository: "test",
        pullRequestId: 123,
        preserveContent: true,
      });

      expect(result.enhancedDescription).toContain(
        "![screenshot](screenshot.png)",
      );
      expect(result.enhancedDescription).toContain("[Design Doc](design.md)");
      expect(result.preservedItems.media).toBe(1);
      expect(result.preservedItems.files).toBe(0);
      expect(result.preservedItems.links).toBe(2);
    });

    it("should handle unicode and special characters", async () => {
      const unicodeContext = {
        ...mockContext,
        pr: {
          ...mockContext.pr,
          description:
            "🚀 Feature: 测试 emoji and unicode 🌟\n\n[文档](doc.md)",
        },
      };

      const mockResponse = {
        content:
          unicodeContext.pr.description +
          "\n\n## 📋 Changelog\n- Added 测试 feature",
      };

      mockNeurolink.generate.mockResolvedValue(mockResponse);
      mockBitbucketProvider.updatePRDescription.mockResolvedValue({
        success: true,
        message: "Updated",
      });

      const result = await descriptionEnhancer.enhanceWithContext(
        unicodeContext,
        {
          workspace: "test",
          repository: "test",
          pullRequestId: 123,
        },
      );

      expect(result.enhancedDescription).toContain("🚀");
      expect(result.enhancedDescription).toContain("测试");
      expect(result.preservedItems.files).toBe(0);
      expect(result.preservedItems.links).toBe(1);
    });
  });
});
