#!/usr/bin/env node

/**
 * Environment Validation Script for Yama
 *
 * Validates that all required environment variables are documented
 * and checks for potential environment configuration issues.
 *
 * This checks DOCUMENTATION, not the running environment: a developer reviewing
 * a local diff needs no forge token, and CI must not be told it does. What it
 * enforces is that every name an operator has to set appears in .env.example,
 * because nothing else in the repository can tell them — Yama names credentials
 * by env var NAME inside .yama/mcp.yaml and never carries a value.
 */

const fs = require("fs");
const path = require("path");

// Credentials a real run needs a value for. The model provider is read by the
// engine; the forge token is interpolated into .yama/mcp.yaml as ${VAR}.
const REQUIRED_ENV_VARS = [
  "LITELLM_API_KEY",
  "LITELLM_BASE_URL",
  "YAMA_GITHUB_TOKEN",
];

// Optional but recommended environment variables
const OPTIONAL_ENV_VARS = [
  "LANGFUSE_ENABLED",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "YAMA_GIT_USER",
];

function validateEnvironmentConfig() {
  const errors = [];
  const warnings = [];
  const info = [];

  // Check if .env.example exists
  const envExamplePath = path.join(process.cwd(), ".env.example");
  if (!fs.existsSync(envExamplePath)) {
    errors.push(
      ".env.example file is missing - required for documenting environment variables",
    );
  } else {
    const envExampleContent = fs.readFileSync(envExamplePath, "utf8");

    // Check if required variables are documented
    REQUIRED_ENV_VARS.forEach((varName) => {
      if (!envExampleContent.includes(varName)) {
        warnings.push(
          `Required environment variable ${varName} is not documented in .env.example`,
        );
      }
    });

    // Check if optional variables are documented
    OPTIONAL_ENV_VARS.forEach((varName) => {
      if (!envExampleContent.includes(varName)) {
        info.push(
          `Optional environment variable ${varName} could be documented in .env.example`,
        );
      }
    });
  }

  // Check for .env file in production builds
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    if (process.env.NODE_ENV === "production") {
      warnings.push(".env file should not be present in production builds");
    }

    // Check for potential security issues in .env
    const envContent = fs.readFileSync(envPath, "utf8");

    // Check for hardcoded secrets (basic patterns)
    const secretPatterns = [
      /api[_-]?key\s*=\s*['"]\w{20,}['"]/i,
      /token\s*=\s*['"]\w{20,}['"]/i,
      /secret\s*=\s*['"]\w{20,}['"]/i,
      /password\s*=\s*['"]\w{8,}['"]/i,
    ];

    secretPatterns.forEach((pattern) => {
      if (pattern.test(envContent)) {
        warnings.push("Potential hardcoded secrets detected in .env file");
      }
    });
  }

  // Check gitignore for .env
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    if (!gitignoreContent.includes(".env")) {
      errors.push(
        ".env file is not ignored in .gitignore - this could lead to secrets being committed",
      );
    }
  }

  // Check package.json for environment variable usage in scripts
  const packageJsonPath = path.join(process.cwd(), "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

    if (packageJson.scripts) {
      Object.entries(packageJson.scripts).forEach(
        ([scriptName, scriptCommand]) => {
          if (
            scriptCommand.includes("$") &&
            !scriptCommand.includes("npm_") &&
            !scriptCommand.includes("NODE_")
          ) {
            info.push(
              `Script '${scriptName}' may be using environment variables`,
            );
          }
        },
      );
    }
  }

  return { errors, warnings, info };
}

function main() {
  console.log("🌍 Validating environment configuration...");

  const result = validateEnvironmentConfig();

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("✅ Environment configuration validation passed");

    if (result.info.length > 0) {
      console.log("\nℹ️ Information:");
      result.info.forEach((info) => {
        console.log(`   • ${info}`);
      });
    }

    process.exit(0);
  } else {
    if (result.errors.length > 0) {
      console.log("\n❌ Environment configuration errors:");
      result.errors.forEach((error) => {
        console.log(`   • ${error}`);
      });
    }

    if (result.warnings.length > 0) {
      console.log("\n⚠️ Environment configuration warnings:");
      result.warnings.forEach((warning) => {
        console.log(`   • ${warning}`);
      });
    }

    if (result.info.length > 0) {
      console.log("\nℹ️ Information:");
      result.info.forEach((info) => {
        console.log(`   • ${info}`);
      });
    }

    // Exit with error only if there are actual errors
    process.exit(result.errors.length > 0 ? 1 : 0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validateEnvironmentConfig,
  REQUIRED_ENV_VARS,
  OPTIONAL_ENV_VARS,
};
