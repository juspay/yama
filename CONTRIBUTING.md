# Contributing to Yama

Thank you for your interest in contributing to Yama! This guide will help you get started with contributing to our autonomous pull-request review agent.

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
   cd .yama && node ../src/index.mjs  # interactive REPL against this repo's own config
   ```

## 📋 Development Workflow

### 1. Environment Setup

```bash
# Install dependencies
pnpm install

# Validate environment
pnpm run validate:env
```

Yama needs a patched Node (22.23.4+, 24.22.1+ or 26.12.1+ — the October 2026 security
release) and pnpm >= 10.34.5. Credentials are referenced by environment variable
NAME — see [.env.example](.env.example) for the ones that exist and what each is for.

### 2. Development Commands

```bash
# Run the reviewer straight from the repository — there is no build step
node src/index.mjs init <dir>          # scaffold a config into <dir>
cd .yama && node ../src/index.mjs run pr=N branch=x

# Code quality
pnpm run lint           # ESLint over src/ and test/
pnpm run lint:fix       # Fix what is autofixable
pnpm run format         # Prettier
pnpm run check          # TypeScript over test/ (alias: type-check)
pnpm test               # e2e suite
```

### 3. Testing

`test/suite-reviewer.ts` drives `src/index.mjs` as a subprocess; `test/run.ts` is both
the driver and the harness. The suite is offline and deterministic — scaffolding, argument
guards and package wiring. The model-driven path is exercised live by `yama-review.yml` on
every pull request.

- Never import a `src/` module into a suite; observe it through the subprocess.
- The only skip signal is `throw new Skip(reason)` — never a message prefix or error text.
- Sanity-check a new test by breaking one assertion on purpose: it must report `✗` and exit
  non-zero, never `⊘`.

## 🔧 Code Standards

### Rules

The repository's rulings live in [CLAUDE.md](CLAUDE.md) — read it before writing code.

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
feat(reviewer): add a description-review prompt
fix(reviewer): resolve argument parsing issue
docs(readme): update installation instructions
test(reviewer): cover the learn usage guard
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

One commit per pull request — see [.github/SINGLE_COMMIT_POLICY.md](.github/SINGLE_COMMIT_POLICY.md).

### Pre-commit Hooks

Pre-commit hooks automatically run on staged files (via lint-staged):

- Code formatting (Prettier)
- Linting (ESLint)

The pre-push hook additionally runs validation, the type check, lint and the suite.

## 🏗️ Architecture Overview

The shipped package is `src/`; this repository's own review setup is `.yama/` — see the
layout in [CLAUDE.md](CLAUDE.md). Behaviour lives in configuration: `config.json` (provider/model chains, timeouts, memory, learn),
`MCP.json` (tool servers), `prompts.json` (what a review does) and `skills/` (review
standards loaded on demand). Supporting a new forge means a different MCP server and
skills, not new code.

## 📝 Documentation

### Code Documentation

- Use JSDoc for public APIs
- Include usage examples
- Document complex algorithms
- Explain business logic — especially the reason a rule exists, not only the rule

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
   `pnpm run check && pnpm run lint && pnpm test`
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

- OS: [e.g. macOS 15.0]
- Node.js: [e.g. 22.23.4 — Yama requires 22.23.4+, 24.22.1+ or 26.12.1+]
- Yama: [e.g. 6.1.1]
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

- **Documentation**: Check README and CLAUDE.md
- **Issues**: Search existing GitHub issues
- **Discussions**: Use GitHub Discussions for questions
- **Support**: Email support@juspay.in

## 📜 Code of Conduct

Be respectful and constructive in all project spaces — issues, PRs,
discussions, and reviews. Harassment or personal attacks are not tolerated.

---

**Happy Contributing! 🎉**

Thank you for helping make Yama better for everyone!
