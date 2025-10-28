/**
 * NeuroLink Factory
 * Centralized factory for creating NeuroLink instances with observability configuration
 */

import type { NeuroLink } from "@juspay/neurolink";
import { logger } from "./Logger.js";

/**
 * Initialize NeuroLink with observability configuration from environment
 * Provides graceful fallback if observability initialization fails
 *
 * @returns NeuroLink instance with observability config if available
 */
export async function initializeNeuroLink(): Promise<NeuroLink> {
  try {
    const { NeuroLink, buildObservabilityConfigFromEnv } = await import(
      "@juspay/neurolink"
    );

    const observabilityConfig = buildObservabilityConfigFromEnv();

    if (observabilityConfig) {
      logger.debug("Initializing NeuroLink with observability config");
      return new NeuroLink({ observability: observabilityConfig });
    } else {
      logger.debug("Initializing NeuroLink without observability config");
      return new NeuroLink();
    }
  } catch (error) {
    logger.warn(
      `Failed to initialize observability config: ${(error as Error).message}`
    );
    const { NeuroLink } = await import("@juspay/neurolink");
    return new NeuroLink();
  }
}
