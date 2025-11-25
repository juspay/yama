/**
 * Observability Configuration Builder
 * Builds NeuroLink observability config from environment variables
 */

export interface ObservabilityConfig {
  langfuse?: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    enabled: boolean;
  };
}

/**
 * Build observability config from environment variables
 * Returns null if observability is not configured
 */
export function buildObservabilityConfigFromEnv(): ObservabilityConfig | null {
  const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY;
  const langfuseBaseUrl = process.env.LANGFUSE_BASE_URL;
  const langfuseEnabled = process.env.LANGFUSE_ENABLED !== "false"; // Default to true if keys present

  // Check if Langfuse is configured
  if (langfusePublicKey && langfuseSecretKey) {
    return {
      langfuse: {
        publicKey: langfusePublicKey,
        secretKey: langfuseSecretKey,
        baseUrl: langfuseBaseUrl || "https://cloud.langfuse.com",
        enabled: langfuseEnabled,
      },
    };
  }

  // No observability configured
  return null;
}

/**
 * Validate observability configuration
 */
export function validateObservabilityConfig(
  config: ObservabilityConfig | null,
): boolean {
  if (!config) {
    return true; // No config is valid (observability is optional)
  }

  if (config.langfuse) {
    const { publicKey, secretKey, baseUrl } = config.langfuse;

    if (!publicKey || !secretKey) {
      console.error(
        "❌ Langfuse observability config invalid: missing publicKey or secretKey",
      );
      return false;
    }

    if (baseUrl && !baseUrl.startsWith("http")) {
      console.error(
        "❌ Langfuse observability config invalid: baseUrl must start with http/https",
      );
      return false;
    }
  }

  return true;
}
