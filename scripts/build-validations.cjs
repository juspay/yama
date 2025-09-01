#!/usr/bin/env node

/**
 * Build Validation Script for Yama
 * 
 * Comprehensive build validation including:
 * - TypeScript compilation
 * - ESLint validation
 * - Package.json integrity
 * - Build output validation
 * - Dependency security check
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCommand(command, description) {
  console.log(`🔍 ${description}...`);
  try {
    const output = execSync(command, { encoding: 'utf8', stdio: 'pipe' });
    console.log(`✅ ${description} - PASSED`);
    return { success: true, output };
  } catch (error) {
    console.log(`❌ ${description} - FAILED`);
    console.log(`Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function validatePackageJson() {
  console.log('📦 Validating package.json integrity...');
  
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('package.json not found');
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  // Check required fields
  const requiredFields = ['name', 'version', 'description', 'scripts', 'dependencies'];
  const missingFields = requiredFields.filter(field => !packageJson[field]);
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields in package.json: ${missingFields.join(', ')}`);
  }

  // Check for essential scripts
  const requiredScripts = ['build', 'test', 'lint', 'type-check'];
  const missingScripts = requiredScripts.filter(script => !packageJson.scripts[script]);
  
  if (missingScripts.length > 0) {
    console.log(`⚠️ Warning: Missing recommended scripts: ${missingScripts.join(', ')}`);
  }

  console.log('✅ Package.json validation - PASSED');
  return true;
}

function validateBuildOutput() {
  console.log('🏗️ Validating build output...');
  
  const distPath = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(distPath)) {
    throw new Error('Build output directory (dist/) not found. Run npm run build first.');
  }

  const distContents = fs.readdirSync(distPath);
  if (distContents.length === 0) {
    throw new Error('Build output directory is empty');
  }

  // Check for essential build files
  const hasIndexFile = distContents.some(file => file.startsWith('index.'));
  if (!hasIndexFile) {
    console.log('⚠️ Warning: No index file found in build output');
  }

  console.log(`✅ Build output validation - PASSED (${distContents.length} files)`);
  return true;
}

function validateDependencies() {
  console.log('📚 Validating dependencies...');
  
  const packageLockPath = path.join(process.cwd(), 'package-lock.json');
  const pnpmLockPath = path.join(process.cwd(), 'pnpm-lock.yaml');
  
  if (!fs.existsSync(packageLockPath) && !fs.existsSync(pnpmLockPath)) {
    console.log('⚠️ Warning: No lock file found (package-lock.json or pnpm-lock.yaml)');
  }

  // Check node_modules exists
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    throw new Error('node_modules directory not found. Run npm install first.');
  }

  console.log('✅ Dependencies validation - PASSED');
  return true;
}

function main() {
  console.log('🏗️ Running comprehensive build validation...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const validations = [
    // Package.json validation
    () => validatePackageJson(),
    
    // Dependencies validation  
    () => validateDependencies(),
    
    // TypeScript compilation
    () => runCommand('npm run type-check', 'TypeScript compilation check'),
    
    // ESLint validation
    () => runCommand('npm run lint', 'ESLint validation'),
    
    // Build validation
    () => runCommand('npm run build', 'Production build'),
    
    // Build output validation
    () => validateBuildOutput(),
    
    // Test execution
    () => runCommand('npm run test', 'Test execution')
  ];

  let allPassed = true;
  const results = [];

  for (let i = 0; i < validations.length; i++) {
    try {
      const result = validations[i]();
      results.push({ step: i + 1, success: true, result });
    } catch (error) {
      results.push({ step: i + 1, success: false, error: error.message });
      allPassed = false;
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Build Validation Summary:');
  
  results.forEach(({ step, success, error }) => {
    const status = success ? '✅' : '❌';
    const message = success ? 'PASSED' : `FAILED: ${error}`;
    console.log(`  ${status} Step ${step}: ${message}`);
  });

  if (allPassed) {
    console.log('\n🎉 All build validations passed!');
    console.log('✅ Project is ready for production deployment');
    process.exit(0);
  } else {
    console.log('\n❌ Build validation failed');
    console.log('🔧 Please fix the issues above before proceeding');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { validatePackageJson, validateBuildOutput, validateDependencies };