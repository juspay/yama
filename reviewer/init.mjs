/**
 * Yama init — scaffold the agent structure into a project directory.
 * Never overwrites: existing files are skipped, so re-running is harmless.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const CONFIG_JSON = `{
  "provider": "<your-provider e.g. litellm | vertex | openai | anthropic>",
  "model": "<your-model>",
  "temperature": 0.7,
  "maxSteps": 25,
  "userId": "<project-id e.g. repo name>",
  "systemPrompt": "You are an agent working in this repository. Use your tools, skills and memory to complete the task. Be concise.",
  "timeouts": {
    "requestTimeoutMs": 120000,
    "turnTimeoutMs": 300000,
    "stallTimeoutMs": 90000
  },
  "compaction": {
    "enabled": true,
    "threshold": 0.8
  },
  "summarization": {
    "provider": "<your-provider>",
    "model": "<your-model>"
  },
  "memory": {
    "path": "memory/hippocampus.sqlite",
    "maxWords": 500,
    "flushWaitMs": 20000
  },
  "skills": {
    "path": "skills",
    "discovery": "tool"
  },
  "delegation": {
    "enabled": true,
    "maxConcurrent": 2
  },
  "generateOptions": {}
}
`;

const MCP_JSON = `{
  "servers": {
    "code-review-graph": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["--from", "code-review-graph==2.3.7", "code-review-graph", "serve"],
      "description": "Tree-sitter code graph — blast radius, callers/dependents, flows, architecture overview",
      "timeout": 60000
    }
  }
}
`;

const PROMPTS_JSON = `{
  "prompts": [
    {
      "prompt": "You are reviewing pull request \${pr} on branch \${branch}. Load the project guidelines skill, then gather the changed files and understand the change.",
      "maxSteps": 15
    },
    "Review the change against the guidelines. List concrete findings with file and line references.",
    "Write a final review summary ending with a verdict line: VERDICT: APPROVE or VERDICT: NEEDS_WORK."
  ]
}
`;

const GUIDELINES_SKILL = `---
name: guidelines
description: Project guidelines and rules. Load before reviewing or changing anything in this repository.
---

# Project guidelines

Replace these with your project's real rules. Files placed beside this
SKILL.md become on-demand resources the agent can read with
read_skill_resource — reference them here so the agent knows when to fetch them.

1. <rule one>
2. <rule two>
3. <rule three>
`;

const ENV_EXAMPLE = `# Credentials for whichever provider(s) config.json names.
# LITELLM_BASE_URL=
# LITELLM_API_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GOOGLE_APPLICATION_CREDENTIALS=
# GOOGLE_CLOUD_PROJECT_ID=
# GOOGLE_VERTEX_LOCATION=
`;

const FILES = {
  "config.json": CONFIG_JSON,
  "MCP.json": MCP_JSON,
  "prompts.json": PROMPTS_JSON,
  "skills/guidelines/SKILL.md": GUIDELINES_SKILL,
  "memory/.gitkeep": "",
  ".env.example": ENV_EXAMPLE,
};

export function runInit(targetDir) {
  console.log(`Yama init → ${targetDir}\n`);
  for (const [relPath, content] of Object.entries(FILES)) {
    const fullPath = path.join(targetDir, relPath);
    if (existsSync(fullPath)) {
      console.log(`  · ${relPath} (exists, skipped)`);
      continue;
    }
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    console.log(`  ✔ ${relPath}`);
  }
  console.log(`
Next steps:
  1. Fill provider/model in config.json (arrays give a 1:1 fallback chain).
  2. Put credentials in .env (see .env.example).
  3. Edit skills/guidelines/SKILL.md with your project's rules.
  4. Adjust prompts.json, then run:
       yama run pr=123 branch=main     (batch — one prompt after another)
       yama                            (interactive REPL)
`);
}
