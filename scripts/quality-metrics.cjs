#!/usr/bin/env node

/**
 * Quality Metrics Collection Script for Yama
 *
 * Collects and reports code quality metrics:
 * - ESLint results
 * - TypeScript compilation, both projects
 * - Build performance and output size
 * - End-to-end test results
 * - Dependency vulnerabilities
 *
 * There is no coverage number here, and that is deliberate: Yama's suites are
 * end-to-end against the BUILT package (test/run.ts), so a line-coverage figure
 * over src/ would measure the wrong artifact.
 *
 * Writes quality-metrics.json in the working directory.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function runCommand(command, description, silent = false, timeout = 60000) {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      stdio: silent ? "pipe" : "inherit",
      timeout,
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || "" };
  }
}

/**
 * The build and the end-to-end suites are minutes of work, not seconds. The old
 * one-minute bound killed them and recorded the kill as a failure, which read as
 * "the build is broken" on a perfectly good tree.
 */
const LONG_TIMEOUT_MS = 15 * 60 * 1000;

function collectESLintMetrics() {
  console.log("🔍 Collecting ESLint metrics...");

  // The whole tree, the same surface `pnpm run lint` covers — src/ alone left
  // eslint-rules/ and the test harness unmeasured.
  const result = runCommand(
    "pnpm exec eslint . --format=json",
    "ESLint analysis",
    true,
    LONG_TIMEOUT_MS,
  );

  // eslint exits non-zero WHEN IT FINDS ERRORS, and still writes its JSON report
  // to stdout. Treating that exit as "the tool failed" scored a tree full of
  // errors as zero errors — the report was cleanest exactly when the code was
  // worst. The output is parsed either way; only unparseable output is a failure.
  try {
    const eslintData = JSON.parse(result.output);

    const metrics = {
      files: eslintData.length,
      errors: eslintData.reduce((sum, file) => sum + file.errorCount, 0),
      warnings: eslintData.reduce((sum, file) => sum + file.warningCount, 0),
      fixableErrors: eslintData.reduce(
        (sum, file) => sum + file.fixableErrorCount,
        0,
      ),
      fixableWarnings: eslintData.reduce(
        (sum, file) => sum + file.fixableWarningCount,
        0,
      ),
      status: "success",
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
      status: "parse_error",
      message: `${parseError.message}${result.error ? ` (${result.error})` : ""}`,
    };
  }
}

function collectTypeScriptMetrics() {
  console.log("🔧 Collecting TypeScript metrics...");

  // `check` compiles BOTH projects — src and test. Calling tsc directly would
  // type-check src only and report a clean tree while the suites do not compile.
  const result = runCommand(
    "pnpm run check",
    "TypeScript compilation",
    true,
    LONG_TIMEOUT_MS,
  );

  return {
    strictMode: true,
    compilationSuccess: result.success,
    errors: result.success ? 0 : 1,
    status: result.success ? "success" : "failed",
    message: result.success ? "No type errors" : result.error,
  };
}

function collectTestMetrics() {
  console.log("🧪 Collecting test metrics...");

  // The suites drive dist/, so this has to run after the build below — see the
  // order in main().
  const result = runCommand(
    "pnpm run test",
    "Test execution",
    true,
    LONG_TIMEOUT_MS,
  );

  const metrics = {
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    testsSkipped: 0,
    status: result.success ? "success" : "failed",
  };

  // The harness (test/run.ts) closes with a tally of `passed N` / `failed N` /
  // `skipped N` / `total N`, one per line and wrapped in colour escapes. Those
  // escapes are stripped and each line is matched whole, because a test NAME
  // containing the word "passed" would otherwise be read as the tally.
  // `failed` and `skipped` lines are omitted entirely when they are zero.
  const output = `${result.output || ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  const count = (label) => {
    const match = output.match(new RegExp(`^\\s*${label}\\s+(\\d+)\\s*$`, "m"));
    return match ? parseInt(match[1], 10) : 0;
  };
  metrics.testsPassed = count("passed");
  metrics.testsFailed = count("failed");
  metrics.testsSkipped = count("skipped");
  metrics.testsRun =
    count("total") || metrics.testsPassed + metrics.testsFailed;

  console.log(`   Tests run: ${metrics.testsRun}`);
  console.log(`   Tests passed: ${metrics.testsPassed}`);
  console.log(`   Tests failed: ${metrics.testsFailed}`);
  console.log(`   Tests skipped: ${metrics.testsSkipped}`);

  return metrics;
}

function collectBuildMetrics() {
  console.log("🏗️ Collecting build metrics...");

  const startTime = Date.now();
  const result = runCommand(
    "pnpm run build",
    "Production build",
    true,
    LONG_TIMEOUT_MS,
  );
  const buildTime = Date.now() - startTime;

  let buildSize = 0;
  let fileCount = 0;

  if (result.success) {
    try {
      const distPath = path.join(process.cwd(), "dist");
      if (fs.existsSync(distPath)) {
        const files = fs.readdirSync(distPath, { recursive: true });
        fileCount = files.length;

        // Calculate total build size
        files.forEach((file) => {
          const filePath = path.join(distPath, file);
          if (fs.statSync(filePath).isFile()) {
            buildSize += fs.statSync(filePath).size;
          }
        });
      }
    } catch (error) {
      console.log(
        `   Warning: Could not analyze build output: ${error.message}`,
      );
    }
  }

  const metrics = {
    success: result.success,
    buildTime: buildTime,
    buildSize: buildSize,
    fileCount: fileCount,
    status: result.success ? "success" : "failed",
    error: result.success ? null : result.error,
  };

  console.log(`   Build time: ${buildTime}ms`);
  console.log(`   Build size: ${(buildSize / 1024).toFixed(2)} KB`);
  console.log(`   Files generated: ${fileCount}`);

  return metrics;
}

function collectSecurityMetrics() {
  console.log("🔒 Collecting security metrics...");

  // `pnpm audit`, not `npm audit`: npm's audit needs a package-lock.json, which
  // a pnpm repository does not have, so it failed on every run and reported zero
  // vulnerabilities — a clean bill of health from a check that never ran.
  //
  // A non-zero exit means "vulnerabilities found", not "the audit broke", so the
  // report is parsed whether or not the command succeeded.
  const auditResult = runCommand(
    "pnpm audit --json",
    "Security audit",
    true,
    LONG_TIMEOUT_MS,
  );

  let vulnerabilities = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  };
  let auditParsed = false;

  if (auditResult.output) {
    try {
      const auditData = JSON.parse(auditResult.output);
      if (auditData.metadata && auditData.metadata.vulnerabilities) {
        vulnerabilities = {
          ...vulnerabilities,
          ...auditData.metadata.vulnerabilities,
        };
        // pnpm reports the per-severity counts but no total; npm reports both.
        if (auditData.metadata.vulnerabilities.total === undefined) {
          vulnerabilities.total =
            vulnerabilities.info +
            vulnerabilities.low +
            vulnerabilities.moderate +
            vulnerabilities.high +
            vulnerabilities.critical;
        }
        auditParsed = true;
      }
    } catch (parseError) {
      console.log(
        `   Warning: Could not parse audit results: ${parseError.message}`,
      );
    }
  }

  if (!auditParsed) {
    // Unknown is not safe. Say so, rather than scoring an unrun audit as clean.
    console.log("   Warning: audit produced no readable report");
    return {
      vulnerabilities,
      auditSuccess: false,
      status: "unknown",
    };
  }

  console.log(`   Total vulnerabilities: ${vulnerabilities.total}`);
  console.log(
    `   Critical: ${vulnerabilities.critical}, High: ${vulnerabilities.high}`,
  );

  return {
    vulnerabilities,
    auditSuccess: auditResult.success,
    status:
      vulnerabilities.critical === 0 && vulnerabilities.high === 0
        ? "safe"
        : "vulnerable",
  };
}

function generateQualityReport(metrics) {
  // Read the version rather than restating it — a hardcoded one was still
  // claiming 1.0.0 several majors later.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );
  const report = {
    timestamp: new Date().toISOString(),
    project: pkg.name,
    version: pkg.version,
    metrics: metrics,
    summary: {
      overallScore: 0,
      recommendations: [],
    },
  };

  // Calculate overall quality score (0-100)
  let score = 100;
  const recommendations = [];

  // A check that could not run is unknown, not clean — score it as a gap, or the
  // report reads greenest on the tree nobody could measure.
  if (metrics.eslint.status === "parse_error") {
    score -= 10;
    recommendations.push(
      "ESLint produced no readable report — lint is unmeasured",
    );
  }
  if (metrics.security.status === "unknown") {
    score -= 5;
    recommendations.push(
      "The dependency audit produced no readable report — vulnerability status is unknown",
    );
  }

  // ESLint deductions
  if (metrics.eslint.errors > 0) {
    score -= Math.min(metrics.eslint.errors * 5, 30);
    recommendations.push("Fix ESLint errors to improve code quality");
  }
  if (metrics.eslint.warnings > 10) {
    score -= 10;
    recommendations.push("Reduce ESLint warnings");
  }

  // TypeScript deductions
  if (!metrics.typescript.compilationSuccess) {
    score -= 20;
    recommendations.push("Fix TypeScript compilation errors");
  }

  // Test deductions
  if (metrics.tests.testsFailed > 0) {
    score -= Math.min(metrics.tests.testsFailed * 10, 40);
    recommendations.push("Fix failing tests");
  }
  if (metrics.tests.testsRun === 0) {
    score -= 30;
    recommendations.push("Add test coverage");
  }

  // Build deductions
  if (!metrics.build.success) {
    score -= 25;
    recommendations.push("Fix build issues");
  }

  // Security deductions
  if (metrics.security.vulnerabilities.critical > 0) {
    score -= 30;
    recommendations.push("Fix critical security vulnerabilities");
  }
  if (metrics.security.vulnerabilities.high > 0) {
    score -= 15;
    recommendations.push("Fix high severity security vulnerabilities");
  }

  report.summary.overallScore = Math.max(0, score);
  report.summary.recommendations = recommendations;

  return report;
}

function main() {
  console.log("📊 Collecting quality metrics for Yama...");
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  // The build comes BEFORE the tests: the e2e suites drive dist/cli/index.js and
  // dist/index.js, never src/. Run the other way round they test the previous
  // build, or report "nothing executed" on a fresh checkout and score it as
  // missing coverage.
  const metrics = {
    eslint: collectESLintMetrics(),
    typescript: collectTypeScriptMetrics(),
    build: collectBuildMetrics(),
    tests: collectTestMetrics(),
    security: collectSecurityMetrics(),
  };

  const report = generateQualityReport(metrics);

  // Save report to file
  const reportPath = path.join(process.cwd(), "quality-metrics.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log("📋 Quality Metrics Summary:");
  console.log(`   Overall Quality Score: ${report.summary.overallScore}/100`);
  console.log(
    `   ESLint: ${metrics.eslint.errors} errors, ${metrics.eslint.warnings} warnings`,
  );
  console.log(
    `   TypeScript: ${metrics.typescript.compilationSuccess ? "Compiled successfully" : "Compilation failed"}`,
  );
  console.log(
    `   Tests: ${metrics.tests.testsPassed}/${metrics.tests.testsRun} passed` +
      (metrics.tests.testsSkipped > 0
        ? `, ${metrics.tests.testsSkipped} skipped`
        : ""),
  );
  console.log(`   Build: ${metrics.build.success ? "Success" : "Failed"}`);
  console.log(
    `   Security: ${
      metrics.security.status === "unknown"
        ? "audit unreadable — status unknown"
        : `${metrics.security.vulnerabilities.total} vulnerabilities`
    }`,
  );

  if (report.summary.recommendations.length > 0) {
    console.log("\n💡 Recommendations:");
    report.summary.recommendations.forEach((rec) => {
      console.log(`   • ${rec}`);
    });
  }

  console.log(`\n📄 Detailed report saved to: ${reportPath}`);

  // Exit with appropriate code
  if (report.summary.overallScore >= 80) {
    console.log("\n🎉 Excellent code quality!");
    process.exit(0);
  } else if (report.summary.overallScore >= 60) {
    console.log("\n⚠️ Good code quality with room for improvement");
    process.exit(0);
  } else {
    console.log("\n❌ Code quality needs improvement");
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  collectESLintMetrics,
  collectTypeScriptMetrics,
  collectTestMetrics,
  generateQualityReport,
};
