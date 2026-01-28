# [2.2.0](https://github.com/juspay/yama/compare/v2.1.0...v2.2.0) (2026-01-28)


### Features

* **prompts:** switch add_comment to use line_number and line_type from structured diff ([25e2d0a](https://github.com/juspay/yama/commit/25e2d0ac356d47ba6c4a4a5b646714dd87a46fa3))

# [2.1.0](https://github.com/juspay/yama/compare/v2.0.0...v2.1.0) (2025-12-31)


### Bug Fixes

* **ci:** migrate to npm trusted publishing with OIDC authentication ([c836a0c](https://github.com/juspay/yama/commit/c836a0c0b3c7077f96fe0ffc8731296e997106c2))


### Features

* **learn:** add knowledge base learning from PR feedback ([a9c3d9d](https://github.com/juspay/yama/commit/a9c3d9d75175048caf5468a94949f8fe61bcb0f9))

# [2.0.0](https://github.com/juspay/yama/compare/v1.6.0...v2.0.0) (2025-11-26)

### Features

- **v2:** complete revamp with XML-based prompts and observability ([8eb6153](https://github.com/juspay/yama/commit/8eb6153c6272adc276b1ca44c655bf359733d256))

### BREAKING CHANGES

- **v2:** Complete architecture overhaul to V2. V1 code moved to src/v1/ directory.

* Added ReviewSystemPrompt.ts and EnhancementSystemPrompt.ts with generic XML-based instructions
* Implemented Langfuse observability integration for AI tracing and monitoring
* Changed userId format in traces from static to dynamic {repository}-{branch}
* Refactored PromptBuilder to inject project-specific config into base prompts
* Added ObservabilityConfig utility for environment-based Langfuse setup
* Removed session command from CLI (determined unnecessary)
* Switched to code_snippet approach for accurate inline comment placement
* Added docs/ reference and LogicUtils helper instructions to workflow config
* Created comprehensive V2 test suite (37 tests passing)
* Removed outdated V1 unit tests (10 test files)
* Updated .env.example with generic examples and Langfuse configuration
* Genericized all company-specific information in configuration examples
* CLI entry point now uses v2.cli.ts
* Fixed husky deprecated warnings by removing old hook syntax
* Fixed commit validation to support breaking change syntax

Features:

- Generic, reusable base prompts with project-specific YAML config injection
- Better observability with Langfuse for debugging AI decisions
- Autonomous code review workflow with lazy file loading
- Search-first approach: AI must verify code before commenting
- XML-structured prompts for better AI comprehension

# [1.6.0](https://github.com/juspay/yama/compare/v1.5.1...v1.6.0) (2025-10-24)

### Features

- added support for system prompt and fixed required section check in description enhancer ([c22d1ff](https://github.com/juspay/yama/commit/c22d1ff15a165379dece65145123433f7c1d6b98))

## [1.5.1](https://github.com/juspay/yama/compare/v1.5.0...v1.5.1) (2025-09-24)

### Bug Fixes

- **allocation:** Added fix for batch token allocation ([11f7192](https://github.com/juspay/yama/commit/11f719257a75ba946c45612e336db69a17cf278d))

# [1.5.0](https://github.com/juspay/yama/compare/v1.4.1...v1.5.0) (2025-09-19)

### Features

- **summary:** Added config support for summary comment ([666ea5c](https://github.com/juspay/yama/commit/666ea5c78b93d2ef3df24a09f95581a4b8e75650))

## [1.4.1](https://github.com/juspay/yama/compare/v1.4.0...v1.4.1) (2025-09-18)

### Bug Fixes

- **config:** resolve config layering issue in Guardian initialization ([6a27428](https://github.com/juspay/yama/commit/6a2742863b73dee458f83eadc464f41290fe52d9))

# [1.4.0](https://github.com/juspay/yama/compare/v1.3.0...v1.4.0) (2025-09-18)

### Features

- **Multi-Instance:** Added support for Multi-Instance Processing and Deduplication ([2724758](https://github.com/juspay/yama/commit/27247587f44740b26218f23694ebdcde4c323266))

# [1.3.0](https://github.com/juspay/yama/compare/v1.2.0...v1.3.0) (2025-09-01)

### Features

- **github:** implement comprehensive automation with proper Yama branding ([a03cb7f](https://github.com/juspay/yama/commit/a03cb7f499ea7793d626686beebde907551035d0))

# [1.2.0](https://github.com/juspay/yama/compare/v1.1.1...v1.2.0) (2025-08-08)

### Features

- **Memory:** support memory bank path and maxToken from config file ([1bc69d5](https://github.com/juspay/yama/commit/1bc69d5bda3ac5868d7537b881007beaf6916476))

## [1.1.1](https://github.com/juspay/yama/compare/v1.1.0...v1.1.1) (2025-07-28)

### Bug Fixes

- bump version to 1.2.1 ([8964645](https://github.com/juspay/yama/commit/89646450a7dec6ffcc3ad7fb745e1414fc751d4f))

# [1.1.0](https://github.com/juspay/yama/compare/v1.0.0...v1.1.0) (2025-07-28)

### Features

- migrate from CommonJS to ESM modules ([b45559f](https://github.com/juspay/yama/commit/b45559f86d37ab3516079becfa56a9f73ff8f062))

# 1.0.0 (2025-07-25)

### Features

- add enterprise-grade CI/CD pipeline and release automation ([e385d69](https://github.com/juspay/yama/commit/e385d69d135bee72f51ac4462adcfc9a4a4be17b))
- v1.1.0 - Enhanced AI configuration and performance improvements ([e763e93](https://github.com/juspay/yama/commit/e763e9341c2869433097b7a6bcc9080028934e1b))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2025-07-25

### Added

- Enterprise-grade Pull Request automation toolkit
- AI-powered code review capabilities
- Description enhancement features
- Support for Bitbucket, GitHub, and GitLab platforms
- Security-focused code analysis
- Quality assurance automation

### Features

- **Guardian**: Comprehensive PR security and quality checks
- **Scribe**: AI-enhanced PR description generation
- **Police**: Automated code review and compliance checking
- **Context Gathering**: Intelligent codebase analysis
- **Multi-platform Support**: Works with major Git platforms

### Dependencies

- @juspay/neurolink for AI capabilities
- @nexus2520/bitbucket-mcp-server for Bitbucket integration
- Comprehensive testing suite with Jest
- TypeScript support with strict type checking

### Developer Experience

- CLI tools with multiple entry points
- Configurable via YAML
- Memory bank for context persistence
- Comprehensive logging and debugging

---

_This changelog is automatically generated and maintained by semantic-release._
