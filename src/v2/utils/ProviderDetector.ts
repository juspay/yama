/**
 * Provider Detection Utility
 * Automatically detects GitHub vs Bitbucket from environment, CLI params, or URLs
 */

import type { ReviewRequest } from "../types/v2.types.js";

export type VCSProvider = "github" | "bitbucket";

export class ProviderDetector {
  /**
   * Detect VCS provider with intelligent fallback chain
   * Priority: GitHub env → Request params → Clone URL → Config default → Bitbucket
   */
  static detect(
    request: ReviewRequest,
    env: NodeJS.ProcessEnv = process.env,
    configDefault?: VCSProvider,
  ): VCSProvider {
    // 1. Explicit provider in request
    if (request.provider) {
      return request.provider;
    }

    // 2. GitHub Actions environment
    if (
      env.GITHUB_SERVER_URL ||
      env.GITHUB_REPOSITORY ||
      env.GITHUB_ACTION ||
      env.GITHUB_ACTIONS === "true"
    ) {
      return "github";
    }

    // 3. GitHub CLI parameters
    if (request.owner || request.prNumber !== undefined) {
      // If owner is provided, it's GitHub
      if (request.owner) {
        return "github";
      }
    }

    // 4. Bitbucket CLI parameters
    if (request.workspace) {
      return "bitbucket";
    }

    // 5. Clone URL detection
    if (request.cloneUrl) {
      return ProviderDetector.detectFromUrl(request.cloneUrl);
    }

    // 6. Config-level default
    if (configDefault) {
      return configDefault;
    }

    // 7. Fallback to Bitbucket (backward compatibility)
    return "bitbucket";
  }

  /**
   * Extract the hostname from a clone/remote URL.
   * Supports SCP/SSH form (git@host:owner/repo, no scheme) and standard URLs.
   * Returns a lowercased hostname, or '' if it cannot be determined.
   */
  private static extractHostname(url: string): string {
    try {
      // SCP/SSH form has no scheme: [user@]host:path (path is not //...)
      if (!url.includes("://")) {
        const scpMatch = url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)/);
        if (scpMatch) {
          return scpMatch[1].toLowerCase();
        }
      }

      // Standard URL form. Prepend a scheme if missing so URL() can parse it.
      const withScheme = url.includes("://") ? url : `https://${url}`;
      return new URL(withScheme).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  /**
   * Detect provider from a clone/remote URL.
   *
   * Classification is based on the parsed HOSTNAME (not substring matching) to
   * avoid spoofing via crafted paths or hosts such as
   * "https://github.com.evil.com/...".
   */
  static detectFromUrl(url: string): VCSProvider {
    const host = ProviderDetector.extractHostname(url);

    // GitHub.com and GitHub Enterprise (e.g. github.enterprise.com).
    // The first-label check covers Enterprise hosts whose first label is
    // literally "github" (github.enterprise.com), while rejecting spoofs
    // like "github.com.evil.com" where "github.com" is used as a sub-label.
    if (
      host === "github.com" ||
      host.endsWith(".github.com") ||
      ProviderDetector.firstLabelIs(host, "github")
    ) {
      return "github";
    }

    // Bitbucket.org and Bitbucket Server/Data Center variants
    if (
      host === "bitbucket.org" ||
      host.endsWith(".bitbucket.org") ||
      ProviderDetector.firstLabelIs(host, "bitbucket")
    ) {
      return "bitbucket";
    }

    // Default to Bitbucket if unclear (backward compatibility)
    return "bitbucket";
  }

  /**
   * Returns true when the host's first DNS label equals `label` AND the host
   * is not a spoof where a public domain (e.g. "github.com") is embedded as a
   * sub-label (e.g. "github.com.evil.com"). The latter is detected by a second
   * label that is a common public TLD.
   */
  private static firstLabelIs(host: string, label: string): boolean {
    const labels = host.split(".");
    if (labels[0] !== label) {
      return false;
    }
    // Reject "<label>.<tld>.<...>" spoofs (e.g. github.com.evil.com).
    const tlds = new Set(["com", "org", "net", "io", "co", "dev"]);
    if (labels.length > 2 && tlds.has(labels[1])) {
      return false;
    }
    return true;
  }

  /**
   * Extract owner from GitHub URL or context
   * github.com:owner/repo.git → owner
   * https://github.com/owner/repo → owner
   */
  static extractGitHubOwner(url: string): string | null {
    try {
      // SSH format: git@github.com:owner/repo.git
      const sshMatch = url.match(/git@github\.com:([^/]+)\//);
      if (sshMatch) {
        return sshMatch[1];
      }

      // HTTPS format: https://github.com/owner/repo
      const httpsMatch = url.match(/github\.com\/([^/]+)\//);
      if (httpsMatch) {
        return httpsMatch[1];
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract repo name from GitHub URL
   * github.com:owner/repo.git → repo
   * https://github.com/owner/repo → repo
   */
  static extractGitHubRepo(url: string): string | null {
    try {
      // SSH format: git@github.com:owner/repo.git
      const sshMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
      if (sshMatch) {
        return sshMatch[1];
      }

      // HTTPS format: https://github.com/owner/repo
      const httpsMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        return httpsMatch[1];
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract workspace from Bitbucket URL
   * bitbucket.com:workspace/repo.git → workspace
   */
  static extractBitbucketWorkspace(url: string): string | null {
    try {
      // SSH format: git@bitbucket.org:workspace/repo.git
      const match = url.match(/bitbucket[^:]*:([^/]+)\//);
      if (match) {
        return match[1];
      }

      // HTTPS format: https://bitbucket.org/workspace/repo
      const httpsMatch = url.match(/bitbucket\.org\/([^/]+)\//);
      if (httpsMatch) {
        return httpsMatch[1];
      }

      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Helper to detect provider from ReviewRequest
 * Usage: const provider = detectProvider(request);
 */
export function detectProvider(
  request: ReviewRequest,
  configDefault?: VCSProvider,
): VCSProvider {
  return ProviderDetector.detect(request, process.env, configDefault);
}
