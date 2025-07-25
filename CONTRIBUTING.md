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
   pnpm run setup:setup
   ```

3. **Start Development**
   ```bash
   pnpm run dev
   ```

## 📋 Development Workflow

### 1. Environment Setup

```bash
# Install dependencies
pnpm install

# Validate setup
pnpm run env:validate
```

### 2. Development Commands

```bash
# Start development server
pnpm run dev

# Run tests
pnpm run test           # All tests
pnpm run test:watch     # Watch mode

# Code quality
pnpm run lint           # Check linting
pnpm run lint:fix       # Fix linting issues
pnpm run format         # Format code
pnpm run type-check     # TypeScript check

# Health monitoring
pnpm run health         # Full health check
pnpm run validate       # Build validation
```

### 3. Testing

- **Unit Tests**: Located in `tests/unit/`
- **E2E Tests**: Located in `tests/e2e/`
- **Performance Tests**: Located in `tests/performance/`

```bash
# Run specific test types
pnpm run test:unit
pnpm run test:e2e
pnpm run test:performance

# Coverage reporting
pnpm run test:coverage
```

## 🔧 Code Standards

### TypeScript

- Use strict TypeScript configuration
- All code must be properly typed (no `any` types)
- Follow existing code patterns and conventions

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
feat(guardian): add new security scan feature
fix(cli): resolve argument parsing issue
docs(readme): update installation instructions
test(core): add unit tests for ContextGatherer
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

Pre-commit hooks automatically run:

- Code formatting (Prettier)
- Linting (ESLint)
- Type checking (TypeScript)
- Related tests

## 🏗️ Architecture Overview

### Core Components

```
src/
├── core/                 # Core business logic
│   ├── Guardian.ts       # Main orchestrator
│   ├── ContextGatherer.ts # Context collection
│   └── providers/        # Platform providers
├── features/             # Feature implementations
│   ├── CodeReviewer.ts   # AI code review
│   └── DescriptionEnhancer.ts # PR description enhancement
├── cli/                  # Command-line interface
├── types/                # TypeScript type definitions
└── utils/                # Utility functions
```

### Adding New Features

1. **Core Logic**: Add to `src/core/` or `src/features/`
2. **Types**: Define in `src/types/`
3. **Tests**: Add to `tests/unit/` and `tests/e2e/`
4. **CLI**: Extend `src/cli/` if needed

### Platform Providers

To add a new platform provider:

1. Implement the provider interface in `src/core/providers/`
2. Add configuration types in `src/types/`
3. Add comprehensive tests
4. Update documentation

## 🧪 Testing Guidelines

### Unit Tests

- Test individual functions and classes
- Mock external dependencies
- Aim for 80%+ code coverage
- Use descriptive test names

```typescript
describe("ContextGatherer", () => {
  describe("gatherContext", () => {
    it("should gather complete context successfully", async () => {
      // Test implementation
    });
  });
});
```

### E2E Tests

- Test complete workflows
- Use real-world scenarios
- Test CLI commands
- Verify integrations

### Performance Tests

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
3. Run `pnpm run release:prepare`
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
- Node.js: [e.g. 18.15.0]
- Yama: [e.g. 1.1.0]
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

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

---

**Happy Contributing! 🎉**

Thank you for helping make Yama better for everyone!
