## [5.1.0](https://github.com/juspay/yama/compare/v5.0.4...v5.1.0) (2026-08-31)

### Features

* **review:** config-driven path exclusion, and delivery that reads the platform's own schema ([1abb226](https://github.com/juspay/yama/commit/1abb226b177d69914db7a738a4f20c82a0fe5276))

## [5.0.4](https://github.com/juspay/yama/compare/v5.0.3...v5.0.4) (2026-08-31)

### Bug Fixes

* **session:** retry a transient provider failure, the way v3 did ([9844648](https://github.com/juspay/yama/commit/9844648eda85977a1ef74108a4822a99d3b2585b))

## [5.0.3](https://github.com/juspay/yama/compare/v5.0.2...v5.0.3) (2026-08-31)

### Bug Fixes

* **platform:** read comments out of Bitbucket's pull-request envelope ([daa9c1d](https://github.com/juspay/yama/commit/daa9c1d97d9dcb3c6abbb26b5c0a82988c3e8334))

## [5.0.2](https://github.com/juspay/yama/compare/v5.0.1...v5.0.2) (2026-08-30)

### Bug Fixes

* **learn:** nothing new to learn is a success; chain learn after the release run ([7d3de03](https://github.com/juspay/yama/commit/7d3de03814373d17c0522c6af79791d8c539533b))

## [5.0.1](https://github.com/juspay/yama/compare/v5.0.0...v5.0.1) (2026-08-30)

### Bug Fixes

* **action:** doctor preflight needs the same base fallback as the review step ([f4a5dcf](https://github.com/juspay/yama/commit/f4a5dcf405610d92a3d35797ded3553633fffdcb))

## [5.0.0](https://github.com/juspay/yama/compare/v4.0.1...v5.0.0) (2026-08-30)

### ⚠ BREAKING CHANGES

* **release:** re-declares the v5 rewrite's major. The angular preset ignored the
feat! shorthand, so v5 was analyzed as no release and published as 4.0.1; with the
conventionalcommits preset this commit releases it as 5.0.0.

### Bug Fixes

* **release:** conventionalcommits preset; learn pushes with the workflow token ([d33330a](https://github.com/juspay/yama/commit/d33330a847959aea3bc4f59b2524848ef2de08fe))

## [4.0.1](https://github.com/juspay/yama/compare/v4.0.0...v4.0.1) (2026-08-30)


### Bug Fixes

* **ci:** learn uvx + guarded dispatch; restore pnpm overrides (npm OIDC, security floors); deliver BLOCK as request-changes ([9132912](https://github.com/juspay/yama/commit/913291282f79425b53938a04f3f82e64789ae941))

# [4.0.0](https://github.com/juspay/yama/compare/v3.0.4...v4.0.0) (2026-08-24)


* feat(v4)!: supervised review pipeline with code-verified posting ([0fbddbe](https://github.com/juspay/yama/commit/0fbddbe1a4c17a2bf36a9fa2a343508b20ac1b03))


### BREAKING CHANGES

* configuration is now a file tree under .yama/ rather
than a single file, model slots take fallback chains, and servers need a
capability map. The v3 single-file config still loads, and `yama migrate`
splits it. Requires a full checkout (fetch-depth: 0) because the diff is
read from disk. See MIGRATION.md.

## [3.0.4](https://github.com/juspay/yama/compare/v3.0.3...v3.0.4) (2026-08-04)

### Bug Fixes

- bump @juspay/neurolink to 10.8.3 ([a95e2fc](https://github.com/juspay/yama/commit/a95e2fc0adc98caf0ad58f190b53b0f9790e2e6b))

## [3.0.3](https://github.com/juspay/yama/compare/v3.0.2...v3.0.3) (2026-08-03)

### Bug Fixes

- correct commit example in README to Conventional Commits so releases publish ([2efcdef](https://github.com/juspay/yama/commit/2efcdefe2d182ca381d51a6837fe612f801cfa63))

## [3.0.2](https://github.com/juspay/yama/compare/v3.0.1...v3.0.2) (2026-07-28)

### Bug Fixes

- **review:** gate-anchored verdicts, posting finalization, no default wall clock ([b842f24](https://github.com/juspay/yama/commit/b842f24983bccdf065c87e9c3bb0be74299e39fb))

## [3.0.1](https://github.com/juspay/yama/compare/v3.0.0...v3.0.1) (2026-07-27)

### Bug Fixes

- **config:** make ai temperature optional, omit when unset ([10116a8](https://github.com/juspay/yama/commit/10116a85faa08d1a7d13e18048d7d11c45fc71db))

# [3.0.0](https://github.com/juspay/yama/compare/v2.7.2...v3.0.0) (2026-07-27)

### Bug Fixes

- **release:** repair GitHub Packages publish and refresh v3 docs ([705efe9](https://github.com/juspay/yama/commit/705efe9beff7b8c809950458df9d3fe429238bdf))

### BREAKING CHANGES

- **release:** the v3 line rejects the legacy flat mcpServers.<provider>
  config shape at startup - move servers under mcpServers.servers.<id> (see
  MIGRATION.md). Marker carried here because the v3 refactor merged as a
  non-releasing refactor commit.

## [2.7.2](https://github.com/juspay/yama/compare/v2.7.1...v2.7.2) (2026-07-23)

### Bug Fixes

- **deps:** bump @juspay/neurolink to 10.1.2 for litellm timeout defaults ([fe1de54](https://github.com/juspay/yama/commit/fe1de54cb2e015b679bc5edbed0cb2f3f35e5944)), closes [juspay/neurolink#1216](https://github.com/juspay/neurolink/issues/1216)
- **release:** run release.yml on Node 24 so npm@latest OIDC install succeeds ([9fa4e96](https://github.com/juspay/yama/commit/9fa4e962e687b559f613c615246e9a84a452fcdf))

## [2.7.1](https://github.com/juspay/yama/compare/v2.7.0...v2.7.1) (2026-06-15)

### Bug Fixes

- **v2:** bump neurolink to 9.70.7 and fix review/config correctness bugs ([d0c62f7](https://github.com/juspay/yama/commit/d0c62f767bb3f38fed0bc5dcc1a64845529ec3b6))

# [2.7.0](https://github.com/juspay/yama/compare/v2.6.0...v2.7.0) (2026-06-11)

### Features

- **setup:** add one-command GitHub integration setup script ([6a014b0](https://github.com/juspay/yama/commit/6a014b05ccf12e4ca362316e5f69c9441a93618f))

# [2.6.0](https://github.com/juspay/yama/compare/v2.5.0...v2.6.0) (2026-06-04)

### Features

- **action:** add Yama self-review workflow with LiteLLM/Vertex auth ([5ebb73f](https://github.com/juspay/yama/commit/5ebb73f2450951b5f97d97a6a3caa89377a150af))

# [2.5.0](https://github.com/juspay/yama/compare/v2.4.2...v2.5.0) (2026-06-03)

### Features

- **github:** add GitHub provider for PR reviews ([0b8e45f](https://github.com/juspay/yama/commit/0b8e45f30a95a30988c0dc6f84e929d2338108fe))

## [2.4.2](https://github.com/juspay/yama/compare/v2.4.1...v2.4.2) (2026-04-24)

### Bug Fixes

- **docs:** list get_file_blame in Bitbucket MCP tools ([c5f2ab6](https://github.com/juspay/yama/commit/c5f2ab6315fa4ac76b9dc6ec34631409e1647ffa))

## [2.4.1](https://github.com/juspay/yama/compare/v2.4.0...v2.4.1) (2026-04-16)

### Bug Fixes

- **deps:** pin undici to 5.x for Node 20 compatibility ([c8f92de](https://github.com/juspay/yama/commit/c8f92de3009f20f451d1848a568912d4c752a024))

# [2.4.0](https://github.com/juspay/yama/compare/v2.3.0...v2.4.0) (2026-04-15)

### Features

- **v2:** bootstrap repo standards from recent PRs before review ([8c5b1cd](https://github.com/juspay/yama/commit/8c5b1cdd38b684397e7445e04b4db4bc45b5f2a8))

# [2.3.0](https://github.com/juspay/yama/compare/v2.2.2...v2.3.0) (2026-04-01)

### Features

- **memory:** add per-repo memory management and configuration ([0b1fd5d](https://github.com/juspay/yama/commit/0b1fd5de8f0e46402f3c54766a5e0c7bd937cca2))

## [2.2.2](https://github.com/juspay/yama/compare/v2.2.1...v2.2.2) (2026-03-26)

### Bug Fixes

- **core:** fix MCP timeout, local review output format, and ReDoS in JSON parser ([89dbc27](https://github.com/juspay/yama/commit/89dbc27bd35b738dc808ffa2eaa31807dceab2b5))

## [2.2.1](https://github.com/juspay/yama/compare/v2.2.0...v2.2.1) (2026-02-23)

### Bug Fixes

- **version:** Added commit for version bump ([818cfae](https://github.com/juspay/yama/commit/818cfaeff0a3476dd2e4c1a3c22cd973882dfbf1))

# [2.2.0](https://github.com/juspay/yama/compare/v2.1.0...v2.2.0) (2026-01-28)

### Features

- **prompts:** switch add_comment to use line_number and line_type from structured diff ([25e2d0a](https://github.com/juspay/yama/commit/25e2d0ac356d47ba6c4a4a5b646714dd87a46fa3))

# [2.1.0](https://github.com/juspay/yama/compare/v2.0.0...v2.1.0) (2025-12-31)

### Bug Fixes

- **ci:** migrate to npm trusted publishing with OIDC authentication ([c836a0c](https://github.com/juspay/yama/commit/c836a0c0b3c7077f96fe0ffc8731296e997106c2))

### Features

- **learn:** add knowledge base learning from PR feedback ([a9c3d9d](https://github.com/juspay/yama/commit/a9c3d9d75175048caf5468a94949f8fe61bcb0f9))

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
