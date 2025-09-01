#!/usr/bin/env node

/**
 * Quality Metrics Collection Script for Yama
 * 
 * Collects and reports code quality metrics:
 * - Code coverage
 * - ESLint results
 * - TypeScript strictness
 * - Test results
 * - Build performance
 * - Security vulnerabilities
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCommand(command, description, silent = false) {
  try {
    const output = execSync(command, { 
      encoding: 'utf8', 
      stdio: silent ? 'pipe' : 'inherit',
      timeout: 60000 // 1 minute timeout
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || '' };
  }
}

function collectESLintMetrics() {
  console.log('🔍 Collecting ESLint metrics...');
  
  const result = runCommand('npx eslint src/ --format=json', 'ESLint analysis', true);
  
  if (!result.success) {
    return {
      errors: 0,
      warnings: 0,
      files: 0,
      status: 'failed',
      message: result.error
    };
  }

  try {
    const eslintData = JSON.parse(result.output);
    
    const metrics = {
      files: eslintData.length,
      errors: eslintData.reduce((sum, file) => sum + file.errorCount, 0),
      warnings: eslintData.reduce((sum, file) => sum + file.warningCount, 0),
      fixableErrors: eslintData.reduce((sum, file) => sum + file.fixableErrorCount, 0),
      fixableWarnings: eslintData.reduce((sum, file) => sum + file.fixableWarningCount, 0),
      status: 'success'
    };

    console.log(`   Files analyzed: ${metrics.files}`);
    console.log(`   Errors: ${metrics.errors}`);
    console.log(`   Warnings: ${metrics.warnings}`);
    
    return metrics;
  } catch (parseError) {
    return {
      errors: 0,
      warnings: 0,
      files: 0,
      status: 'parse_error',
      message: parseError.message
    };
  }
}

function collectTypeScriptMetrics() {
  console.log('🔧 Collecting TypeScript metrics...');
  
  const result = runCommand('npx tsc --noEmit --strict', 'TypeScript compilation', true);
  
  return {
    strictMode: true,
    compilationSuccess: result.success,
    errors: result.success ? 0 : 1,
    status: result.success ? 'success' : 'failed',
    message: result.success ? 'No type errors' : result.error
  };
}

function collectTestMetrics() {
  console.log('🧪 Collecting test metrics...');
  
  const result = runCommand('npm run test -- --coverage --silent', 'Test execution with coverage', true);
  
  const metrics = {
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    coverage: {
      lines: 0,
      functions: 0,
      branches: 0,
      statements: 0
    },
    status: result.success ? 'success' : 'failed'
  };

  if (result.success && result.output) {
    // Try to parse Jest output for basic metrics
    const lines = result.output.split('\n');
    
    // Look for test results summary
    const testLine = lines.find(line => line.includes('Tests:'));
    if (testLine) {
      const passMatch = testLine.match(/(\d+) passed/);
      const failMatch = testLine.match(/(\d+) failed/);
      
      if (passMatch) metrics.testsPassed = parseInt(passMatch[1], 10);
      if (failMatch) metrics.testsFailed = parseInt(failMatch[1], 10);
      metrics.testsRun = metrics.testsPassed + metrics.testsFailed;
    }
  }

  console.log(`   Tests run: ${metrics.testsRun}`);
  console.log(`   Tests passed: ${metrics.testsPassed}`);
  console.log(`   Tests failed: ${metrics.testsFailed}`);

  return metrics;
}

function collectBuildMetrics() {
  console.log('🏗️ Collecting build metrics...');
  
  const startTime = Date.now();
  const result = runCommand('npm run build', 'Production build', true);
  const buildTime = Date.now() - startTime;
  
  let buildSize = 0;
  let fileCount = 0;
  
  if (result.success) {
    try {
      const distPath = path.join(process.cwd(), 'dist');
      if (fs.existsSync(distPath)) {
        const files = fs.readdirSync(distPath, { recursive: true });
        fileCount = files.length;
        
        // Calculate total build size
        files.forEach(file => {
          const filePath = path.join(distPath, file);
          if (fs.statSync(filePath).isFile()) {
            buildSize += fs.statSync(filePath).size;
          }
        });
      }
    } catch (error) {
      console.log(`   Warning: Could not analyze build output: ${error.message}`);
    }
  }

  const metrics = {
    success: result.success,
    buildTime: buildTime,
    buildSize: buildSize,
    fileCount: fileCount,
    status: result.success ? 'success' : 'failed',
    error: result.success ? null : result.error
  };

  console.log(`   Build time: ${buildTime}ms`);
  console.log(`   Build size: ${(buildSize / 1024).toFixed(2)} KB`);
  console.log(`   Files generated: ${fileCount}`);

  return metrics;
}

function collectSecurityMetrics() {
  console.log('🔒 Collecting security metrics...');
  
  const auditResult = runCommand('npm audit --audit-level=moderate --json', 'Security audit', true);
  
  let vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0
  };

  if (auditResult.success && auditResult.output) {
    try {
      const auditData = JSON.parse(auditResult.output);
      if (auditData.metadata && auditData.metadata.vulnerabilities) {
        vulnerabilities = {
          ...vulnerabilities,
          ...auditData.metadata.vulnerabilities
        };
      }
    } catch (parseError) {
      console.log(`   Warning: Could not parse audit results: ${parseError.message}`);
    }
  }

  console.log(`   Total vulnerabilities: ${vulnerabilities.total}`);
  console.log(`   Critical: ${vulnerabilities.critical}, High: ${vulnerabilities.high}`);

  return {
    vulnerabilities,
    auditSuccess: auditResult.success,
    status: vulnerabilities.critical === 0 && vulnerabilities.high === 0 ? 'safe' : 'vulnerable'
  };
}

function generateQualityReport(metrics) {
  const report = {
    timestamp: new Date().toISOString(),
    project: 'yama',
    version: '1.0.0',
    metrics: metrics,
    summary: {
      overallScore: 0,
      recommendations: []
    }
  };

  // Calculate overall quality score (0-100)
  let score = 100;
  const recommendations = [];

  // ESLint deductions
  if (metrics.eslint.errors > 0) {
    score -= Math.min(metrics.eslint.errors * 5, 30);
    recommendations.push('Fix ESLint errors to improve code quality');
  }
  if (metrics.eslint.warnings > 10) {
    score -= 10;
    recommendations.push('Reduce ESLint warnings');
  }

  // TypeScript deductions
  if (!metrics.typescript.compilationSuccess) {
    score -= 20;
    recommendations.push('Fix TypeScript compilation errors');
  }

  // Test deductions
  if (metrics.tests.testsFailed > 0) {
    score -= Math.min(metrics.tests.testsFailed * 10, 40);
    recommendations.push('Fix failing tests');
  }
  if (metrics.tests.testsRun === 0) {
    score -= 30;
    recommendations.push('Add test coverage');
  }

  // Build deductions
  if (!metrics.build.success) {
    score -= 25;
    recommendations.push('Fix build issues');
  }

  // Security deductions
  if (metrics.security.vulnerabilities.critical > 0) {
    score -= 30;
    recommendations.push('Fix critical security vulnerabilities');
  }
  if (metrics.security.vulnerabilities.high > 0) {
    score -= 15;
    recommendations.push('Fix high severity security vulnerabilities');
  }

  report.summary.overallScore = Math.max(0, score);
  report.summary.recommendations = recommendations;

  return report;
}

function main() {
  console.log('📊 Collecting quality metrics for Yama...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const metrics = {
    eslint: collectESLintMetrics(),
    typescript: collectTypeScriptMetrics(),
    tests: collectTestMetrics(),
    build: collectBuildMetrics(),
    security: collectSecurityMetrics()
  };

  const report = generateQualityReport(metrics);

  // Save report to file
  const reportPath = path.join(process.cwd(), 'quality-metrics.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Quality Metrics Summary:');
  console.log(`   Overall Quality Score: ${report.summary.overallScore}/100`);
  console.log(`   ESLint: ${metrics.eslint.errors} errors, ${metrics.eslint.warnings} warnings`);
  console.log(`   TypeScript: ${metrics.typescript.compilationSuccess ? 'Compiled successfully' : 'Compilation failed'}`);
  console.log(`   Tests: ${metrics.tests.testsPassed}/${metrics.tests.testsRun} passed`);
  console.log(`   Build: ${metrics.build.success ? 'Success' : 'Failed'}`);
  console.log(`   Security: ${metrics.security.vulnerabilities.total} vulnerabilities`);

  if (report.summary.recommendations.length > 0) {
    console.log('\n💡 Recommendations:');
    report.summary.recommendations.forEach(rec => {
      console.log(`   • ${rec}`);
    });
  }

  console.log(`\n📄 Detailed report saved to: ${reportPath}`);

  // Exit with appropriate code
  if (report.summary.overallScore >= 80) {
    console.log('\n🎉 Excellent code quality!');
    process.exit(0);
  } else if (report.summary.overallScore >= 60) {
    console.log('\n⚠️ Good code quality with room for improvement');
    process.exit(0);
  } else {
    console.log('\n❌ Code quality needs improvement');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { collectESLintMetrics, collectTypeScriptMetrics, collectTestMetrics, generateQualityReport };