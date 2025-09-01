#!/usr/bin/env node

/**
 * Security Validation Script for Yama
 * 
 * Performs basic security checks on the codebase:
 * - Scans for potential API key leaks
 * - Checks for unsafe patterns
 * - Validates security-related configurations
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Patterns that could indicate security issues
const SECURITY_PATTERNS = [
  // API keys and tokens
  {
    pattern: /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/i,
    severity: 'high',
    description: 'Potential hardcoded API key or token'
  },
  {
    pattern: /['"][a-zA-Z0-9]{32,}['"]/g,
    severity: 'medium',
    description: 'Potential hardcoded secret (long string)',
    excludePatterns: [
      /forceConsistentCasingInFileNames/,
      /allowSyntheticDefaultImports/,
      /experimentalDecorators/,
      /emitDecoratorMetadata/
    ]
  },
  {
    pattern: /process\.env\.[A-Z_]+\s*\|\|\s*['"][^'"]+['"]/g,
    severity: 'medium',
    description: 'Environment variable with hardcoded fallback'
  },
  
  // Unsafe patterns
  {
    pattern: /eval\s*\(/g,
    severity: 'high',
    description: 'Use of eval() function (security risk)'
  },
  {
    pattern: /innerHTML\s*=/g,
    severity: 'medium',
    description: 'Use of innerHTML (potential XSS risk)'
  },
  {
    pattern: /dangerouslySetInnerHTML/g,
    severity: 'medium',
    description: 'Use of dangerouslySetInnerHTML'
  },
  {
    pattern: /exec\s*\(/g,
    severity: 'high',
    description: 'Use of exec() function (command injection risk)'
  },
  
  // Console statements in production (excluding CLI and test files)
  {
    pattern: /console\.(log|debug|info)\s*\(/g,
    severity: 'low',
    description: 'Console statement (should use logger in production)',
    excludeFiles: [
      /src\/cli\//,
      /test-.*\.js$/,
      /\.test\./,
      /\.spec\./,
      /README\.md$/,
      /\.claude\//
    ]
  }
];

// Files to exclude from security scanning
const EXCLUDED_PATHS = [
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '*.min.js',
  '*.bundle.js',
  'scripts/validate-security.cjs' // Exclude this file itself
];

function shouldExcludeFile(filePath) {
  return EXCLUDED_PATHS.some(excludePath => {
    if (excludePath.includes('*')) {
      const pattern = excludePath.replace(/\*/g, '.*');
      return new RegExp(pattern).test(filePath);
    }
    return filePath.includes(excludePath);
  });
}

function scanFileForSecurityIssues(filePath) {
  const issues = [];
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    SECURITY_PATTERNS.forEach(({ pattern, severity, description, excludePatterns, excludeFiles }) => {
      // Skip this pattern for files that match excludeFiles
      if (excludeFiles && excludeFiles.some(excludeFile => excludeFile.test(filePath))) {
        return;
      }
      
      lines.forEach((line, lineNumber) => {
        const matches = line.match(pattern);
        if (matches) {
          matches.forEach(match => {
            // Skip if it's in a comment and not actually problematic
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
              return;
            }
            
            // Skip if match is in exclude patterns
            if (excludePatterns && excludePatterns.some(excludePattern => excludePattern.test(match))) {
              return;
            }
            
            issues.push({
              file: filePath,
              line: lineNumber + 1,
              severity,
              description,
              match: match.substring(0, 50) + (match.length > 50 ? '...' : ''),
              fullLine: line.trim()
            });
          });
        }
      });
    });
  } catch (error) {
    // Skip files that can't be read
  }
  
  return issues;
}

function scanDirectory(dirPath) {
  const allIssues = [];
  
  function walkDirectory(currentPath) {
    try {
      const entries = fs.readdirSync(currentPath);
      
      entries.forEach(entry => {
        const fullPath = path.join(currentPath, entry);
        const relativePath = path.relative(process.cwd(), fullPath);
        
        if (shouldExcludeFile(relativePath)) {
          return;
        }
        
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          walkDirectory(fullPath);
        } else if (stat.isFile()) {
          // Only scan text files
          const ext = path.extname(fullPath).toLowerCase();
          if (['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.yml', '.yaml', '.env'].includes(ext)) {
            const issues = scanFileForSecurityIssues(fullPath);
            allIssues.push(...issues);
          }
        }
      });
    } catch (error) {
      // Skip directories that can't be read
    }
  }
  
  walkDirectory(dirPath);
  return allIssues;
}

function validatePackageJsonSecurity() {
  const issues = [];
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    
    // Check for suspicious dependencies (basic check)
    if (packageJson.dependencies) {
      Object.keys(packageJson.dependencies).forEach(dep => {
        if (dep.length < 3 || /^[0-9]/.test(dep)) {
          issues.push({
            severity: 'medium',
            description: `Suspicious dependency name: ${dep}`,
            file: 'package.json'
          });
        }
      });
    }
    
    // Check for scripts that might be problematic
    if (packageJson.scripts) {
      Object.entries(packageJson.scripts).forEach(([scriptName, scriptCommand]) => {
        if (scriptCommand.includes('curl') || scriptCommand.includes('wget')) {
          issues.push({
            severity: 'medium',
            description: `Script '${scriptName}' downloads content from internet`,
            file: 'package.json'
          });
        }
        
        if (scriptCommand.includes('rm -rf') || scriptCommand.includes('del /f')) {
          issues.push({
            severity: 'low',
            description: `Script '${scriptName}' performs destructive file operations`,
            file: 'package.json'
          });
        }
      });
    }
  }
  
  return issues;
}

function main() {
  console.log('🔒 Running security validation...');

  const codeIssues = scanDirectory(process.cwd());
  const packageIssues = validatePackageJsonSecurity();
  
  const allIssues = [...codeIssues, ...packageIssues];
  
  // Categorize issues by severity
  const highSeverityIssues = allIssues.filter(issue => issue.severity === 'high');
  const mediumSeverityIssues = allIssues.filter(issue => issue.severity === 'medium');
  const lowSeverityIssues = allIssues.filter(issue => issue.severity === 'low');

  if (allIssues.length === 0) {
    console.log('✅ No security issues detected');
    process.exit(0);
  }

  let hasErrors = false;

  if (highSeverityIssues.length > 0) {
    console.log('\n🔥 High Severity Security Issues:');
    highSeverityIssues.forEach(issue => {
      console.log(`   • ${issue.file}:${issue.line || 'N/A'} - ${issue.description}`);
      if (issue.match) {
        console.log(`     Match: ${issue.match}`);
      }
    });
    hasErrors = true;
  }

  if (mediumSeverityIssues.length > 0) {
    console.log('\n⚠️ Medium Severity Security Issues:');
    mediumSeverityIssues.forEach(issue => {
      console.log(`   • ${issue.file}:${issue.line || 'N/A'} - ${issue.description}`);
      if (issue.match) {
        console.log(`     Match: ${issue.match}`);
      }
    });
  }

  if (lowSeverityIssues.length > 0) {
    console.log('\nℹ️ Low Severity Issues (Recommendations):');
    lowSeverityIssues.forEach(issue => {
      console.log(`   • ${issue.file}:${issue.line || 'N/A'} - ${issue.description}`);
    });
  }

  console.log(`\n📊 Security Scan Summary:`);
  console.log(`   High: ${highSeverityIssues.length}, Medium: ${mediumSeverityIssues.length}, Low: ${lowSeverityIssues.length}`);

  if (hasErrors) {
    console.log('\n❌ Security validation failed - please address high severity issues');
    process.exit(1);
  } else {
    console.log('\n✅ Security validation passed - no high severity issues found');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { scanFileForSecurityIssues, validatePackageJsonSecurity, SECURITY_PATTERNS };