#!/usr/bin/env node

// Backward-compatible entrypoint.
import program, { setupCLI } from "./cli.js";

export { setupCLI, program as default };

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = setupCLI();
  cli.parse(process.argv);
}
