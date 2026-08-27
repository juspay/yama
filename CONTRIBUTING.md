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
   pnpm run dev -- review --dry-run   # run the CLI from source (tsx src/cli/index.ts)
   ```

## 📋 Development Workflow

### 1. Environment Setup

```bash
# Install dependencies
pnpm install

# Validate environment
pnpm run validate:env
```

Yama needs Node >= 22 and pnpm >= 10. Credentials are referenced by environment variable
NAME — see [.env.example](.env.example) for the ones that exist and what each is for.

### 2. Development Commands

```bash
# Run the CLI from source
pnpm run dev -- <command>   # tsx src/cli/index.ts

# Code quality
pnpm run lint           # ESLint — the repo's code rulings
pnpm run lint:fix       # Fix what is autofixable
pnpm run format         # Prettier
pnpm run check          # TypeScript over src/ and test/ (alias: type-check)

# Build, then test
pnpm run build          # tsc → dist/
pnpm test               # e2e suites, driving the BUILT CLI
```

**Recommended workflow:** edit → `pnpm run check` → `pnpm run lint` →
`pnpm run build` → `pnpm test`.

`pnpm test` drives `dist/`, never `src/`. A stale `dist/` is a lying test run — build first.

### 3. Testing

Tests live under `test/`: one suite per area (`suite-gates.ts`, `suite-platform.ts`, …),
with `test/run.ts` as both the driver and the harness.

```bash
# Run every suite
pnpm run build && pnpm test
```

Yama's suites are **end-to-end only**. A suite exercises a surface Yama actually ships — the
built CLI (`dist/cli/index.js`) or the built library entry (`dist/index.js`). Reaching into
`src/` to assert on an internal is a unit test and does not belong here.

- One module graph per suite: take everything from `dist/`.
- The only skip signal is `throw new Skip(reason)` — never a message prefix or error text.
- Sanity-check a new suite by breaking one assertion on purpose: it must report `✗` and exit
  non-zero, never `⊘`.
- `test/fixtures/` holds deliberately bad code and config: it is the review INPUT the suites
  need, and it is excluded from lint and prettier on purpose.

## 🔧 Code Standards

### TypeScript

- Use strict TypeScript configuration
- All code must be properly typed (no `any` types)
- Follow existing code patterns and conventions
- Repo-specific coding rules (zero `interface`, every exported type in the `src/types/`
  barrel, only `src/engine/` importing `@juspay/neurolink`, capabilities instead of tool
  names) live in [CLAUDE.md](CLAUDE.md) — read it before writing code. They are enforced by
  `pnpm run lint`, so a violation is a build failure, not a review comment.

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
feat(stages): carry unaccounted prior findings as open
fix(cli): resolve argument parsing issue
docs(readme): update installation instructions
test(gates): cover the checklist completeness gate
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

The pre-push hook additionally runs validation, the type check, the build and the suites.

## 🏗️ Architecture Overview

### Core Components

```
src/
├── index.ts       # Public library entry (runtime exports only)
├── cli/           # yargs CLI (init | doctor | review | learn) and the exit codes
├── config/        # .yama/ loading, zod schema, capability ids, model chains
├── core/          # session runner, review/learn/doctor/init, run report
├── engine/        # THE SEAM — the only place @juspay/neurolink may be imported
├── gates/         # deterministic checks between stages (schema, checklist,
│                  # markers, posted-=-confirmed, recurrence, verdict, exit)
├── platform/      # capability → tool resolution, connect, startup probe
├── stages/        # WarmUp, Task Insertion, Work, Collate, Delivery (+ schemas)
├── store/         # .yama/artifacts/ run store
├── tools/         # git (read-only allowlist), fs, checks, markers, memory
├── types/         # ALL type definitions — barrel at index.ts
└── util/          # small leaf helpers
```

### Adding New Features

1. **Core Logic**: add it to the module that owns that concern (`stages/`, `gates/`, …)
2. **Types**: define them in `src/types/` (the barrel — see [CLAUDE.md](CLAUDE.md))
3. **Engine primitives**: anything the model runtime provides goes behind `src/engine/`
4. **Tests**: add or extend a suite in `test/`, driving the built CLI
5. **CLI**: extend `src/cli/index.ts` if a new command or flag is needed

### Platform and Tool Integrations

VCS platforms are **config, not code**. Yama's code asks for a capability
(`comment.inline.create`, `pr.read`, …); `.yama/mcp.yaml` maps that capability to the tool
an MCP server actually exposes, plus the arguments every call of it needs. To support a new
forge, write a capability map — see `templates/mcp.github.yaml` and
`templates/mcp.bitbucket.yaml`. There is no provider interface to implement, and tool or
server names must not appear in `src/`.

## 🧪 Testing Guidelines

### What a good suite looks like

- Drives a real command end to end and asserts on what a user would see: stdout, the exit
  code, the files written under `.yama/`
- Uses a temporary directory, and cleans up whatever it does
- Names the discrepancy in its assertion message, without pasting captured output into it

### Fixtures (`test/fixtures/`)

- `mini-repo/` — a small repository with real config to review
- `bad-config/` — configs that must fail, each in its own way
- `synthetic-pr/` — comments, prior findings and a prior run, for recurrence

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
   `pnpm run check && pnpm run lint && pnpm run build && pnpm test`
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
- Node.js: [e.g. 22.11.0 — Yama requires >=22]
- Yama: [e.g. 5.0.0]
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
