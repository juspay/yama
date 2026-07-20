/**
 * NeuroLinkFactory — single place that constructs a configured NeuroLink.
 *
 * Consolidates the three previously-duplicated `initializeNeurolink()` methods
 * (orchestrator, learning orchestrator, context explorer) so observability,
 * conversation memory, per-repo memory, and the instance-level tool-safety
 * policy are wired identically everywhere.
 */

import { NeuroLink } from "@juspay/neurolink";
import { NeuroLinkFactoryOptions } from "../types/index.js";
import {
  buildObservabilityConfigFromEnv,
  validateObservabilityConfig,
} from "../utils/ObservabilityConfig.js";

export class NeuroLinkFactory {
  /**
   * Build a NeuroLink instance from the given options. Observability is derived
   * from the environment and validated (throws on a present-but-invalid config,
   * matching the review/explore paths — a malformed observability setup should
   * fail loudly rather than silently drop tracing).
   */
  static create(options: NeuroLinkFactoryOptions = {}): NeuroLink {
    const neurolinkConfig: Record<string, unknown> = {};

    if (options.conversationMemory === false) {
      neurolinkConfig.conversationMemory = { enabled: false };
    } else if (options.conversationMemory) {
      const conversationMemory: Record<string, unknown> = {
        ...options.conversationMemory,
      };
      if (options.memoryManager) {
        conversationMemory.memory =
          options.memoryManager.buildNeuroLinkMemoryConfig();
      }
      neurolinkConfig.conversationMemory = conversationMemory;
    }

    if (options.excludeTools && options.excludeTools.length > 0) {
      neurolinkConfig.tools = { exclude: [...options.excludeTools] };
    }

    if (options.mcpOutputLimits) {
      neurolinkConfig.mcp = { outputLimits: { ...options.mcpOutputLimits } };
    }

    const observabilityConfig = buildObservabilityConfigFromEnv();
    if (observabilityConfig) {
      if (!validateObservabilityConfig(observabilityConfig)) {
        throw new Error("Invalid observability configuration");
      }
      neurolinkConfig.observability = observabilityConfig;
    }

    return new NeuroLink(neurolinkConfig);
  }
}
