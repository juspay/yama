/**
 * Yama - Main package exports
 * Provides both programmatic API and CLI access
 */

// Core classes
export { Guardian, createGuardian, guardian } from "./core/Guardian";
export { ContextGatherer, createContextGatherer } from "./core/ContextGatherer";
export type {
  UnifiedContext,
  ProjectContext,
  DiffStrategy,
} from "./core/ContextGatherer";

// Providers
export {
  BitbucketProvider,
  createBitbucketProvider,
} from "./core/providers/BitbucketProvider";

// Features
export { CodeReviewer, createCodeReviewer } from "./features/CodeReviewer";
export {
  DescriptionEnhancer,
  createDescriptionEnhancer,
} from "./features/DescriptionEnhancer";

// Utilities
export { Logger, createLogger, logger } from "./utils/Logger";
export { Cache, createCache, cache } from "./utils/Cache";
export {
  ConfigManager,
  createConfigManager,
  configManager,
} from "./utils/ConfigManager";

// Types
export * from "./types";

// CLI
export { main as cli } from "./cli/index";

// Note: Use named import { Guardian } from '@juspay/yama' instead
