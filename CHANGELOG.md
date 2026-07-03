# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- CLI `cct` command (`cct start` / `cct stop` / `cct restart` / `cct status` / `cct logs`) for background process management, with `--port`, `--save-last-request`, `--save-last-response` flags.
- `package.json` declaring `bin`, `main`, `files`, `engines`, and npm scripts.
- GitHub install shorthand (`npm install -g shuai1763957837/cc-tencent-sanitize-proxy`) documented in README.

### Changed
- Reorganize to classic npm package layout: source moved to `lib/index.cjs`, tests to `test/index.test.cjs`, CLI entry to `bin/cct.js`. Debug artifacts now resolve to project root via `path.join(__dirname, "..")`.

### Fixed
- Map Tencent Copilot cache fields (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and `prompt_tokens_details.cached_tokens`) into Anthropic's `cache_read_input_tokens` / `cache_creation_input_tokens` in the normalized SSE. Claude Code reads the Anthropic fields for cache statistics, so it previously reported zero cache hits even though Tencent was hitting cache. Verified end-to-end: Claude Code now reports non-zero `cacheReadInputTokens`.

## [0.3.0] - 2026-07-02

### Added
- Expand sanitize rules to cover multi-word product names (`Claude Code`, `Claude Agent SDK`, `Claude API`, `Anthropic API`, `Anthropic SDK`), company references (possessive, `@anthropic-ai` package, bare `Anthropic`), model IDs and families (`claude-opus-*`, `claude-sonnet-*`, etc.), domains (`claude.ai`), hyphenated refs, and `FleetView`.
- Order rules so multi-word patterns fire before the bare `Claude` catch-all, preventing inflated replacement counts from already-deleted block content.

### Changed
- Merge the CLI and VS Code branding variants into a single opening-sentence rule.
- Rewrite `sanitizeText` to `matchAll`-then-replace for accurate replacement counts and `bytesDelta`, supporting both global and non-global source regexes.

### Fixed
- Fix `[Tool use interrupted]` on empty tool_call streams. `kimi-k2.7` occasionally returns `finish_reason=tool_calls` with no meaningful tool_call delta (only `index` placeholder frames). The old logic emitted an empty `tool_calls` shell plus a hardcoded `finish_reason`, so Claude Code received no tool name/args and reported an interruption.
  - `hasMeaningfulToolCallDelta` now filters out pure `index` placeholder frames.
  - `normalizedFinishReason` degrades to `stop` when `tool_calls`/`function_call` is declared but no corresponding output is present.
  - Empty fallback `content` changed from a zero-width space to an empty string.
  - Rename `fallbackContent` to `reasoningContent`; `message.content`/`text` folded into the main `content`.

### Removed
- Remove verification instructions.
- Simplify usage and ccswitch URL instructions.

## [0.2.0] - 2026-07-01

### Changed
- Simplify usage instructions.

## [0.1.0] - 2026-07-01

### Added
- Initial release of the cc tencent sanitize proxy.

[Unreleased]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/shuai1763957837/cc-tencent-sanitize-proxy/releases/tag/v0.1.0
