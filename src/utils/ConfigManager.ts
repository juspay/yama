/**
 * Enhanced Configuration Manager for Yama
 * Handles configuration loading, validation, and merging from multiple sources
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { GuardianConfig, ConfigurationError } from '../types';
import { logger } from './Logger';

export class ConfigManager {
  private config: GuardianConfig | null = null;
  private configPaths: string[] = [];

  /**
   * Default configuration
   */
  private static readonly DEFAULT_CONFIG: GuardianConfig = {
    providers: {
      ai: {
        provider: 'auto',
        enableFallback: true,
        enableAnalytics: true,
        enableEvaluation: true,
        timeout: '5m',
        retryAttempts: 3,
        temperature: 0.7,
        maxTokens: 1000000
      },
      git: {
        platform: 'bitbucket',
        credentials: {
          username: process.env.BITBUCKET_USERNAME || '',
          token: process.env.BITBUCKET_TOKEN || '',
          baseUrl: process.env.BITBUCKET_BASE_URL || 'https://your-bitbucket-server.com'
        }
      }
    },
    features: {
      codeReview: {
        enabled: true,
        severityLevels: ['CRITICAL', 'MAJOR', 'MINOR', 'SUGGESTION'],
        categories: ['security', 'performance', 'maintainability', 'functionality', 'error_handling', 'testing'],
        excludePatterns: ['*.lock', '*.svg', '*.min.js', '*.map'],
        contextLines: 3
      },
      descriptionEnhancement: {
        enabled: true,
        preserveContent: true,
        requiredSections: [
          { key: 'changelog', name: 'Changelog (Modules Modified)', required: true },
          { key: 'testcases', name: 'Test Cases (What to be tested)', required: true },
          { key: 'config_changes', name: 'CAC Config Or Service Config Changes', required: true }
        ],
        autoFormat: true
      },
      securityScan: {
        enabled: true,
        level: 'strict',
        scanTypes: ['secrets', 'vulnerabilities', 'dependencies']
      },
      analytics: {
        enabled: true,
        trackMetrics: true,
        exportFormat: 'json'
      }
    },
    cache: {
      enabled: true,
      ttl: '1h',
      maxSize: '100MB',
      storage: 'memory'
    },
    performance: {
      batch: {
        enabled: true,
        maxConcurrent: 5,
        delayBetween: '1s'
      },
      optimization: {
        reuseConnections: true,
        compressRequests: true,
        enableHttp2: true
      }
    },
    rules: {
      security: [
        {
          name: 'No hardcoded secrets',
          pattern: '(password|secret|key|token)\\s*[=:]\\s*[\'"][^\'"]{8,}[\'"]',
          severity: 'CRITICAL',
          message: 'Hardcoded secrets detected',
          suggestion: 'Use environment variables or secure configuration management'
        }
      ],
      performance: [
        {
          name: 'Avoid N+1 queries',
          pattern: 'for.*\\.(find|get|query|select)',
          severity: 'MAJOR',
          message: 'Potential N+1 query pattern detected',
          suggestion: 'Consider using batch queries or joins'
        }
      ]
    },
    reporting: {
      formats: ['markdown', 'json'],
      includeAnalytics: true,
      includeMetrics: true
    }
  };

  constructor() {
    this.setupConfigPaths();
  }

  /**
   * Setup configuration file search paths
   */
  private setupConfigPaths(): void {
    const cwd = process.cwd();
    const homeDir = require('os').homedir();

    this.configPaths = [
      // Current directory
      path.join(cwd, 'yama.config.yaml'),
      path.join(cwd, 'yama.config.yml'),
      path.join(cwd, 'yama.config.json'),
      path.join(cwd, '.yama.yaml'),
      path.join(cwd, '.yama.yml'),
      path.join(cwd, '.yama.json'),
      
      // Home directory
      path.join(homeDir, '.yama', 'config.yaml'),
      path.join(homeDir, '.yama', 'config.yml'),
      path.join(homeDir, '.yama', 'config.json'),
      
      // XDG config directory
      path.join(homeDir, '.config', 'yama', 'config.yaml'),
      path.join(homeDir, '.config', 'yama', 'config.yml'),
      path.join(homeDir, '.config', 'yama', 'config.json')
    ];
  }

  /**
   * Load configuration from files and environment
   */
  async loadConfig(configPath?: string): Promise<GuardianConfig> {
    if (this.config) {
      return this.config;
    }

    logger.debug('Loading Yama configuration...');

    // Start with default config
    let config = this.deepClone(ConfigManager.DEFAULT_CONFIG);

    // If specific config path provided, use only that
    if (configPath) {
      if (!fs.existsSync(configPath)) {
        throw new ConfigurationError(`Configuration file not found: ${configPath}`);
      }
      const fileConfig = await this.loadConfigFile(configPath);
      config = this.mergeConfigs(config, fileConfig);
      logger.debug(`Loaded configuration from: ${configPath}`);
    } else {
      // Search for config files in predefined paths
      for (const configFilePath of this.configPaths) {
        if (fs.existsSync(configFilePath)) {
          try {
            const fileConfig = await this.loadConfigFile(configFilePath);
            config = this.mergeConfigs(config, fileConfig);
            logger.debug(`Loaded configuration from: ${configFilePath}`);
            break;
          } catch (error) {
            logger.warn(`Failed to load config from ${configFilePath}:`, error);
          }
        }
      }
    }

    // Override with environment variables
    config = this.applyEnvironmentOverrides(config);

    // Validate configuration
    this.validateConfig(config);

    this.config = config;
    logger.debug('Configuration loaded successfully');
    
    return config;
  }

  /**
   * Load configuration from a specific file
   */
  private async loadConfigFile(filePath: string): Promise<Partial<GuardianConfig>> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();

      switch (ext) {
        case '.yaml':
        case '.yml':
          return yaml.parse(content);
        case '.json':
          return JSON.parse(content);
        default:
          throw new ConfigurationError(`Unsupported config file format: ${ext}`);
      }
    } catch (error) {
      throw new ConfigurationError(
        `Failed to parse config file ${filePath}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Apply environment variable overrides
   */
  private applyEnvironmentOverrides(config: GuardianConfig): GuardianConfig {
    const env = process.env;

    // AI Provider overrides
    if (env.AI_PROVIDER) {
      config.providers.ai.provider = env.AI_PROVIDER as any;
    }
    if (env.AI_MODEL) {
      config.providers.ai.model = env.AI_MODEL;
    }
    if (env.AI_TIMEOUT) {
      config.providers.ai.timeout = env.AI_TIMEOUT;
    }
    if (env.AI_TEMPERATURE) {
      config.providers.ai.temperature = parseFloat(env.AI_TEMPERATURE);
    }
    if (env.AI_MAX_TOKENS) {
      config.providers.ai.maxTokens = parseInt(env.AI_MAX_TOKENS);
    }

    // Git Provider overrides
    if (env.BITBUCKET_USERNAME) {
      config.providers.git.credentials.username = env.BITBUCKET_USERNAME;
    }
    if (env.BITBUCKET_TOKEN) {
      config.providers.git.credentials.token = env.BITBUCKET_TOKEN;
    }
    if (env.BITBUCKET_BASE_URL) {
      config.providers.git.credentials.baseUrl = env.BITBUCKET_BASE_URL;
    }

    // Feature toggles
    if (env.ENABLE_CODE_REVIEW !== undefined) {
      config.features.codeReview.enabled = env.ENABLE_CODE_REVIEW === 'true';
    }
    if (env.ENABLE_DESCRIPTION_ENHANCEMENT !== undefined) {
      config.features.descriptionEnhancement.enabled = env.ENABLE_DESCRIPTION_ENHANCEMENT === 'true';
    }
    if (env.ENABLE_SECURITY_SCAN !== undefined) {
      config.features.securityScan!.enabled = env.ENABLE_SECURITY_SCAN === 'true';
    }
    if (env.ENABLE_ANALYTICS !== undefined) {
      config.features.analytics!.enabled = env.ENABLE_ANALYTICS === 'true';
    }

    // Cache configuration
    if (env.CACHE_ENABLED !== undefined) {
      config.cache!.enabled = env.CACHE_ENABLED === 'true';
    }
    if (env.CACHE_TTL) {
      config.cache!.ttl = env.CACHE_TTL;
    }
    if (env.CACHE_STORAGE) {
      config.cache!.storage = env.CACHE_STORAGE as any;
    }

    // Debug mode
    if (env.GUARDIAN_DEBUG === 'true') {
      logger.setLevel('debug');
      logger.setVerbose(true);
    }

    logger.debug('Applied environment variable overrides');
    return config;
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: GuardianConfig): void {
    const errors: string[] = [];

    // Validate AI provider credentials
    if (!config.providers.ai.provider) {
      errors.push('AI provider must be specified');
    }

    // Validate Git provider credentials
    if (!config.providers.git.credentials.username) {
      errors.push('Git username must be specified');
    }
    if (!config.providers.git.credentials.token) {
      errors.push('Git token must be specified');
    }

    // Validate enabled features have required configuration
    if (config.features.codeReview.enabled) {
      if (!config.features.codeReview.severityLevels?.length) {
        errors.push('Code review severity levels must be specified when enabled');
      }
    }

    if (config.features.descriptionEnhancement.enabled) {
      if (!config.features.descriptionEnhancement.requiredSections?.length) {
        errors.push('Description enhancement required sections must be specified when enabled');
      }
    }

    // Validate cache configuration
    if (config.cache?.enabled) {
      if (!config.cache.storage) {
        errors.push('Cache storage type must be specified when cache is enabled');
      }
    }

    if (errors.length > 0) {
      throw new ConfigurationError(
        `Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`
      );
    }

    logger.debug('Configuration validation passed');
  }

  /**
   * Merge two configuration objects deeply
   */
  private mergeConfigs(base: GuardianConfig, override: Partial<GuardianConfig>): GuardianConfig {
    return this.deepMerge(base, override) as GuardianConfig;
  }

  /**
   * Deep merge utility
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };

    for (const key in source) {
      if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Deep clone utility
   */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Get current configuration
   */
  getConfig(): GuardianConfig {
    if (!this.config) {
      throw new ConfigurationError('Configuration not loaded. Call loadConfig() first.');
    }
    return this.config;
  }

  /**
   * Create default configuration file
   */
  async createDefaultConfig(outputPath?: string): Promise<string> {
    const defaultPath = outputPath || path.join(process.cwd(), 'yama.config.yaml');
    const configContent = yaml.stringify(ConfigManager.DEFAULT_CONFIG, {
      indent: 2,
      lineWidth: 100
    });

    // Add comments to make the config file more user-friendly
    const commentedConfig = this.addConfigComments(configContent);

    fs.writeFileSync(defaultPath, commentedConfig, 'utf8');
    logger.info(`Default configuration created at: ${defaultPath}`);
    
    return defaultPath;
  }

  /**
   * Add helpful comments to configuration file
   */
  private addConfigComments(content: string): string {
    const header = `# Yama Configuration
# This file configures all aspects of Yama behavior
# For more information, visit: https://github.com/juspay/yama

`;

    const sections = [
      '# AI Provider Configuration',
      '# Git Platform Configuration', 
      '# Feature Configuration',
      '# Cache Configuration',
      '# Performance Configuration',
      '# Custom Rules Configuration',
      '# Reporting Configuration'
    ];

    let commented = header + content;
    
    // Add section comments (this is a simplified approach)
    sections.forEach(section => {
      const key = section.split(' ')[1].toLowerCase();
      commented = commented.replace(
        new RegExp(`^(${key}:)`, 'm'),
        `${section}\n$1`
      );
    });

    return commented;
  }

  /**
   * Validate specific configuration section
   */
  validateSection(section: keyof GuardianConfig, config: any): boolean {
    try {
      switch (section) {
        case 'providers':
          return this.validateProviders(config);
        case 'features':
          return this.validateFeatures(config);
        case 'cache':
          return this.validateCache(config);
        default:
          return true;
      }
    } catch (error) {
      logger.error(`Validation failed for section ${section}:`, error);
      return false;
    }
  }

  private validateProviders(providers: any): boolean {
    return !!(providers?.ai?.provider && providers?.git?.credentials?.username && providers?.git?.credentials?.token);
  }

  private validateFeatures(features: any): boolean {
    return !!(features && typeof features === 'object');
  }

  private validateCache(cacheConfig: any): boolean {
    if (!cacheConfig?.enabled) return true;
    return !!(cacheConfig.storage && cacheConfig.ttl);
  }

  /**
   * Get configuration schema for validation
   */
  getSchema(): any {
    return {
      type: 'object',
      required: ['providers', 'features'],
      properties: {
        providers: {
          type: 'object',
          required: ['ai', 'git'],
          properties: {
            ai: {
              type: 'object',
              required: ['provider'],
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                enableFallback: { type: 'boolean' },
                enableAnalytics: { type: 'boolean' },
                timeout: { type: ['string', 'number'] },
                temperature: { type: 'number', minimum: 0, maximum: 2 },
                maxTokens: { type: 'number', minimum: 1 }
              }
            },
            git: {
              type: 'object',
              required: ['platform', 'credentials'],
              properties: {
                platform: { type: 'string', enum: ['bitbucket', 'github', 'gitlab', 'azure-devops'] },
                credentials: {
                  type: 'object',
                  required: ['username', 'token'],
                  properties: {
                    username: { type: 'string' },
                    token: { type: 'string' },
                    baseUrl: { type: 'string' }
                  }
                }
              }
            }
          }
        },
        features: {
          type: 'object',
          required: ['codeReview', 'descriptionEnhancement'],
          properties: {
            codeReview: {
              type: 'object',
              required: ['enabled'],
              properties: {
                enabled: { type: 'boolean' },
                severityLevels: { type: 'array', items: { type: 'string' } },
                categories: { type: 'array', items: { type: 'string' } },
                excludePatterns: { type: 'array', items: { type: 'string' } }
              }
            },
            descriptionEnhancement: {
              type: 'object',
              required: ['enabled'],
              properties: {
                enabled: { type: 'boolean' },
                preserveContent: { type: 'boolean' },
                requiredSections: { type: 'array' },
                autoFormat: { type: 'boolean' }
              }
            }
          }
        }
      }
    };
  }
}

// Export singleton instance
export const configManager = new ConfigManager();

// Export factory function
export function createConfigManager(): ConfigManager {
  return new ConfigManager();
}