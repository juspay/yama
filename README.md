# ⚔️ Yama - AI-Native Code Review Guardian

> **Enterprise-grade autonomous code review powered by AI and MCP tools**

[![Version](https://img.shields.io/npm/v/@juspay/yama.svg)](https://www.npmjs.com/package/@juspay/yama)
[![License](https://img.shields.io/npm/l/@juspay/yama.svg)](https://github.com/juspay/yama/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)

**Named after the Hindu deity of justice and death, Yama judges code quality and ensures only the worthy changes pass through.**

## What's New in V2?

Yama V2 represents a **complete architectural shift** from coded orchestration to **AI-native autonomous orchestration**:

| Aspect                    | V1                     | V2                            |
| ------------------------- | ---------------------- | ----------------------------- |
| **Architecture**          | Coded orchestration    | AI autonomous orchestration   |
| **Bitbucket Integration** | Direct handler imports | External MCP server           |
| **Context Strategy**      | Pre-fetch everything   | Lazy load on-demand           |
| **AI Role**               | Static analyzer        | Autonomous agent with tools   |
| **Decision Making**       | TypeScript code        | AI decides                    |
| **Tool Access**           | None                   | All operations via MCP        |
| **File Analysis**         | All at once in prompt  | File-by-file AI loop          |
| **Jira Integration**      | None                   | MCP tools for requirements    |
| **Comment Posting**       | Batch after analysis   | Real-time as found            |
| **PR Blocking**           | Manual logic           | AI decision based on criteria |

## Architecture Overview

```
YamaV2Orchestrator
    ↓
NeuroLink AI Agent (Autonomous)
    ↓
MCP Tools (Bitbucket + Jira)
    ↓
Pull Request Operations
```

### AI Autonomous Workflow

1. **Context Gathering** (AI-driven)
   - Reads PR details
   - Finds and reads Jira ticket
   - Loads project standards from memory-bank
   - Reads .clinerules for review guidelines

2. **File-by-File Analysis** (AI-driven)
   - Reads each file diff individually
   - Searches code for context when needed
   - Reads reference files to understand patterns
   - Comments on issues immediately

3. **PR Description Enhancement** (AI-driven)
   - Analyzes changes and requirements
   - Generates comprehensive description
   - Updates PR with enhanced content

4. **Final Decision** (AI-driven)
   - Evaluates all findings
   - Applies blocking criteria
   - Approves or blocks PR

## Installation & Setup

### 1. Prerequisites

```bash
# Node.js 18+ required
node --version

# Install Yama V2
npm install @juspay/yama@2.0.0
```

### 2. Environment Variables

Create a `.env` file:

```bash
# Bitbucket
BITBUCKET_USERNAME=your.email@company.com
BITBUCKET_APP_PASSWORD=your-http-access-token
BITBUCKET_BASE_URL=https://bitbucket.yourcompany.com

# Jira (optional)
JIRA_EMAIL=your-email@company.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_BASE_URL=https://yourcompany.atlassian.net

# AI Provider (optional - defaults to auto)
AI_PROVIDER=google-ai
AI_MODEL=gemini-2.5-pro

# Langfuse Observability (optional)
LANGFUSE_PUBLIC_KEY=your-public-key
LANGFUSE_SECRET_KEY=your-secret-key
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

### 3. Initialize Configuration

```bash
# Create default config
npx yama init

# Or copy example
cp yama.config.example.yaml yama.config.yaml

# Edit configuration
vim yama.config.yaml
```

### 4. Verify Setup

```bash
# Test initialization
npx yama review --help
```

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
```

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

### Programmatic Usage

```typescript
import { createYamaV2 } from "@juspay/yama";

const yama = createYamaV2();

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

## Configuration

### Basic Configuration

```yaml
version: 2
configType: "yama-v2"

ai:
  provider: "auto"
  model: "gemini-2.5-pro"
  temperature: 0.2

mcpServers:
  jira:
    enabled: true

review:
  enabled: true
  focusAreas:
    - name: "Security Analysis"
      priority: "CRITICAL"
    - name: "Performance Review"
      priority: "MAJOR"
```

### Advanced Configuration

See [yama.config.example.yaml](yama.config.example.yaml) for complete configuration options.

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

Yama V2 AI will automatically read and apply these standards.

## AI Autonomous Features

### Lazy Context Loading

AI reads only what it needs:

- Sees unfamiliar function? → `search_code("functionName")`
- Needs to understand import? → `get_file_content("path/to/file.ts")`
- Confused about structure? → `list_directory_content("src/")`

### Real-Time Feedback

AI comments as it finds issues:

- No batching - immediate feedback
- Severity-based emojis (🔒 CRITICAL, ⚠️ MAJOR, 💡 MINOR, 💬 SUGGESTION)
- Actionable suggestions with code examples

### Requirement Alignment

AI reads Jira tickets:

- Extracts acceptance criteria
- Verifies implementation matches requirements
- Calculates requirement coverage
- Blocks PR if coverage < 70%

### Code Context Understanding

AI uses tools to understand code:

- `search_code()` - Find function definitions
- `get_file_content()` - Read related files
- `list_directory_content()` - Explore structure

## Blocking Criteria

AI applies these criteria automatically:

1. **ANY CRITICAL issue** → BLOCKS PR
   - Security vulnerabilities
   - Data loss risks
   - Authentication bypasses

2. **3+ MAJOR issues** → BLOCKS PR
   - Significant bugs
   - Performance problems
   - Logic errors

3. **Requirement coverage < 70%** → BLOCKS PR (when Jira enabled)
   - Incomplete Jira implementation
   - Missing acceptance criteria

## MCP Servers

Yama V2 uses MCP (Model Context Protocol) servers for tool access:

### Bitbucket MCP

- **Package**: `@anthropic/bitbucket-mcp-server`
- **Tools**: get_pull_request, add_comment, search_code, etc.
- **Status**: Production ready

### Jira MCP

- **Package**: `@nexus2520/jira-mcp-server`
- **Tools**: get_issue, search_issues, get_issue_comments
- **Status**: Optional integration

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
# Verify environment variables
echo $BITBUCKET_USERNAME
echo $BITBUCKET_APP_PASSWORD
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

## Migration from V1

**Breaking Change**: V1 has been completely replaced by V2. There is no backward compatibility.

### Automated Config Migration

Use the built-in migration script to convert your V1 config to V2 format:

```bash
# Rename your current config to V1
mv yama.config.yaml yama.v1.config.yaml

# Run migration (dry-run first to preview)
npx yama migrate-config --dry-run

# Run actual migration
npx yama migrate-config

# Or with custom paths
npx yama migrate-config \
  --input yama.v1.config.yaml \
  --output yama.config.yaml \
  --force
```

The migration script will:

- ✅ Migrate AI provider settings
- ✅ Convert focus areas to structured format
- ✅ Transform required sections with descriptions
- ✅ Apply V2 defaults for new features
- ⚠️ Warn about dropped V1 features (batchProcessing, multiInstance, etc.)
- 📊 Generate a detailed migration report

### V1 → V2 Migration Steps

1. **Migrate configuration** (automated):

```bash
npx yama migrate-config
```

2. **Update imports**:

```typescript
// V1 (removed)
// import { Guardian } from "@juspay/yama";

// V2 (use this)
import { createYamaV2 } from "@juspay/yama";
const yama = createYamaV2();
```

3. **Set environment variables**: V2 uses MCP servers configured via env vars

```bash
# Bitbucket (required)
export BITBUCKET_USERNAME=your.email@company.com
export BITBUCKET_APP_PASSWORD=your-http-access-token
export BITBUCKET_BASE_URL=https://bitbucket.yourcompany.com

# Jira (optional)
export JIRA_EMAIL=your-email@company.com
export JIRA_API_TOKEN=your-jira-api-token
export JIRA_BASE_URL=https://yourcompany.atlassian.net
```

4. **Test thoroughly**: V2 uses autonomous AI orchestration - validate behavior in dry-run mode first

```bash
npx yama review --workspace YOUR_WORKSPACE --repository my-repo --pr 123 --dry-run
```

### What Gets Migrated

| V1 Section                        | V2 Section               | Notes                    |
| --------------------------------- | ------------------------ | ------------------------ |
| `providers.ai`                    | `ai`                     | Direct mapping           |
| `features.codeReview`             | `review`                 | Restructured             |
| `features.descriptionEnhancement` | `descriptionEnhancement` | Restructured             |
| `monitoring`                      | `monitoring`             | Enhanced                 |
| `rules`                           | `projectStandards`       | Converted to focus areas |

### What Gets Dropped

These V1 features are **removed** in V2 (AI handles autonomously):

- `providers.git` → Use environment variables
- `features.codeReview.batchProcessing` → AI manages batching
- `features.codeReview.multiInstance` → Single autonomous agent
- `features.codeReview.semanticDeduplication` → AI deduplicates naturally
- `features.securityScan` → Built into AI prompts
- `cache` → MCP tools handle caching

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

## Support

- **Documentation**: [GitHub Wiki](https://github.com/juspay/yama/wiki)
- **Issues**: [GitHub Issues](https://github.com/juspay/yama/issues)
- **Discussions**: [GitHub Discussions](https://github.com/juspay/yama/discussions)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**⚔️ Built with ❤️ by Juspay • Powered by AI & MCP • Autonomous Code Quality Justice**
