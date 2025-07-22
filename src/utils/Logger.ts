/**
 * Enhanced Logger utility - Optimized from both pr-police.js and pr-describe.js
 * Provides consistent logging across all Guardian operations
 */

import chalk from 'chalk';
import { Logger as ILogger, LogLevel, LoggerOptions } from '../types';

const GUARDIAN_BADGE = `
🛡️ ═══════════════════════════════════════ 🛡️
   ██████╗ ██████╗      ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗ ██╗ █████╗ ███╗   ██╗
   ██╔══██╗██╔══██╗    ██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗██║██╔══██╗████╗  ██║
   ██████╔╝██████╔╝    ██║  ███╗██║   ██║███████║██████╔╝██║  ██║██║███████║██╔██╗ ██║
   ██╔═══╝ ██╔══██╗    ██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║██║██╔══██║██║╚██╗██║
   ██║     ██║  ██║    ╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝██║██║  ██║██║ ╚████║
   ╚═╝     ╚═╝  ╚═╝     ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝
🛡️ ═══════════════════════════════════════ 🛡️
   AI-Powered PR Automation • Enterprise Security • Code Quality Guardian
`;

export class Logger implements ILogger {
  private options: LoggerOptions;

  constructor(options: Partial<LoggerOptions> = {}) {
    this.options = {
      level: 'info',
      verbose: false,
      format: 'simple',
      colors: true,
      ...options
    };
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    return levels[level] >= levels[this.options.level];
  }

  private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ` ${args.map(a => 
      typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
    ).join(' ')}` : '';

    switch (this.options.format) {
      case 'json':
        return JSON.stringify({
          timestamp,
          level: level.toUpperCase(),
          message: message + formattedArgs,
          args: args.length > 0 ? args : undefined
        });
      
      case 'detailed':
        return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${formattedArgs}`;
      
      default: // simple
        return `${message}${formattedArgs}`;
    }
  }

  private colorize(level: LogLevel, text: string): string {
    if (!this.options.colors) return text;

    switch (level) {
      case 'debug':
        return chalk.gray(text);
      case 'info':
        return chalk.blue(text);
      case 'warn':
        return chalk.yellow(text);
      case 'error':
        return chalk.red(text);
      default:
        return text;
    }
  }

  debug(message: string, ...args: any[]): void {
    if (!this.shouldLog('debug') || !this.options.verbose) return;
    const formatted = this.formatMessage('debug', `🔍 ${message}`, ...args);
    console.log(this.colorize('debug', formatted));
  }

  info(message: string, ...args: any[]): void {
    if (!this.shouldLog('info')) return;
    const formatted = this.formatMessage('info', `ℹ️  ${message}`, ...args);
    console.log(this.colorize('info', formatted));
  }

  warn(message: string, ...args: any[]): void {
    if (!this.shouldLog('warn')) return;
    const formatted = this.formatMessage('warn', `⚠️  ${message}`, ...args);
    console.warn(this.colorize('warn', formatted));
  }

  error(message: string, ...args: any[]): void {
    if (!this.shouldLog('error')) return;
    const formatted = this.formatMessage('error', `❌ ${message}`, ...args);
    console.error(this.colorize('error', formatted));
  }

  // Special methods for Guardian operations
  badge(): void {
    console.log(chalk.cyan(GUARDIAN_BADGE));
  }

  phase(message: string): void {
    const formatted = `\n🔄 ${message}`;
    console.log(this.options.colors ? chalk.magenta(formatted) : formatted);
  }

  success(message: string): void {
    const formatted = `✅ ${message}`;
    console.log(this.options.colors ? chalk.green(formatted) : formatted);
  }

  // Utility methods for specific Guardian operations
  operation(operation: string, status: 'started' | 'completed' | 'failed'): void {
    const emoji = status === 'started' ? '🚀' : status === 'completed' ? '✅' : '❌';
    const color = status === 'started' ? 'blue' : status === 'completed' ? 'green' : 'red';
    const message = `${emoji} ${operation.toUpperCase()}: ${status}`;
    
    if (this.options.colors) {
      console.log(chalk[color](message));
    } else {
      console.log(message);
    }
  }

  violation(severity: string, message: string, file?: string): void {
    const emoji = {
      'CRITICAL': '🚨',
      'MAJOR': '⚠️',
      'MINOR': '📝',
      'SUGGESTION': '💡'
    }[severity] || '📋';

    const color = {
      'CRITICAL': 'red',
      'MAJOR': 'yellow', 
      'MINOR': 'blue',
      'SUGGESTION': 'cyan'
    }[severity] || 'white';

    const location = file ? ` in ${file}` : '';
    const formatted = `${emoji} ${severity}: ${message}${location}`;
    
    if (this.options.colors) {
      console.log((chalk as any)[color](formatted));
    } else {
      console.log(formatted);
    }
  }

  progress(current: number, total: number, operation: string): void {
    const percentage = Math.round((current / total) * 100);
    const progressBar = this.createProgressBar(percentage);
    const message = `🔄 ${operation}: ${progressBar} ${current}/${total} (${percentage}%)`;
    
    // Use carriage return to overwrite the line
    process.stdout.write(`\r${message}`);
    
    // Add newline when complete
    if (current === total) {
      process.stdout.write('\n');
    }
  }

  private createProgressBar(percentage: number): string {
    const width = 20;
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    
    if (this.options.colors) {
      return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    } else {
      return '█'.repeat(filled) + '░'.repeat(empty);
    }
  }

  // Method to create child logger with context
  child(context: Record<string, any>): Logger {
    const childLogger = new Logger(this.options);
    
    // Override methods to include context
    const originalMethods = ['debug', 'info', 'warn', 'error'] as const;
    originalMethods.forEach(method => {
      const original = childLogger[method].bind(childLogger);
      childLogger[method] = (message: string, ...args: any[]) => {
        const contextStr = Object.entries(context)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ');
        original(`[${contextStr}] ${message}`, ...args);
      };
    });

    return childLogger;
  }

  // Method to update log level dynamically
  setLevel(level: LogLevel): void {
    this.options.level = level;
  }

  // Method to toggle verbose mode
  setVerbose(verbose: boolean): void {
    this.options.verbose = verbose;
  }

  // Method to get current configuration
  getConfig(): LoggerOptions {
    return { ...this.options };
  }
}

// Export singleton instance for convenience
export const logger = new Logger();

// Export factory function
export function createLogger(options?: Partial<LoggerOptions>): Logger {
  return new Logger(options);
}