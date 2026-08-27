#!/usr/bin/env node

/**
 * Build Validation Script for Yama
 *
 * Comprehensive build validation including:
 * - Package.json integrity
 * - Dependency and lock-file sanity
 * - TypeScript compilation (both projects) and ESLint
 * - Production build
 * - action.yml manifest rules
 * - Build output: the paths `main` and `bin` resolve to
 * - The CLI invoked the way npx invokes it, through a bin shim
 * - The end-to-end suites, against the built package
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function runCommand(command, description) {
  console.log(`🔍 ${description}...`);
  try {
    const output = execSync(command, { encoding: "utf8", stdio: "pipe" });
    console.log(`✅ ${description} - PASSED`);
    return { success: true, output };
  } catch (error) {
    console.log(`❌ ${description} - FAILED`);
    console.log(`Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function validatePackageJson() {
  console.log("📦 Validating package.json integrity...");

  const packageJsonPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error("package.json not found");
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  // Check required fields
  const requiredFields = [
    "name",
    "version",
    "description",
    "scripts",
    "dependencies",
  ];
  const missingFields = requiredFields.filter((field) => !packageJson[field]);

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required fields in package.json: ${missingFields.join(", ")}`,
    );
  }

  // Check for essential scripts
  const requiredScripts = ["build", "test", "lint", "type-check"];
  const missingScripts = requiredScripts.filter(
    (script) => !packageJson.scripts[script],
  );

  if (missingScripts.length > 0) {
    console.log(
      `⚠️ Warning: Missing recommended scripts: ${missingScripts.join(", ")}`,
    );
  }

  console.log("✅ Package.json validation - PASSED");
  return true;
}

function validateActionManifest() {
  console.log("🎬 Validating action.yml manifest...");

  const actionPath = path.join(process.cwd(), "action.yml");
  if (!fs.existsSync(actionPath)) {
    console.log("  (no action.yml — skipping)");
    return true;
  }

  // The `secrets` (and `vars`) context does not exist in a composite action —
  // GitHub evaluates every ${{ }} expression in the manifest at load time, so
  // a single `${{ secrets.X }}` anywhere, even inside a description string,
  // fails the whole action with "Unrecognized named-value: secrets" before any
  // step runs. This shipped once, in the vcs-token input's own documentation,
  // and broke every consumer. Tokens arrive through `inputs`; the context is
  // banned everywhere in this file, prose included.
  const source = fs.readFileSync(actionPath, "utf8");
  const banned = [
    ...source.matchAll(/\$\{\{[^}]*\b(secrets|vars)\b[^}]*\}\}/g),
  ];
  if (banned.length > 0) {
    throw new Error(
      "action.yml references a context unavailable in a composite action " +
        "(secrets/vars) inside a ${{ }} expression — the runner evaluates it " +
        "at manifest load and the action fails to load:\n" +
        banned.map((m) => `  ${m[0]}`).join("\n") +
        "\nPass tokens through `inputs`, and never write secrets.* with " +
        "expression braces anywhere in this manifest, including prose.",
    );
  }

  // The action installs the published package by range. A range that does not
  // cover this package's own major would run a different Yama against a v5
  // config directory, which fails as a broken review rather than as a version
  // mismatch — the exact failure the pin exists to prevent.
  const major = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ).version.split(".")[0];
  const pinned = source.match(/yama-version:[\s\S]*?default:\s*"([^"]+)"/);
  if (pinned && !pinned[1].includes(`${major}.`)) {
    throw new Error(
      `action.yml pins yama-version to "${pinned[1]}", which does not cover ` +
        `this package's major (${major}). A consumer of the action would run a ` +
        "different Yama than this repository builds.",
    );
  }

  console.log("  ✅ no unavailable-context references; version pin matches");
  return true;
}

function validateBuildOutput() {
  console.log("🏗️ Validating build output...");

  const distPath = path.join(process.cwd(), "dist");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      "Build output directory (dist/) not found. Run pnpm run build first.",
    );
  }

  const distContents = fs.readdirSync(distPath);
  if (distContents.length === 0) {
    throw new Error("Build output directory is empty");
  }

  // Check for essential build files: the paths package.json's `main` and `bin`
  // resolve to. Anything else in dist/ can be missing and the package still works.
  const entryPoints = [path.join("index.js"), path.join("cli", "index.js")];
  const missingEntryPoints = entryPoints
    .filter((entry) => !fs.existsSync(path.join(distPath, entry)))
    .map((entry) => `dist/${entry.split(path.sep).join("/")}`);

  if (missingEntryPoints.length > 0) {
    throw new Error(
      `Missing build entry points: ${missingEntryPoints.join(", ")}. ` +
        "The package would install with an unusable main/bin.",
    );
  }

  console.log(
    `✅ Build output validation - PASSED (${entryPoints.length} entry point(s) verified)`,
  );
  return true;
}

function validateCliThroughBinShim() {
  console.log("🔗 Validating the CLI through a bin-shim symlink...");

  // A package manager installs the CLI as a symlink (node_modules/.bin/yama →
  // dist/cli/index.js), so process.argv[1] is the SHIM's path, not the entry's.
  // A previous major guarded its entry with a filename-suffix check and, through
  // the shim — exactly how the GitHub Action invokes it — every command loaded,
  // did nothing, and exited 0. This executes the built CLI the way npx does and
  // demands real output back.
  const os = require("os");
  const { execFileSync } = require("child_process");

  const cliPath = path.join(process.cwd(), "dist", "cli", "index.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error("dist/cli/index.js not found. Run pnpm run build first.");
  }

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "yama-shim-"));
  const shimPath = path.join(shimDir, "yama");
  try {
    fs.symlinkSync(cliPath, shimPath);
    const stdout = execFileSync(process.execPath, [shimPath, "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    // Every command the action and the workflows call by name has to be there.
    // Help text that lists none of them is a CLI that parsed nothing.
    const missing = ["review", "learn", "doctor", "init"].filter(
      (command) => !stdout.includes(command),
    );
    if (missing.length > 0) {
      throw new Error(
        "CLI invoked through a bin-shim symlink did not advertise: " +
          `${missing.join(", ")} — either the entry guard is not recognising ` +
          "the shim and every npx invocation is a silent no-op, or a command " +
          "CI depends on has been removed.",
      );
    }
  } catch (error) {
    if (error.status !== undefined || error.stdout !== undefined) {
      throw new Error(
        `CLI invoked through a bin-shim symlink failed (exit ${error.status}): ` +
          `${String(error.stdout || "")}${String(error.stderr || "")}`.trim(),
      );
    }
    throw error;
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }

  console.log("  ✅ bin-shim invocation produces real output");
  return true;
}

function validateDependencies() {
  console.log("📚 Validating dependencies...");

  // pnpm is the declared package manager (package.json `packageManager`), so
  // pnpm-lock.yaml is the lock file CI restores from. A package-lock.json here
  // would mean two resolvers disagreeing about the same tree.
  const pnpmLockPath = path.join(process.cwd(), "pnpm-lock.yaml");
  if (!fs.existsSync(pnpmLockPath)) {
    console.log("⚠️ Warning: No pnpm-lock.yaml found");
  }
  if (fs.existsSync(path.join(process.cwd(), "package-lock.json"))) {
    console.log(
      "⚠️ Warning: package-lock.json is present alongside pnpm — the two lock " +
        "files will resolve differently",
    );
  }

  // Check node_modules exists
  const nodeModulesPath = path.join(process.cwd(), "node_modules");
  if (!fs.existsSync(nodeModulesPath)) {
    throw new Error(
      "node_modules directory not found. Run pnpm install first.",
    );
  }

  console.log("✅ Dependencies validation - PASSED");
  return true;
}

function main() {
  console.log("🏗️ Running comprehensive build validation...");
  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );

  // Order matters: the build has to have happened before anything inspects or
  // executes dist/, and the e2e suites drive dist/ rather than src/, so they run
  // last of all.
  const validations = [
    // Package.json validation
    () => validatePackageJson(),

    // Dependencies validation
    () => validateDependencies(),

    // TypeScript compilation — both projects (src and test)
    () => runCommand("pnpm run type-check", "TypeScript compilation check"),

    // ESLint validation
    () => runCommand("pnpm run lint", "ESLint validation"),

    // Build validation
    () => runCommand("pnpm run build", "Production build"),

    // Action manifest validation
    () => validateActionManifest(),

    // Build output validation
    () => validateBuildOutput(),

    // The CLI must work through the bin shim — how npx and the action invoke it
    () => validateCliThroughBinShim(),

    // Test execution
    () => runCommand("pnpm run test", "Test execution"),
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

  console.log(
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  );
  console.log("📊 Build Validation Summary:");

  results.forEach(({ step, success, error }) => {
    const status = success ? "✅" : "❌";
    const message = success ? "PASSED" : `FAILED: ${error}`;
    console.log(`  ${status} Step ${step}: ${message}`);
  });

  if (allPassed) {
    console.log("\n🎉 All build validations passed!");
    console.log("✅ Project is ready for production deployment");
    process.exit(0);
  } else {
    console.log("\n❌ Build validation failed");
    console.log("🔧 Please fix the issues above before proceeding");
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  validatePackageJson,
  validateActionManifest,
  validateBuildOutput,
  validateCliThroughBinShim,
  validateDependencies,
};
