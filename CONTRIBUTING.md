# Contributing to Yama

Thank you for your interest in contributing to Yama! This guide will help you get started with contributing to our enterprise-grade Pull Request automation toolkit.

## 🚀 Quick Start

1. **Fork and Clone**

   ```bash
   git clone https://github.com/your-username/yama.git
   cd yama
   ```

2. **Setup Development Environment**

   ```bash
   pnpm install
   ```

3. **Start Development**
   ```bash
   pnpm run dev:run    # run the CLI from source (tsx src/cli/cli.ts)
   ```

## 📋 Development Workflow

### 1. Environment Setup

```bash
# Install dependencies
pnpm install

# Validate environment
pnpm run validate:env
```

### 2. Development Commands

```bash
# Run the CLI from source
pnpm run dev:run        # tsx src/cli/cli.ts
pnpm run dev            # watch mode

# Run tests
pnpm test               # jest (unit tests in tests/)

# Code quality
pnpm run lint           # Check linting
pnpm run lint:fix       # Fix linting issues
pnpm run format         # Format code
pnpm run type-check     # TypeScript check

# Build
pnpm run build          # rimraf dist && tsc && tsc-alias
```

**Recommended workflow:** edit → `pnpm run type-check` → `pnpm run lint` →
`pnpm test` → `pnpm run build`.

### 3. Testing

Tests live under `tests/`, mirroring `src/v2/`:
`tests/{unit,v2,integration,features,benchmarks,__mocks__}`.

```bash
# Run all tests
pnpm test

# Run a specific directory or file
pnpm test -- tests/v2/core
```

## 🔧 Code Standards

### TypeScript

- Use strict TypeScript configuration
- All code must be properly typed (no `any` types)
- Follow existing code patterns and conventions
- Repo-specific coding rules (zero `interface`, all exported types in the
  `src/v2/types/` barrel, config-driven MCP, etc.) live in
  [CLAUDE.md](CLAUDE.md) — read it before writing code

### Code Style

- Use Prettier for formatting (automatic via pre-commit hooks)
- Follow ESLint rules
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

### Commit Messages

We use [Conventional Commits](https://conventionalcommits.org/):

```
type(scope): description

Examples:
feat(review): add new security scan feature
fix(cli): resolve argument parsing issue
docs(readme): update installation instructions
test(core): add unit tests for ReviewResultParser
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test changes
- `build`: Build system changes
- `ci`: CI/CD changes
- `chore`: Other changes

### Pre-commit Hooks

Pre-commit hooks automatically run on staged files (via lint-staged):

- Code formatting (Prettier)
- Linting (ESLint)

The pre-push hook additionally runs validation and the test suite.

## 🏗️ Architecture Overview

### Core Components

```
src/
├── index.ts              # Public SDK entry (sanctioned type re-exporter)
├── cli/cli.ts            # commander CLI (review | enhance | learn | init)
└── v2/
    ├── core/             # YamaOrchestrator, MCPServerManager, McpRegistry,
    │                     # NeuroLinkFactory, ReviewResultParser, reviewDecision
    ├── config/           # ConfigLoader (merge + validation), DefaultConfig
    ├── prompts/          # PromptBuilder + review/enhancement/learning prompts
    ├── exploration/      # ContextExplorerService (research sub-agent)
    ├── harness/          # Critic + submit_review gate
    ├── rules/            # RuleLoader — .yama/rules/** structured team rules
    ├── state/            # ReviewStateStore — cross-run incremental review
    ├── learning/         # KnowledgeBaseManager (.yama/knowledge-base.md)
    ├── memory/           # MemoryManager (per-repo condensed memory)
    ├── types/            # ALL type definitions — barrel at index.ts
    └── utils/            # toolPolicy, tokenLimits, ProviderDetector, ...
```

### Adding New Features

1. **Core Logic**: Add to the appropriate `src/v2/` module (`core/`, `harness/`, ...)
2. **Types**: Define in `src/v2/types/` (the barrel — see [CLAUDE.md](CLAUDE.md))
3. **Tests**: Add to `tests/` mirroring `src/v2/`
4. **CLI**: Extend `src/cli/cli.ts` if needed

### Platform and Tool Integrations

VCS platforms and tool integrations are **config, not code**: every MCP server
(Bitbucket, GitHub, code intelligence, custom) is a `mcpServers.servers.<id>`
config entry with `roles`/`modes`/`blockedTools`/`allowedTools`. To add one,
edit the config (see `.yama/README.md` and `yama.config.example.yaml`) — there
is no provider interface to implement, and tool/server names must not appear
in `src/`.

## 🧪 Testing Guidelines

### Unit Tests

- Test individual functions and classes
- Mock external dependencies
- Aim for 80%+ code coverage
- Use descriptive test names

```typescript
describe("ReviewResultParser", () => {
  describe("parse", () => {
    it("should normalize structuredData into a ReviewResult", async () => {
      // Test implementation
    });
  });
});
```

### Integration Tests (`tests/integration/`)

- Test complete workflows
- Use real-world scenarios
- Verify module interactions

### Benchmarks (`tests/benchmarks/`)

- Monitor memory usage
- Test large file handling
- Benchmark critical paths
- Verify timeout handling

## 📝 Documentation

### Code Documentation

- Use JSDoc for public APIs
- Include usage examples
- Document complex algorithms
- Explain business logic

### User Documentation

- Update README.md for user-facing changes
- Add configuration examples
- Include troubleshooting guides
- Provide migration guides for breaking changes

## 🚀 Release Process

### Version Management

We use semantic versioning and automated releases:

- **Major** (1.x.x): Breaking changes
- **Minor** (x.1.x): New features
- **Patch** (x.x.1): Bug fixes

### Release Checklist

1. Ensure all tests pass
2. Update documentation
3. Run the full check locally:
   `pnpm run type-check && pnpm run lint && pnpm test && pnpm run build`
4. Create PR to `main` branch
5. Merge triggers automated release

## 🐛 Bug Reports

### Before Submitting

1. Check existing issues
2. Test with latest version
3. Reproduce the issue
4. Gather system information

### Bug Report Template

```markdown
## Bug Description

Clear description of the issue

## Steps to Reproduce

1. Step one
2. Step two
3. Step three

## Expected Behavior

What should happen

## Actual Behavior

What actually happens

## Environment

- OS: [e.g. macOS 13.0]
- Node.js: [e.g. 20.18.1 — Yama requires >=20.18.1]
- Yama: [e.g. 2.7.2]
- Platform: [e.g. GitHub, Bitbucket]
```

## 💡 Feature Requests

### Guidelines

- Check existing feature requests first
- Explain the use case clearly
- Describe the proposed solution
- Consider backwards compatibility

### Feature Request Template

```markdown
## Problem Statement

What problem does this solve?

## Proposed Solution

How should this work?

## Use Case

How would you use this feature?

## Alternatives Considered

What other solutions did you consider?
```

## 🤝 Code Review Process

### Submitting PRs

1. Create feature branch from `main`
2. Make focused, atomic changes
3. Write comprehensive tests
4. Update documentation
5. Submit PR with clear description

### Review Criteria

- ✅ Code follows style guidelines
- ✅ Tests are comprehensive
- ✅ Documentation is updated
- ✅ No breaking changes (unless major version)
- ✅ Performance impact considered
- ✅ Security implications reviewed

### Review Process

1. Automated checks must pass
2. At least one maintainer review
3. Address feedback
4. Squash and merge

## 🏅 Recognition

We appreciate all contributions! Contributors will be:

- Listed in our Contributors section
- Mentioned in release notes
- Invited to our contributor community

## ❓ Getting Help

- **Documentation**: Check README and docs
- **Issues**: Search existing GitHub issues
- **Discussions**: Use GitHub Discussions for questions
- **Support**: Email support@juspay.in

## 📜 Code of Conduct

Be respectful and constructive in all project spaces — issues, PRs,
discussions, and reviews. Harassment or personal attacks are not tolerated.

---

**Happy Contributing! 🎉**

Thank you for helping make Yama better for everyone!
