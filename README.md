# ⚔️ Yama - AI-Native Code Review Guardian

> **Enterprise-grade autonomous code review powered by AI and MCP tools**

[![Version](https://img.shields.io/npm/v/@juspay/yama.svg)](https://www.npmjs.com/package/@juspay/yama)
[![License](https://img.shields.io/npm/l/@juspay/yama.svg)](https://github.com/juspay/yama/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)

**Named after the Hindu deity of justice and death, Yama judges code quality and ensures only the worthy changes pass through.**

## Architecture

| Aspect               | Legacy                 | Current                                                        |
| -------------------- | ---------------------- | -------------------------------------------------------------- |
| **Architecture**     | Coded orchestration    | AI autonomous orchestration                                    |
| **VCS Integration**  | Direct handler imports | Config-driven MCP servers (`mcpServers.servers.*`)             |
| **Context Strategy** | Pre-fetch everything   | Lazy load on-demand                                            |
| **AI Role**          | Static analyzer        | Autonomous agent with tools                                    |
| **Decision Making**  | TypeScript code        | AI reports an advisory verdict; final decision is code-derived |
| **Tool Access**      | None                   | All operations via MCP                                         |
| **File Analysis**    | All at once in prompt  | File-by-file AI loop                                           |
| **Comment Posting**  | Batch after analysis   | Gated by `submit_review` (dedup + critic verification)         |
| **PR Blocking**      | Manual logic           | Deterministic policy: any CRITICAL or 3+ MAJOR findings block  |

## Architecture Overview

```
YamaOrchestrator
    ↓
MemoryManager (per-repo condensed memory)
    ↓
NeuroLink AI Agent (Autonomous)
    ↓
MCP Tools (config-defined: Bitbucket / GitHub / Serena / local-git / custom)
    ↓
Pull Request Operations
```

### AI Autonomous Workflow

1. **Context Gathering** (AI-driven)
   - Reads per-repo memory (past review learnings)
   - Reads PR details
   - Loads project standards from memory-bank
   - Reads .clinerules for review guidelines

2. **File-by-File Analysis** (AI-driven)
   - Reads each file diff individually
   - Searches code for context when needed
   - Reads reference files to understand patterns
   - Submits candidate findings through the `submit_review` gate (dedup + verification) before posting

3. **PR Description Enhancement** (AI-driven)
   - Analyzes changes and requirements
   - Generates comprehensive description
   - Updates PR with enhanced content

4. **Final Decision** (code-derived)
   - The AI reports an advisory decision alongside its findings
   - `deriveDecision` enforces the blocking criteria deterministically
   - A partial (truncated) review can never end APPROVED

## Installation & Setup

### 1. Prerequisites

```bash
# Node.js 20.18.1+ required
node --version

# Install Yama
npm install @juspay/yama
```

### 2. Environment Variables

Create a `.env` file:

```bash
# Bitbucket
BITBUCKET_USERNAME=your.email@company.com
BITBUCKET_TOKEN=your-http-access-token
BITBUCKET_BASE_URL=https://bitbucket.yourcompany.com

# GitHub (when reviewing GitHub PRs) — first match wins:
# YAMA_GITHUB_TOKEN → GITHUB_TOKEN → GH_TOKEN → GITHUB_PERSONAL_ACCESS_TOKEN → GITHUB_ACCESS_TOKEN
YAMA_GITHUB_TOKEN=your-github-token

# AI Provider (optional - defaults to auto)
AI_PROVIDER=google-ai
AI_MODEL=gemini-2.5-pro

# Opt in to project-level MCP config (.yama/mcp.json + .yama/mcp.d/*.json)
YAMA_ENABLE_PROJECT_MCP=true

# Langfuse Observability (optional)
LANGFUSE_PUBLIC_KEY=your-public-key
LANGFUSE_SECRET_KEY=your-secret-key
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

For the GitHub composite Action setup, see [GITHUB_SETUP.md](GITHUB_SETUP.md).

### 3. Initialize Configuration

```bash
# Create a starter config (also scaffolds an example rule in .yama/rules/)
npx yama init

# Preferred location: .yama/config.yaml
mkdir -p .yama && cp yama.config.example.yaml .yama/config.yaml

# Edit configuration
vim .yama/config.yaml
```

Yama resolves the config from `.yama/config.yaml` first; the legacy root
`yama.config.yaml` and `config/yama.config.yaml` locations still load, with a
deprecation warning. When upgrading from an older version, see
[MIGRATION.md](MIGRATION.md).

### 4. Verify Setup

```bash
# Validate the config and report the capability profile
npx yama doctor --config .yama/config.yaml
```

`yama doctor` lists every configured MCP server (transport, roles, modes, tool
policy) and warns when a mode has no review-role servers — in that case the
reviewer has no tools and reviews degrade to dry-run analysis.

## Usage

### Basic Review

```bash
# Review by PR ID
npx yama review \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --pr 123

# Review by branch
npx yama review \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --branch feature/new-feature

# Review a GitHub PR
npx yama review --owner your-org --repo my-repo --pr 123
```

Useful flags (both providers):

- `--review-only` — skip description enhancement, only review code
- `--focus <areas>` — comma-separated review focus areas
- `--prompt <text>` — additional review instruction

### Dry Run Mode

```bash
# Test without posting comments
npx yama review \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --pr 123 \
  --dry-run
```

### Enhance Description Only

```bash
npx yama enhance \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --pr 123
```

### Learn from a Merged PR

```bash
npx yama learn \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --pr 123

# GitHub: npx yama learn --owner your-org --repo my-repo --pr 123
```

Extracts learnings from a merged PR into the knowledge base
(`.yama/knowledge-base.md` by default; `--output` overrides, `--commit`
auto-commits the change).

### Programmatic Usage

```typescript
import { createYama } from "@juspay/yama";

const yama = createYama();

await yama.initialize();

const result = await yama.startReview({
  workspace: "YOUR_WORKSPACE",
  repository: "my-repo",
  pullRequestId: 123,
  dryRun: false,
});

console.log("Decision:", result.decision);
console.log("Issues:", result.statistics.issuesFound);
```

### Local SDK Mode (No PR Provider Required)

Local mode reviews a git diff (staged, uncommitted, or a ref range) without any
PR provider — the diff is read directly from the repository, so no Bitbucket or
GitHub credentials are needed. Tools are config-driven like everything else: no
MCP server is registered from code, and the defaults ship zero servers. Enable
a `local-git` server entry (see
[yama.config.example.yaml](yama.config.example.yaml)) to give the agent
read-only git inspection; without one the review still runs on the raw diff,
but the agent has no tools — `yama doctor` reports this as degrading to
dry-run analysis.

```typescript
import { createYama } from "@juspay/yama";

const yama = createYama();

const result = await yama.reviewLocalDiff({
  mode: "local",
  repoPath: process.cwd(),
  diffSource: "staged", // staged | uncommitted | range
  focus: ["Security Analysis", "Code Quality"],
  prompt: "Prioritize correctness and edge cases",
  outputSchemaVersion: "1.0",
});

console.log(result.decision);
console.log(result.issues);
```

SDK override example (no config file edit needed):

```typescript
const yama = createYama({
  configOverrides: {
    ai: {
      provider: "anthropic",
      model: "claude-sonnet-5",
    },
  },
});
```

Precedence in SDK mode:
`configOverrides` > config file > environment variables > defaults

CLI local mode:

```bash
npx yama review --mode local --repo-path . --diff-source staged
```

## Configuration

### Basic Configuration

```yaml
version: 2
configType: "yama"

ai:
  provider: "auto"
  model: "gemini-2.5-pro"
  temperature: 0.2

# Every MCP server is a config entry — nothing is hardcoded in Yama.
mcpServers:
  servers:
    bitbucket:
      enabled: true
      transport: stdio
      command: npx
      args: ["-y", "@nexus2520/bitbucket-mcp-server@latest"]
      env:
        BITBUCKET_USERNAME: ${BITBUCKET_USERNAME}
        BITBUCKET_TOKEN: ${BITBUCKET_TOKEN}
        BITBUCKET_BASE_URL: ${BITBUCKET_BASE_URL}
      roles: [review, explore]
      modes: [pr]
      # Destructive tools the review flow never needs.
      blockedTools:
        - merge_pull_request
        - decline_pull_request
        - delete_branch
        - delete_comment
        - create_pull_request

review:
  enabled: true
  verification: basic # off | basic | strict — critic pass before findings post
  focusAreas:
    - name: "Security Analysis"
      priority: "CRITICAL"
    - name: "Performance Review"
      priority: "MAJOR"
```

Note: the legacy flat shape (`mcpServers.bitbucket: ...`) is rejected at
startup with a migration error — server definitions live under
`mcpServers.servers.<id>`. See [MIGRATION.md](MIGRATION.md).

### Advanced Configuration

See [yama.config.example.yaml](yama.config.example.yaml) for complete
configuration options (GitHub, Serena, local-git servers, cross-run state,
loop guards), and this repo's own [.yama/config.yaml](.yama/config.yaml) for a
live example.

## Project-Specific Standards

Create custom review standards for your repository:

```bash
mkdir -p memory-bank
```

Create `memory-bank/coding-standards.md`:

```markdown
# Project-Specific Review Standards

## Critical Security Rules

1. ALL payment data MUST be encrypted
2. NO credit card numbers in logs
3. ALL database queries MUST use parameterized statements

## Performance Requirements

- API response time: < 200ms p95
- Database queries: < 50ms p95
```

Yama AI will automatically read and apply these standards.

## AI Autonomous Features

### Lazy Context Loading

AI reads only what it needs:

- Sees unfamiliar function? → `search_code("functionName")`
- Needs to understand import? → `get_file_content("path/to/file.ts")`
- Confused about structure? → `list_directory_content("src/")`

### Verified, Deduplicated Findings

Every candidate finding passes the `submit_review` gate before it may be posted:

- Deterministic dedup against cross-run state, this run's findings, and auto-suppressions
- A critic verification pass (`review.verification`: `off` | `basic` | `strict`, default `basic`) rejects incoherent, inflated, or evidence-free findings; `strict` additionally requires code evidence
- Severity-based emojis (🔒 CRITICAL, ⚠️ MAJOR, 💡 MINOR, 💬 SUGGESTION)
- Actionable suggestions with code examples

### Incremental Reviews (Cross-Run State)

Re-reviewing the same PR is incremental:

- Previously-reported findings are never re-posted
- Findings the agent verifies as fixed are marked resolved
- Findings ignored for 3+ consecutive runs are auto-suppressed as learned false positives
- Configure via `state` (`store`: `file` | `inline` | `github-artifact` | `jenkins-artifact`; default: `file` at `.yama/state`) — see [yama.config.example.yaml](yama.config.example.yaml)

### Team Rules

Structured team rules live in `.yama/rules/**` (YAML or JSON; one rule per
file, or a `rules:` array). Findings cite a rule by id; a violated
`blocking: true` rule forces the verdict to BLOCKED, advisory rules are
enforced with proportionate severity. `npx yama init` scaffolds an example
rule.

### Code Context Understanding

AI uses tools to understand code:

- `search_code()` - Find function definitions
- `get_file_content()` - Read related files
- `list_directory_content()` - Explore structure

### Per-Repo Memory

AI learns from past reviews and remembers across PRs:

- Reads condensed memory before each review for context
- Writes learnings after PR merge (false positives, missed issues, team conventions)
- LLM-powered condensation keeps memory within a configurable word limit
- Per-repo isolation — each repository gets independent memory keyed by `workspace-repository`
- Storage as `.md` files at configurable path (e.g., `memory-bank/yama/memory/`)
- Environment variable overrides for all settings (`YAMA_MEMORY_ENABLED`, `YAMA_MEMORY_MAX_WORDS`, etc.)

## Blocking Criteria

The verdict is code-derived, never model-trusted: the AI's reported decision is
advisory, and `deriveDecision` (`src/v2/core/reviewDecision.ts`) enforces the
blocking policy deterministically — a prompt-injected "approve" can never clear
blocking findings.

1. **ANY CRITICAL issue** → BLOCKS PR
   - Security vulnerabilities
   - Data loss risks
   - Authentication bypasses

2. **3+ MAJOR issues** → BLOCKS PR
   - Significant bugs
   - Performance problems
   - Logic errors

3. **Violated blocking team rule** → BLOCKS PR (see Team Rules above)

4. **Partial review** (step cap, timeout, truncated output) → can never end APPROVED

## MCP Servers

Every MCP server — Bitbucket, GitHub, Serena, local-git, or any custom server —
is a config entry under `mcpServers.servers.*`; nothing is hardcoded. Each
entry declares:

- `roles`: which agents get the server (`review` / `explore`)
- `modes`: which review modes it applies to (`pr` / `local`)
- `blockedTools`: denylist — hide these tool names from the agent
- `allowedTools`: fail-closed allowlist — only these tools are exposed; if the
  server's tools cannot be discovered, registration fails rather than running
  with an unenforced allowlist

See [yama.config.example.yaml](yama.config.example.yaml) for ready-made
Bitbucket, GitHub, Serena, and local-git definitions. Projects can also ship
server definitions in `.yama/mcp.json` (plus `.yama/mcp.d/*.json` drop-ins),
gated behind `YAMA_ENABLE_PROJECT_MCP=true`.

## Monitoring & Analytics

Track review performance with Langfuse integration:

```bash
# Set Langfuse environment variables
export LANGFUSE_PUBLIC_KEY=your-public-key
export LANGFUSE_SECRET_KEY=your-secret-key
```

Analytics include:

- Tool calls made
- Token usage
- Cost estimate
- Duration
- Decision rationale

## Troubleshooting

### MCP Server Connection Issues

```bash
# First stop: validate config + capability profile
npx yama doctor --config .yama/config.yaml

# Verify environment variables
echo $BITBUCKET_USERNAME
echo $BITBUCKET_TOKEN
echo $BITBUCKET_BASE_URL
```

### AI Not Finding Issues

- Check `focusAreas` in config
- Verify `blockingCriteria` are clear
- Ensure `temperature` is low (0.2-0.3)
- Review project-specific standards in memory-bank

### High Token Usage

- Enable `lazyLoading: true` in config
- Reduce `maxFilesPerReview`
- Set `maxToolCallsPerFile` limit
- Use `excludePatterns` to skip generated files

## Performance

### Expected Metrics

| Metric          | Target                |
| --------------- | --------------------- |
| Review time     | < 10 min for 20 files |
| Token usage     | < 500K per review     |
| Cost per review | < $2 USD              |
| Accuracy        | > 95% of V1 findings  |

### Optimization Tips

1. **Use lazy loading** - Don't pre-fetch everything
2. **Cache tool results** - Reuse MCP responses
3. **Exclude generated files** - Skip lock files, minified code
4. **Limit file count** - Split large PRs

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

## Support

- **Documentation**: [GitHub Wiki](https://github.com/juspay/yama/wiki)
- **GitHub Action setup**: [GITHUB_SETUP.md](GITHUB_SETUP.md)
- **Upgrading**: [MIGRATION.md](MIGRATION.md)
- **Issues**: [GitHub Issues](https://github.com/juspay/yama/issues)
- **Discussions**: [GitHub Discussions](https://github.com/juspay/yama/discussions)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**⚔️ Built with ❤️ by Juspay • Powered by AI & MCP • Autonomous Code Quality Justice**
