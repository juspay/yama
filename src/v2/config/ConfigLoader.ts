/**
 * Multi-Layer Configuration Loader for Yama
 * Loads and merges configuration from multiple sources
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { parse as parseYAML } from "yaml";
import { resolve } from "path";
import { YamaConfig, MemoryConfig } from "../types/config.types.js";
import { ConfigurationError } from "../types/v2.types.js";
import { DefaultConfig } from "./DefaultConfig.js";

export class ConfigLoader {
  private config: YamaConfig | null = null;
  private configPath: string | null = null;

  /**
   * Load configuration from file with multi-layer support
   */
  async loadConfig(
    configPath?: string,
    instanceOverrides?: Partial<YamaConfig>,
  ): Promise<YamaConfig> {
    console.log("📋 Loading Yama configuration...");

    // Layer 1: Start with default config
    let config = DefaultConfig.get();

    // Layer 2: Apply environment variable overrides
    // Lowest user-provided layer in SDK mode precedence.
    config = this.applyEnvironmentOverrides(config);

    // Layer 3: Load from file if provided or search for default locations
    const filePath = await this.resolveConfigPath(configPath);
    if (filePath) {
      console.log(`   Reading config from: ${filePath}`);
      const fileConfig = await this.loadConfigFile(filePath);
      config = this.mergeConfigs(config, fileConfig);
      this.configPath = filePath;
    } else {
      console.log("   Using default configuration (no config file found)");
    }

    config.memory = this.applyMemoryOverrides(config.memory);

    // Layer 4: Apply SDK instance overrides (highest priority)
    if (instanceOverrides) {
      config = this.mergeConfigs(config, instanceOverrides);
    }

    // Validate configuration
    this.validateConfig(config);

    this.config = config;
    console.log("✅ Configuration loaded successfully\n");

    return config;
  }

  /**
   * Get current loaded configuration
   */
  getConfig(): YamaConfig {
    if (!this.config) {
      throw new ConfigurationError(
        "Configuration not loaded. Call loadConfig() first.",
      );
    }
    return this.config;
  }

  /**
   * Validate configuration completeness and correctness
   */
  async validate(mode: "pr" | "local" = "pr"): Promise<void> {
    if (!this.config) {
      throw new ConfigurationError("No configuration to validate");
    }

    const errors: string[] = [];

    // Validate AI config
    if (!this.config.ai.provider) {
      errors.push("AI provider not configured");
    }

    if (!this.config.ai.model) {
      errors.push("AI model not configured");
    }

    // Local mode is SDK-first and does not require MCP credentials.
    if (mode === "pr") {
      // Check environment variables for Bitbucket (required in PR mode)
      if (!process.env.BITBUCKET_USERNAME) {
        errors.push("BITBUCKET_USERNAME environment variable not set");
      }
      if (!process.env.BITBUCKET_TOKEN) {
        errors.push("BITBUCKET_TOKEN environment variable not set");
      }
      if (!process.env.BITBUCKET_BASE_URL) {
        errors.push("BITBUCKET_BASE_URL environment variable not set");
      }

      if (this.config.mcpServers.jira.enabled) {
        if (!process.env.JIRA_EMAIL) {
          errors.push("JIRA_EMAIL environment variable not set");
        }
        if (!process.env.JIRA_API_TOKEN) {
          errors.push("JIRA_API_TOKEN environment variable not set");
        }
        if (!process.env.JIRA_BASE_URL) {
          errors.push("JIRA_BASE_URL environment variable not set");
        }
      }
    }

    if (errors.length > 0) {
      throw new ConfigurationError(
        `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
  }

  /**
   * Resolve configuration file path
   */
  private async resolveConfigPath(configPath?: string): Promise<string | null> {
    // If explicit path provided, use it
    if (configPath) {
      const resolvedPath = resolve(configPath);
      if (!existsSync(resolvedPath)) {
        throw new ConfigurationError(
          `Configuration file not found: ${resolvedPath}`,
        );
      }
      return resolvedPath;
    }

    // Search for default config files
    const defaultPaths = [
      "yama.config.yaml",
      "config/yama.config.yaml",
      ".yama/config.yaml",
    ];

    for (const path of defaultPaths) {
      const resolvedPath = resolve(path);
      if (existsSync(resolvedPath)) {
        return resolvedPath;
      }
    }

    return null;
  }

  /**
   * Load configuration from YAML file
   */
  private async loadConfigFile(filePath: string): Promise<Partial<YamaConfig>> {
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = parseYAML(content);
      return parsed as Partial<YamaConfig>;
    } catch (error) {
      throw new ConfigurationError(
        `Failed to load config file: ${(error as Error).message}`,
        { filePath },
      );
    }
  }

  /**
   * Deep merge two configuration objects
   */
  private mergeConfigs(
    base: YamaConfig,
    override: Partial<YamaConfig>,
  ): YamaConfig {
    return this.deepMerge(base, override) as YamaConfig;
  }

  /**
   * Deep merge utility
   */
  private deepMerge(target: any, source: any): any {
    const output = { ...target };

    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach((key) => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }

    return output;
  }

  /**
   * Check if value is an object
   */
  private isObject(item: any): boolean {
    return item && typeof item === "object" && !Array.isArray(item);
  }

  /**
   * Apply environment variable overrides
   */
  private applyEnvironmentOverrides(config: YamaConfig): YamaConfig {
    // Override AI provider if env var set
    if (process.env.AI_PROVIDER) {
      config.ai.provider = process.env.AI_PROVIDER as any;
    }

    // Override AI model if env var set
    if (process.env.AI_MODEL) {
      config.ai.model = process.env.AI_MODEL;
    }

    // Override temperature if env var set
    if (process.env.AI_TEMPERATURE) {
      config.ai.temperature = parseFloat(process.env.AI_TEMPERATURE);
    }

    // Override max tokens if env var set
    if (process.env.AI_MAX_TOKENS) {
      config.ai.maxTokens = parseInt(process.env.AI_MAX_TOKENS, 10);
    }

    if (process.env.AI_ENABLE_TOOL_FILTERING) {
      config.ai.enableToolFiltering =
        process.env.AI_ENABLE_TOOL_FILTERING === "true";
    }

    if (process.env.AI_TOOL_FILTERING_MODE) {
      const mode = process.env.AI_TOOL_FILTERING_MODE;
      if (mode === "off" || mode === "log-only" || mode === "active") {
        config.ai.toolFilteringMode = mode;
      }
    }

    return config;
  }

  /**
   * Apply memory-related environment variable overrides.
   *
   * Env vars (YAMA_MEMORY_*) take precedence over yaml config.
   * If YAMA_MEMORY_ENABLED is set but no memory config exists in yaml,
   * a default config is created so the other overrides have a target.
   *
   * Supported env vars:
   *   YAMA_MEMORY_ENABLED       — "true" / "false"
   *   YAMA_MEMORY_STORAGE_PATH  — e.g. "memory-bank/yama/memory"
   *   YAMA_MEMORY_MAX_WORDS     — e.g. "200"
   *   YAMA_MEMORY_AUTO_COMMIT   — "true" / "false"
   *   YAMA_MEMORY_PROMPT        — custom condensation prompt
   */
  private applyMemoryOverrides(memory: MemoryConfig): MemoryConfig {
    const env = process.env;

    if (env.YAMA_MEMORY_ENABLED) {
      memory.enabled = env.YAMA_MEMORY_ENABLED === "true";
    }
    if (env.YAMA_MEMORY_STORAGE_PATH) {
      memory.storagePath = env.YAMA_MEMORY_STORAGE_PATH;
    }
    if (env.YAMA_MEMORY_MAX_WORDS) {
      memory.maxWords = parseInt(env.YAMA_MEMORY_MAX_WORDS, 10);
    }
    if (env.YAMA_MEMORY_AUTO_COMMIT) {
      memory.autoCommit = env.YAMA_MEMORY_AUTO_COMMIT === "true";
    }
    if (env.YAMA_MEMORY_PROMPT) {
      memory.prompt = env.YAMA_MEMORY_PROMPT;
    }

    return memory;
  }

  /**
   * Basic configuration validation
   */
  private validateConfig(config: YamaConfig): void {
    if (!config.version) {
      throw new ConfigurationError("Configuration version not specified");
    }

    if (config.version !== 2) {
      throw new ConfigurationError(
        `Invalid configuration version: ${config.version}. Expected version 2.`,
      );
    }

    if (!config.ai) {
      throw new ConfigurationError("AI configuration missing");
    }

    if (!config.mcpServers) {
      throw new ConfigurationError("MCP servers configuration missing");
    }

    if (!config.review) {
      throw new ConfigurationError("Review configuration missing");
    }
  }
}
