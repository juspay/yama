#!/usr/bin/env node

/**
 * Commit Message Validation Script for Yama
 * 
 * Validates commit messages against semantic commit format:
 * type(scope): description
 * 
 * Valid types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
 * 
 * Examples:
 * - feat(cli): add new command for PR analysis
 * - fix(api): resolve authentication issue with GitHub
 * - docs: update installation instructions
 */

const fs = require('fs');
const path = require('path');

// Semantic commit types
const VALID_TYPES = [
  'feat',     // New feature
  'fix',      // Bug fix
  'docs',     // Documentation changes
  'style',    // Code style changes (formatting, etc.)
  'refactor', // Code refactoring
  'perf',     // Performance improvements
  'test',     // Test changes
  'chore',    // Maintenance tasks
  'ci',       // CI/CD changes
  'build',    // Build system changes
  'deps',     // Dependency updates
  'security', // Security improvements
  'revert'    // Revert previous commit
];

// Valid scopes (optional but recommended)
const VALID_SCOPES = [
  'cli',
  'core',
  'api',
  'ai',
  'security',
  'config',
  'docs',
  'tests',
  'github',
  'bitbucket',
  'gitlab',
  'deps'
];

// Semantic commit regex pattern
const COMMIT_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|deps|security|revert)(\(.+\))?: .{1,72}$/;

// More detailed pattern for parsing
const DETAILED_PATTERN = /^(\w+)(\(([^)]+)\))?: (.+)$/;

function validateCommitMessage(message) {
  const errors = [];
  const warnings = [];

  // Basic format validation
  if (!COMMIT_PATTERN.test(message)) {
    if (!DETAILED_PATTERN.test(message)) {
      errors.push('Commit message does not follow semantic format: type(scope): description');
      return { isValid: false, errors, warnings };
    }

    const match = message.match(DETAILED_PATTERN);
    const [, type, , scope, description] = match;

    // Validate type
    if (!VALID_TYPES.includes(type)) {
      errors.push(`Invalid commit type '${type}'. Valid types: ${VALID_TYPES.join(', ')}`);
    }

    // Validate scope (warning only)
    if (scope && !VALID_SCOPES.includes(scope)) {
      warnings.push(`Uncommon scope '${scope}'. Common scopes: ${VALID_SCOPES.join(', ')}`);
    }

    // Validate description
    if (!description || description.length < 3) {
      errors.push('Description must be at least 3 characters long');
    }

    if (description && description.length > 72) {
      warnings.push('Description is longer than 72 characters, consider shortening');
    }

    if (description && description.charAt(0) === description.charAt(0).toUpperCase()) {
      warnings.push('Description should start with lowercase letter');
    }

    if (description && description.endsWith('.')) {
      warnings.push('Description should not end with a period');
    }
  }

  // Check for common patterns that should be avoided
  const lowerMessage = message.toLowerCase();
  
  if (lowerMessage.includes('wip') || lowerMessage.includes('work in progress')) {
    warnings.push('Avoid committing work-in-progress. Consider squashing before merge.');
  }

  if (lowerMessage.includes('fix typo') || lowerMessage.includes('typo')) {
    warnings.push('Consider using "docs: fix typo in ..." for better semantics');
  }

  if (lowerMessage.includes('update') && !lowerMessage.includes('feat') && !lowerMessage.includes('fix')) {
    warnings.push('Consider using more specific type (feat/fix/docs) instead of generic "update"');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

function main() {
  let commitMessage;

  // Get commit message from command line argument or stdin
  if (process.argv[2]) {
    commitMessage = process.argv[2];
  } else if (process.env.COMMIT_MESSAGE) {
    commitMessage = process.env.COMMIT_MESSAGE;
  } else {
    // Get the latest commit message from the current branch (not merge commits)
    try {
      const { execSync } = require('child_process');
      
      // Get current branch name
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
      
      // If we're on main/master, get the latest commit
      // If we're on a feature branch, get the latest commit from this branch
      if (currentBranch === 'main' || currentBranch === 'master') {
        commitMessage = execSync('git log -1 --pretty=format:"%s"', { encoding: 'utf8' }).trim();
      } else {
        // For feature branches, get the latest commit that's not from main
        // This ensures we validate the actual feature branch commit, not any merge commits
        commitMessage = execSync(`git log -1 --pretty=format:"%s" ${currentBranch}`, { encoding: 'utf8' }).trim();
      }
      
      console.log(`🔍 Current branch: ${currentBranch}`);
      console.log(`🔍 Commit to validate: ${commitMessage}`);
      
    } catch (error) {
      // Fallback to .git/COMMIT_EDITMSG if git commands fail
      const gitCommitMsgPath = path.join(process.cwd(), '.git', 'COMMIT_EDITMSG');
      if (fs.existsSync(gitCommitMsgPath)) {
        commitMessage = fs.readFileSync(gitCommitMsgPath, 'utf8').trim();
      } else {
        console.error('❌ No commit message provided and unable to read from git');
        console.error('Usage: node commit-validation.cjs "commit message"');
        process.exit(1);
      }
    }
  }

  if (!commitMessage || commitMessage.trim() === '') {
    console.error('❌ Empty commit message');
    process.exit(1);
  }

  // Take only the first line for validation (ignore body and footer)
  const firstLine = commitMessage.split('\n')[0].trim();

  console.log(`🔍 Validating commit message: "${firstLine}"`);

  const result = validateCommitMessage(firstLine);

  // Display results
  if (result.isValid) {
    console.log('✅ Commit message is valid');
    
    if (result.warnings.length > 0) {
      console.log('\n⚠️ Warnings:');
      result.warnings.forEach(warning => {
        console.log(`   • ${warning}`);
      });
    }
    
    console.log('\n📋 Commit message follows semantic format guidelines');
    process.exit(0);
  } else {
    console.log('\n❌ Commit message validation failed');
    console.log('\n🔥 Errors:');
    result.errors.forEach(error => {
      console.log(`   • ${error}`);
    });

    if (result.warnings.length > 0) {
      console.log('\n⚠️ Warnings:');
      result.warnings.forEach(warning => {
        console.log(`   • ${warning}`);
      });
    }

    console.log('\n📖 Examples of valid commit messages:');
    console.log('   • feat(cli): add new command for PR analysis');
    console.log('   • fix(api): resolve authentication issue with GitHub');
    console.log('   • docs: update installation instructions');
    console.log('   • refactor(core): simplify PR processing logic');
    console.log('   • test(api): add unit tests for GitHub integration');

    console.log('\n🔗 Learn more: https://www.conventionalcommits.org/');
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  main();
}

module.exports = { validateCommitMessage, VALID_TYPES, VALID_SCOPES };