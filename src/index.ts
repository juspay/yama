/**
 * Yama - Main package exports
 * Provides both programmatic API and CLI access
 */

// Core classes
export { Guardian, createGuardian, guardian } from "./core/Guardian.js";
export { ContextGatherer, createContextGatherer } from "./core/ContextGatherer.js";
export type {
  UnifiedContext,
  ProjectContext,
  DiffStrategy,
} from "./core/ContextGatherer.js";

// Providers
export {
  BitbucketProvider,
  createBitbucketProvider,
} from "./core/providers/BitbucketProvider.js";

// Features
export { CodeReviewer, createCodeReviewer } from "./features/CodeReviewer.js";
export {
  DescriptionEnhancer,
  createDescriptionEnhancer,
} from "./features/DescriptionEnhancer.js";

// Utilities
export { Logger, createLogger, logger } from "./utils/Logger.js";
export { Cache, createCache, cache } from "./utils/Cache.js";
export {
  ConfigManager,
  createConfigManager,
  configManager,
} from "./utils/ConfigManager.js";

// Types
export * from "./types/index.js";

// CLI
export { main as cli } from "./cli/index.js";

// Note: Use named import { Guardian } from '@juspay/yama' instead
