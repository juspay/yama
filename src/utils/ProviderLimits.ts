/**
 * Provider Token Limits Utility
 * Centralized management of AI provider token limits and validation
 */

import { logger } from "./Logger.js";

/**
 * AI Provider types supported by the system
 */
export type AIProvider = 
  | 'vertex' 
  | 'google-ai' 
  | 'gemini' 
  | 'openai' 
  | 'gpt-4' 
  | 'anthropic' 
  | 'claude' 
  | 'azure' 
  | 'bedrock' 
  | 'auto';

/**
 * Provider token limits configuration
 * These limits are conservative values to avoid API errors
 */
export const PROVIDER_TOKEN_LIMITS: Record<AIProvider, number> = {
  // Google/Vertex AI providers
  'vertex': 65536,     // Vertex AI limit is 65537 exclusive = 65536 max
  'google-ai': 65536,  // Google AI Studio limit
  'gemini': 65536,     // Gemini model limit

  // OpenAI providers
  'openai': 128000,    // OpenAI GPT-4 and newer models
  'gpt-4': 128000,     // GPT-4 specific limit

  // Anthropic providers
  'anthropic': 200000, // Claude models limit
  'claude': 200000,    // Claude specific limit

  // Microsoft Azure
  'azure': 128000,     // Azure OpenAI limit

  // AWS Bedrock
  'bedrock': 100000,   // AWS Bedrock limit

  // Auto-selection mode (conservative default)
  'auto': 60000,       // Conservative default for auto-selection
};

/**
 * Conservative limits used by CodeReviewer for safety
 * These are slightly lower than the actual limits to provide buffer
 */
export const CONSERVATIVE_PROVIDER_LIMITS: Record<AIProvider, number> = {
  'vertex': 65536,
  'google-ai': 65536,
  'gemini': 65536,
  'openai': 120000,    // Slightly lower for safety
  'gpt-4': 120000,
  'anthropic': 190000, // Slightly lower for safety
  'claude': 190000,
  'azure': 120000,
  'bedrock': 95000,    // Significantly lower for safety
  'auto': 60000,
};

/**
 * Get the token limit for a specific provider
 * @param provider - The AI provider name
 * @param conservative - Whether to use conservative limits (default: false)
 * @returns The token limit for the provider
 */
export function getProviderTokenLimit(
  provider: string, 
  conservative: boolean = false
): number {
  // Handle null, undefined, or empty string
  if (!provider || typeof provider !== 'string') {
    return conservative ? CONSERVATIVE_PROVIDER_LIMITS.auto : PROVIDER_TOKEN_LIMITS.auto;
  }
  
  const normalizedProvider = provider.toLowerCase();
  const limits = conservative ? CONSERVATIVE_PROVIDER_LIMITS : PROVIDER_TOKEN_LIMITS;
  
  // Handle empty string after normalization
  if (normalizedProvider === '') {
    return conservative ? CONSERVATIVE_PROVIDER_LIMITS.auto : PROVIDER_TOKEN_LIMITS.auto;
  }
  
  // Direct match
  if (normalizedProvider in limits) {
    return limits[normalizedProvider as AIProvider];
  }
  
  // Partial match - check if provider contains any known provider name
  for (const [key, limit] of Object.entries(limits)) {
    if (normalizedProvider.includes(key) || key.includes(normalizedProvider)) {
      return limit;
    }
  }
  
  // Default fallback
  return conservative ? CONSERVATIVE_PROVIDER_LIMITS.auto : PROVIDER_TOKEN_LIMITS.auto;
}

/**
 * Validate and adjust token limit for a provider
 * @param provider - The AI provider name
 * @param configuredTokens - The configured token limit
 * @param conservative - Whether to use conservative limits (default: false)
 * @returns The validated and potentially adjusted token limit
 */
export function validateProviderTokenLimit(
  provider: string,
  configuredTokens: number | undefined,
  conservative: boolean = false
): number {
  const providerLimit = getProviderTokenLimit(provider, conservative);
  
  if (!configuredTokens || configuredTokens <= 0) {
    logger.debug(`No configured tokens for ${provider}, using provider default: ${providerLimit}`);
    return providerLimit;
  }
  
  if (configuredTokens > providerLimit) {
    logger.warn(
      `Configured maxTokens (${configuredTokens}) exceeds ${provider} limit (${providerLimit}). Adjusting to ${providerLimit}.`
    );
    return providerLimit;
  }
  
  logger.debug(
    `Token limit validation passed: ${configuredTokens} <= ${providerLimit} for provider ${provider}`
  );
  return configuredTokens;
}

/**
 * Get all supported providers
 * @returns Array of supported provider names
 */
export function getSupportedProviders(): AIProvider[] {
  return Object.keys(PROVIDER_TOKEN_LIMITS) as AIProvider[];
}

/**
 * Check if a provider is supported
 * @param provider - The provider name to check
 * @returns True if the provider is supported
 */
export function isProviderSupported(provider: string): boolean {
  // Handle null, undefined, or empty string
  if (!provider || typeof provider !== 'string') {
    return false;
  }
  
  const normalizedProvider = provider.toLowerCase();
  
  // Handle empty string after normalization
  if (normalizedProvider === '') {
    return false;
  }
  
  // Check direct match
  if (normalizedProvider in PROVIDER_TOKEN_LIMITS) {
    return true;
  }
  
  // Check partial match
  for (const key of Object.keys(PROVIDER_TOKEN_LIMITS)) {
    if (normalizedProvider.includes(key) || key.includes(normalizedProvider)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get provider information including limits and support status
 * @param provider - The provider name
 * @param conservative - Whether to use conservative limits
 * @returns Provider information object
 */
export function getProviderInfo(provider: string, conservative: boolean = false) {
  return {
    provider,
    isSupported: isProviderSupported(provider),
    tokenLimit: getProviderTokenLimit(provider, conservative),
    conservativeLimit: getProviderTokenLimit(provider, true),
    standardLimit: getProviderTokenLimit(provider, false),
  };
}
