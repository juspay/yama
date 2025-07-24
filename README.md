# ⚔️ Yama

> **Enterprise-grade Pull Request automation toolkit with AI-powered code review and description enhancement**

[![Version](https://img.shields.io/npm/v/@juspay/yama.svg)](https://www.npmjs.com/package/@juspay/yama)
[![License](https://img.shields.io/npm/l/@juspay/yama.svg)](https://github.com/juspay/yama/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)

## 🎯 **What is Yama?**

Yama is the **code quality judge** that combines and optimizes the functionality from pr-police.js and pr-describe.js into a unified, enterprise-grade toolkit. It provides **AI-powered code review** and **intelligent description enhancement** with **90% fewer API calls** through unified context gathering.

**Named after the Hindu deity of justice and death, Yama judges code quality and ensures only the worthy changes pass through.**

---

## ✨ **Core Features**

### 🔍 **AI-Powered Code Review**
- **🔒 Security Analysis**: SQL injection, XSS, hardcoded secrets detection
- **⚡ Performance Review**: N+1 queries, memory leaks, algorithm efficiency  
- **🏗️ Code Quality**: SOLID principles, maintainability, best practices
- **💬 Smart Comments**: Contextual inline comments with actionable suggestions
- **📊 Severity Levels**: CRITICAL, MAJOR, MINOR, SUGGESTION with intelligent categorization

### 📝 **Intelligent Description Enhancement**
- **📎 Content Preservation**: Never removes screenshots, links, or existing explanations
- **📋 Required Sections**: Configurable sections (Changelog, Test Cases, Config Changes, etc.)
- **🤖 AI Enhancement**: Automatically improves incomplete descriptions while preserving content
- **🧠 Project Context**: Uses memory-bank and .clinerules for contextual enhancement

### 🚀 **Unified Context System** (Core Innovation)
- **⚡ One-Time Gathering**: Collect all PR context once, reuse across all operations
- **🧠 Smart Diff Strategy**: Automatically chooses whole diff vs file-by-file based on PR size
- **💾 Intelligent Caching**: 90% reduction in API calls through multi-layer caching
- **📦 Batch Processing**: Process large PRs efficiently with intelligent file batching

### 🏗️ **Enterprise Ready**
- **🌐 Multi-Platform**: Bitbucket Server (Phase 1), GitHub/GitLab (Future phases)
- **📘 Full TypeScript**: Complete type safety and excellent developer experience
- **⚙️ Highly Configurable**: YAML/JSON configuration with validation and hot-reload
- **🛠️ CLI + API**: Use as command-line tool or programmatic library

---

## 🚀 **Performance Benefits**

| Metric | Individual Scripts | Yama | Improvement |
|--------|-------------------|------|-------------|
| **API Calls** | ~50-100 per operation | ~10-20 total | **90% reduction** |
| **Execution Time** | 3-5 minutes each | 2-3 minutes total | **3x faster** |
| **Memory Usage** | High duplication | Shared context | **50% reduction** |
| **Cache Efficiency** | None | 80-90% hit ratio | **New capability** |
| **Large PRs (40+ files)** | Often fails/timeouts | Intelligent batching | **Reliable processing** |

---

## 📦 **Installation**

```bash
# Install globally for CLI usage
npm install -g @juspay/yama

# Or install locally for programmatic usage
npm install @juspay/yama
```

---

## ⚡ **Quick Start**

### **1. Initialize Configuration**
```bash
# Interactive setup
yama init --interactive

# Quick setup with defaults
yama init
```

### **2. Basic Usage**

#### **Unified Processing (Recommended)**
```bash
# Process PR with both review and description enhancement
yama process --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth

# Process specific operations
yama process --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth --operations review,enhance
```

#### **Individual Operations**
```bash
# Code review only
yama review --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth

# Description enhancement only  
yama enhance --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth
```

#### **Backward Compatibility**
```bash
# Still works exactly like pr-police.js
yama police --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth

# Still works exactly like pr-describe.js / pr-scribe.js
yama scribe --workspace YOUR_WORKSPACE --repository my-repo --branch feature/auth
```

---

## 🔧 **Advanced Configuration**

### **File Exclusion Patterns**
```bash
# Exclude specific file types and directories
yama process \
  --workspace YOUR_WORKSPACE \
  --repository my-repo \
  --branch feature/auth \
  --exclude "*.lock,*.svg,*.min.js,dist/**,node_modules/**,coverage/**"

# Different exclusions for different operations
yama review --exclude "*.lock,*.svg,**/*.test.js"
yama enhance --exclude "*.md"  # Don't process existing markdown files
```

### **Context and Performance Tuning**
```bash
# More context lines for better AI analysis
yama review --context-lines 5 --exclude "*.lock"

# Dry run to preview changes
yama process --dry-run --verbose

# Force cache refresh
yama process --force-refresh
```

---

## ⚙️ **Configuration File**

Create `yama.config.yaml` in your project root:

```yaml
# AI Provider Configuration  
ai:
  provider: "auto"  # auto, google-ai, openai, anthropic
  enableFallback: true
  enableAnalytics: true
  timeout: "5m"
  temperature: 0.7

# Git Platform Configuration
git:
  platform: "bitbucket"
  credentials:
    username: "${BITBUCKET_USERNAME}"
    token: "${BITBUCKET_TOKEN}"
    baseUrl: "https://your-bitbucket-server.com"
  defaultWorkspace: "${DEFAULT_WORKSPACE}"

# Feature Configuration
features:
  codeReview:
    enabled: true
    severityLevels: ["CRITICAL", "MAJOR", "MINOR", "SUGGESTION"]
    excludePatterns: 
      - "*.lock"
      - "*.svg"
      - "*.min.js"
      - "node_modules/**"
      - "dist/**"
      - "build/**"
      - "coverage/**"
    contextLines: 3
    
    # Custom AI Prompts for Code Review (Advanced)
    systemPrompt: |
      You are an Expert Security Code Reviewer focusing on enterprise standards.
      Prioritize security vulnerabilities, performance issues, and code quality.
      Provide actionable feedback with specific examples and solutions.
    
    focusAreas:
      - "🔒 Security Analysis (CRITICAL PRIORITY)"
      - "⚡ Performance Review" 
      - "🏗️ Code Quality & Best Practices"
      - "🧪 Testing & Error Handling"
      - "📖 Documentation & Maintainability"
    
  descriptionEnhancement:
    enabled: true
    preserveContent: true  # NEVER remove existing content
    requiredSections:
      # Default sections
      - key: "changelog"
        name: "📋 Changelog (Modules Modified)"
        required: true
        
      - key: "testcases"
        name: "🧪 Test Cases (What to be tested)"
        required: true
        
      - key: "config_changes"
        name: "⚙️ Config Changes (CAC/Service Config)"
        required: true
        
      # Optional custom sections
      - key: "breaking_changes"
        name: "⚠️ Breaking Changes"
        required: false
        
      - key: "migration_notes"
        name: "🔄 Migration Notes"
        required: false
        
      - key: "performance_impact"
        name: "⚡ Performance Impact"
        required: false
        
      - key: "security_considerations"
        name: "🔒 Security Considerations"
        required: false
    
    # Custom AI Prompts and Templates (Advanced)
    systemPrompt: |
      You are an Expert Technical Writer specializing in pull request documentation.
      Focus on clarity, completeness, and helping reviewers understand the changes.
      CRITICAL: Return ONLY the enhanced description without meta-commentary.
    
    enhancementInstructions: |
      Return ONLY the enhanced PR description as clean markdown.
      Start directly with the enhanced description content.
    
    outputTemplate: |
      # {{PR_TITLE}}
      
      ## Summary
      [Clear overview of what this PR accomplishes]
      
      ## Changes Made
      [Specific technical changes with file references]
      
      ## Testing Strategy
      [How changes were tested and validated]
      
      ## Impact & Considerations
      [Business impact, performance implications, breaking changes]

# Performance Configuration
cache:
  enabled: true
  ttl: "1h"
  maxSize: "100mb"
  storage: "memory"

# Monitoring and Analytics
monitoring:
  enabled: true
  metrics: ["performance", "cache", "api_calls"]
```

---

## 🤖 **Programmatic Usage**

### **Basic Setup**
```typescript
import { Guardian, createGuardian } from '@juspay/yama';

// Create Guardian instance
const guardian = createGuardian({
  providers: {
    ai: {
      provider: 'google-ai',
      enableAnalytics: true
    },
    git: {
      platform: 'bitbucket',
      credentials: {
        username: process.env.BITBUCKET_USERNAME!,
        token: process.env.BITBUCKET_TOKEN!,
        baseUrl: 'https://your-bitbucket-server.com'
      }
    }
  }
});

// Initialize
await guardian.initialize();
```

### **Unified Processing**
```typescript
// Process PR with multiple operations using shared context
const result = await guardian.processPR({
  workspace: 'YOUR_WORKSPACE',
  repository: 'my-repo',
  branch: 'feature/auth',
  operations: ['review', 'enhance-description']
});

console.log(`Processed ${result.operations.length} operations`);
console.log(`API calls saved: ${result.performance.apiCallsSaved}`);
console.log(`Cache hit ratio: ${result.performance.cacheHitRatio}%`);
```

### **Streaming Processing with Real-time Updates**
```typescript
// Real-time progress updates
for await (const update of guardian.processPRStream({
  workspace: 'YOUR_WORKSPACE',
  repository: 'my-repo', 
  branch: 'feature/auth',
  operations: ['review', 'enhance-description']
})) {
  console.log(`${update.operation}: ${update.status} - ${update.message}`);
  
  if (update.progress) {
    console.log(`Progress: ${update.progress}%`);
  }
}
```

### **Individual Operations**
```typescript
// Code review only
const reviewResult = await guardian.reviewCode({
  workspace: 'YOUR_WORKSPACE',
  repository: 'my-repo',
  branch: 'feature/auth',
  excludePatterns: ['*.lock', '*.svg']
});

// Description enhancement only
const enhancementResult = await guardian.enhanceDescription({
  workspace: 'YOUR_WORKSPACE',
  repository: 'my-repo',
  branch: 'feature/auth',
  customSections: [
    { key: 'summary', name: '📝 Summary', required: true },
    { key: 'rollback', name: '🔄 Rollback Plan', required: true }
  ]
});
```

### **Configuration Hot-Reload**
```typescript
import { configManager } from '@juspay/yama';

// Enable hot-reload for configuration changes
const stopWatching = configManager.enableHotReload((newConfig) => {
  console.log('Configuration updated:', newConfig);
  // Optionally reinitialize Guardian with new config
});

// Stop watching when done
process.on('SIGINT', () => {
  stopWatching();
  process.exit(0);
});
```

---

## 🧠 **Smart Diff Strategy**

Yama automatically chooses the optimal diff processing strategy:

### **Strategy Selection**
```typescript
// File count ≤ 5: Whole diff strategy
if (fileCount <= 5) {
  strategy = 'whole';  // Fast, provides full context
  reason = 'Small PR, whole diff provides better context';
}

// File count 6-20: Still whole diff (manageable)
else if (fileCount <= 20) {
  strategy = 'whole';
  reason = 'Moderate PR size, whole diff manageable';
}

// File count 21-50: File-by-file with batching
else if (fileCount <= 50) {
  strategy = 'file-by-file';  // Batch process 5 files at a time
  reason = 'Large PR, file-by-file more efficient';
}

// File count > 50: Essential batching for performance
else {
  strategy = 'file-by-file';
  reason = 'Very large PR, batching required for performance';
}
```

### **Batch Processing for Large PRs**
```typescript
// Process files in optimized batches
const batchSize = 5;
for (let i = 0; i < filteredFiles.length; i += batchSize) {
  const batch = filteredFiles.slice(i, i + batchSize);
  
  // Process batch in parallel with intelligent caching
  const batchResults = await Promise.all(
    batch.map(file => processFileWithCache(file))
  );
}
```

---

## 🎯 **File Exclusion Patterns**

### **Built-in Smart Exclusions**
```yaml
# Default exclusions (always applied unless overridden)
excludePatterns:
  - "*.lock"           # Package lock files
  - "*.svg"            # SVG images  
  - "*.min.js"         # Minified JavaScript
  - "*.min.css"        # Minified CSS
  - "node_modules/**"  # Dependencies
  - "dist/**"          # Build outputs
  - "build/**"         # Build outputs
  - "coverage/**"      # Test coverage
```

### **Pattern Syntax**
```bash
# Examples of supported patterns:
--exclude "*.lock"                    # All lock files
--exclude "**/*.test.js"              # Test files in any directory
--exclude "src/generated/**"          # Entire generated directory
--exclude "*.{lock,svg,min.js}"       # Multiple extensions
--exclude "!important.lock"           # Exclude everything except important.lock
```

### **Context-Aware Exclusions**
```typescript
// Different exclusions for different operations
const reviewExclusions = ['*.lock', '*.svg', '**/*.test.js'];
const enhancementExclusions = ['*.lock'];  // Allow SVGs in descriptions

await guardian.processPR({
  operations: [{
    type: 'review',
    excludePatterns: reviewExclusions
  }, {
    type: 'enhance-description', 
    excludePatterns: enhancementExclusions
  }]
});
```

---

## 📋 **Configurable Description Sections**

### **Default Required Sections**
```typescript
const defaultSections = [
  { key: 'changelog', name: '📋 Changelog (Modules Modified)', required: true },
  { key: 'testcases', name: '🧪 Test Cases (What to be tested)', required: true },
  { key: 'config_changes', name: '⚙️ Config Changes', required: true }
];
```

### **Custom Section Examples**
```yaml
# Enterprise setup
requiredSections:
  - key: "summary"
    name: "📝 Executive Summary"
    required: true
    
  - key: "business_impact"
    name: "💼 Business Impact"
    required: true
    
  - key: "technical_changes"
    name: "🔧 Technical Changes"
    required: true
    
  - key: "testing_strategy"
    name: "🧪 Testing Strategy"
    required: true
    
  - key: "rollback_plan"
    name: "🔄 Rollback Plan"
    required: true
    
  - key: "monitoring"
    name: "📊 Monitoring & Alerts"
    required: false
    
  - key: "documentation"
    name: "📖 Documentation Updates"
    required: false
```

### **Section Auto-Detection**
```typescript
// Smart pattern matching for existing sections
const sectionPatterns = {
  changelog: [
    /##.*?[Cc]hangelog/i,
    /##.*?[Mm]odules?\s+[Mm]odified/i,
    /📋.*?[Cc]hangelog/i
  ],
  testcases: [
    /##.*?[Tt]est\s+[Cc]ases?/i,
    /##.*?[Tt]esting/i,
    /🧪.*?[Tt]est/i
  ],
  security: [
    /##.*?[Ss]ecurity/i,
    /🔒.*?[Ss]ecurity/i,
    /##.*?[Vv]ulnerabilit/i
  ]
};
```

---

## 🛠️ **Utility Commands**

### **Health and Status**
```bash
# Check system health
yama status --detailed

# Output:
# ⚔️ Yama Status
# ✅ Overall Health: Healthy
# 
# 📊 Component Status:
#   ✅ ai: OK
#   ✅ git: OK  
#   ✅ cache: OK
#   ✅ config: OK
#
# 📈 Statistics:
# {
#   "totalOperations": 45,
#   "successRate": 0.98,
#   "avgProcessingTime": 120,
#   "apiCallsSaved": 1250
# }
#
# 💾 Cache: 67 keys, 423 hits, 89% hit ratio
```

### **Cache Management**
```bash
# View cache statistics
yama cache stats

# Output:
# 💾 Cache Statistics
# Keys: 67
# Hits: 423
# Misses: 52
# Hit Ratio: 89%
#
# 📊 Detailed Stats:
# {
#   "pr": { "hits": 45, "misses": 5 },
#   "file-diff": { "hits": 234, "misses": 28 },
#   "context": { "hits": 144, "misses": 19 }
# }

# Clear caches
yama cache clear
```

### **Configuration Management**
```bash
# Validate configuration
yama config validate

# Show current configuration (sensitive data masked)
yama config show

# Output:
# ⚙️ Current Configuration
# {
#   "ai": {
#     "provider": "google-ai",
#     "enableAnalytics": true
#   },
#   "git": {
#     "platform": "bitbucket",
#     "credentials": {
#       "token": "***MASKED***"
#     }
#   }
# }
```

---

## 🔄 **Migration from Individual Scripts**

Yama provides **100% backward compatibility** with your existing workflows:

### **From pr-police.js**
```bash
# Old way
node pr-police.js --workspace YOUR_WORKSPACE --repository repo --branch branch

# New way (identical functionality + optimizations)
yama review --workspace YOUR_WORKSPACE --repository repo --branch branch

# OR use the direct alias
yama police --workspace YOUR_WORKSPACE --repository repo --branch branch
```

### **From pr-describe.js / pr-scribe.js**
```bash
# Old way  
node pr-describe.js --workspace YOUR_WORKSPACE --repository repo --branch branch

# New way (identical functionality + optimizations)
yama enhance --workspace YOUR_WORKSPACE --repository repo --branch branch

# OR use the direct alias
yama scribe --workspace YOUR_WORKSPACE --repository repo --branch branch
```

### **New Unified Approach (Best Performance)**
```bash
# Best of both worlds + 90% performance improvement
yama process --workspace YOUR_WORKSPACE --repository repo --branch branch --operations all
```

---

## 🏗️ **Architecture Overview**

```
⚔️ YAMA ARCHITECTURE ⚔️
┌─────────────────────────────────────────────────────────────┐
│  🔍 UNIFIED CONTEXT GATHERING (Once for all operations)    │
│     ├── 🔍 Find Open PR (by branch or PR ID)               │
│     ├── 📄 Get PR Details (title, description, comments)   │
│     ├── 🧠 Get Memory Bank Context (project rules)         │
│     ├── 📊 Smart Diff Strategy (whole vs file-by-file)     │
│     └── 📎 Apply File Exclusions & Filters                 │
├─────────────────────────────────────────────────────────────┤
│  ⚡ OPTIMIZED OPERATIONS (Use shared context)              │
│     ├── 🛡️ Code Review (security, performance, quality)    │
│     ├── 📝 Description Enhancement (preserve + enhance)    │
│     ├── 🔒 Security Scan (future)                          │
│     └── 📊 Analytics & Reporting (future)                  │
├─────────────────────────────────────────────────────────────┤
│  🚀 PERFORMANCE LAYER                                      │
│     ├── 💾 Multi-Layer Caching (90% fewer API calls)      │
│     ├── 🔗 Connection Reuse (single MCP connection)        │
│     ├── 📦 Intelligent Batching (5 files per batch)       │
│     └── 🔄 Smart Retry Logic (exponential backoff)         │
└─────────────────────────────────────────────────────────────┘
```

---

## 🌟 **Why Yama?**

### **vs Individual Scripts**
1. **🚀 90% Performance Gain**: Unified context eliminates duplicate API calls
2. **🧠 Shared Intelligence**: AI analysis benefits from complete PR context  
3. **💾 Intelligent Caching**: Multi-layer caching with 80-90% hit rates
4. **📦 Batch Processing**: Handles large PRs (50+ files) that would fail before
5. **🔧 Enterprise Features**: Health monitoring, configuration management, analytics
6. **📘 Type Safety**: Complete TypeScript implementation with IntelliSense
7. **🔄 Backward Compatible**: Existing workflows work unchanged

### **vs Other Tools**
1. **🎯 Purpose-Built**: Specifically designed for enterprise PR workflows
2. **🔒 Security-First**: Built-in security analysis and hardcoded secret detection
3. **🤖 AI-Native**: Deep integration with multiple AI providers with fallbacks
4. **⚙️ Highly Configurable**: Every aspect can be customized via configuration
5. **📊 Analytics Ready**: Built-in performance monitoring and metrics collection

---

## 🛡️ **Security & Privacy**

- **🔐 No Data Storage**: All processing is ephemeral, no permanent data storage
- **🔒 Token Security**: All credentials are handled securely and never logged
- **🌐 Local Processing**: Diffs and code analysis happen locally before AI submission
- **🚫 No Tracking**: No usage analytics sent to external services (unless explicitly enabled)
- **🛡️ Content Filtering**: Automatic detection and filtering of sensitive data before AI processing

---

## 📈 **Performance Monitoring**

### **Built-in Metrics**
```typescript
const stats = guardian.getStats();

console.log({
  performance: {
    totalOperations: stats.totalOperations,
    avgProcessingTime: stats.avgProcessingTime,
    successRate: stats.successRate,
    apiCallsSaved: stats.apiCallsSaved
  },
  cache: {
    hitRatio: stats.cache.hitRatio,
    totalHits: stats.cache.hits,
    keyCount: stats.cache.keys
  },
  resources: {
    memoryUsage: stats.memory,
    activeConnections: stats.connections
  }
});
```

### **Performance Tracking**
```bash
# View performance metrics
yama status --detailed

# Example output shows:
# - 90% reduction in API calls vs individual scripts
# - 3x faster execution through shared context
# - 89% cache hit ratio
# - Average processing time: 2.3 minutes for medium PRs
```

---

## 🚀 **Coming Soon (Future Phases)**

- **🔒 Advanced Security Scanning**: Dependency vulnerability analysis, SAST integration
- **🌐 Multi-Platform Support**: GitHub, GitLab, Azure DevOps integration  
- **📊 Advanced Analytics**: Team productivity metrics, code quality trends
- **🤖 Custom AI Rules**: Train models on your codebase patterns
- **⚡ Parallel Processing**: Multi-PR batch processing for CI/CD integration
- **🔗 IDE Integration**: VSCode, IntelliJ plugins for real-time analysis

---

## 🤝 **Contributing**

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

---

## 📄 **License**

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🆘 **Support**

- **📖 Documentation**: [GitHub Wiki](https://github.com/juspay/yama/wiki)
- **🐛 Issues**: [GitHub Issues](https://github.com/juspay/yama/issues)  
- **💬 Discussions**: [GitHub Discussions](https://github.com/juspay/yama/discussions)
- **📧 Email**: opensource@juspay.in

---

## 🎯 **Environment Variables**

```bash
# Required
BITBUCKET_USERNAME=your-username
BITBUCKET_TOKEN=your-personal-access-token
GOOGLE_AI_API_KEY=your-google-ai-api-key

# Optional  
BITBUCKET_BASE_URL=https://your-bitbucket-server.com
AI_PROVIDER=google-ai
AI_MODEL=gemini-2.5-pro
DEFAULT_WORKSPACE=YOUR_WORKSPACE
ENABLE_CACHE=true
YAMA_DEBUG=false
```

---

**⚔️ Built with ❤️ by the Juspay team • Powered by AI & Enterprise Security • Code Quality Justice**

> *"In the realm of code, Yama stands as the eternal judge, ensuring only the worthy changes pass through to enlightenment."*