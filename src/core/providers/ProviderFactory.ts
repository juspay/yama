/**
 * Provider Factory
 * Centralized factory for creating git platform providers
 */

import { GitProviderConfig, GitPlatform, ProviderError } from "../../types/index.js";
import { GitProvider } from "./GitProvider.js";
import { BitbucketProvider } from "./BitbucketProvider.js";
import { GitHubProvider } from "./GitHubProvider.js";
import { logger } from "../../utils/Logger.js";

/**
 * Create a git provider instance based on the platform configuration
 */
export function createGitProvider(config: GitProviderConfig): GitProvider {
  const { platform, credentials } = config;

  logger.debug(`Creating git provider for platform: ${platform}`);

  switch (platform) {
    case "bitbucket":
      return new BitbucketProvider(credentials);

    case "github":
      return new GitHubProvider(credentials, {
        mcpServerUrl: "http://localhost:3000",
        timeout: 30000,
        retries: 3,
        dockerImage: "ghcr.io/github/github-mcp-server:latest",
      });

    case "gitlab":
    case "azure-devops":
      throw new ProviderError(
        `Platform '${platform}' not yet supported. Supported: bitbucket, github`
      );

    default:
      throw new ProviderError(
        `Unsupported git platform: ${platform}. Supported platforms: bitbucket, github`
      );
  }
}

/**
 * Get list of supported platforms
 */
export function getSupportedPlatforms(): GitPlatform[] {
  return ["bitbucket", "github"];
}

/**
 * Get list of all platforms (including planned ones)  
 */
export function getAllPlatforms(): GitPlatform[] {
  return ["bitbucket", "github"];
}

/**
 * Check if a platform is supported
 */
export function isPlatformSupported(platform: GitPlatform): boolean {
  return getSupportedPlatforms().includes(platform);
}

/**
 * Get platform-specific configuration requirements
 */
export function getPlatformRequirements(platform: GitPlatform): {
  requiredCredentials: string[];
  optionalCredentials: string[];
  defaultBaseUrl?: string;
  documentation?: string;
} {
  switch (platform) {
    case "bitbucket":
      return {
        requiredCredentials: ["username", "token"],
        optionalCredentials: ["baseUrl"],
        defaultBaseUrl: "https://your-bitbucket-server.com",
        documentation: "Requires Bitbucket Personal Access Token with repository access",
      };

    case "github":
      return {
        requiredCredentials: ["token"],
        optionalCredentials: ["username", "baseUrl"],
        defaultBaseUrl: "https://api.github.com",
        documentation: "Requires GitHub Personal Access Token or GitHub App token with repository access",
      };

    case "gitlab":
    case "azure-devops":
      throw new ProviderError(`Platform '${platform}' not yet supported`);

    default:
      throw new ProviderError(`Unknown platform: ${platform}`);
  }
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(config: GitProviderConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if platform is supported
  if (!isPlatformSupported(config.platform)) {
    if (getAllPlatforms().includes(config.platform)) {
      errors.push(`Platform '${config.platform}' is not yet implemented`);
    } else {
      errors.push(`Unknown platform '${config.platform}'`);
    }
    return { valid: false, errors, warnings };
  }

  const requirements = getPlatformRequirements(config.platform);

  // Check required credentials
  for (const required of requirements.requiredCredentials) {
    if (!config.credentials[required as keyof typeof config.credentials]) {
      errors.push(`Missing required credential: ${required}`);
    }
  }

  // Check for empty values in required credentials
  for (const required of requirements.requiredCredentials) {
    const value = config.credentials[required as keyof typeof config.credentials];
    if (value === "" || value === undefined || value === null) {
      errors.push(`Empty value for required credential: ${required}`);
    }
  }

  // Platform-specific validations
  switch (config.platform) {
    case "github":
      // GitHub token validation
      if (config.credentials.token && !config.credentials.token.startsWith("ghp_") && 
          !config.credentials.token.startsWith("github_pat_") && 
          !config.credentials.token.startsWith("ghs_") &&
          config.credentials.token.length < 40) {
        warnings.push("GitHub token format may be invalid. Expected format: ghp_*, github_pat_*, or ghs_*");
      }
      
      // GitHub Enterprise URL validation
      if (config.credentials.baseUrl && 
          config.credentials.baseUrl !== "https://api.github.com" &&
          !config.credentials.baseUrl.includes("/api/")) {
        warnings.push("GitHub Enterprise base URL should include '/api/v3' path");
      }
      break;

    case "bitbucket":
      // Bitbucket token validation
      if (config.credentials.token && config.credentials.token.length < 20) {
        warnings.push("Bitbucket token appears to be too short");
      }
      
      // Bitbucket Server URL validation
      if (config.credentials.baseUrl && 
          config.credentials.baseUrl.includes("bitbucket.org")) {
        warnings.push("For Bitbucket Cloud, use the Bitbucket Cloud API endpoints");
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get example configuration for a platform
 */
export function getExampleConfig(platform: GitPlatform): Partial<GitProviderConfig> {
  const requirements = getPlatformRequirements(platform);
  
  const baseConfig: Partial<GitProviderConfig> = {
    platform,
    credentials: {
      username: "${GIT_USERNAME}",
      token: "${GIT_TOKEN}",
      baseUrl: requirements.defaultBaseUrl,
    },
  };

  switch (platform) {
    case "github":
      return {
        ...baseConfig,
        credentials: {
          username: "${GITHUB_USERNAME}", // Optional for GitHub
          token: "${GITHUB_TOKEN}",
          baseUrl: "${GITHUB_BASE_URL}", // Optional, defaults to https://api.github.com
        },
      };

    case "bitbucket":
      return {
        ...baseConfig,
        credentials: {
          username: "${BITBUCKET_USERNAME}",
          token: "${BITBUCKET_TOKEN}",
          baseUrl: "${BITBUCKET_BASE_URL}",
        },
      };

    case "gitlab":
    case "azure-devops":
      throw new ProviderError(`Platform '${platform}' not yet supported`);

    default:
      return baseConfig;
  }
}

