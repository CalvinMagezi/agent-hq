# Changelog

All notable changes to Agent-HQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-02-23

### Added
- **OpenClaw integration**: New `openclaw-plugin` for OpenClaw CLI harness support
- **OpenClaw bridge**: HTTP bridge server with auth, audit logging, and result filtering (`scripts/openclaw-bridge/`)
- **OpenClawAdapter**: Vault-client adapter for OpenClaw compatibility
- **Status checker**: `scripts/agent-hq-status.ts` CLI tool for system health overview
- **Daemon expansion**: Note linking (cosine similarity), topic MOC generation, OpenClaw bridge startup
- **launchd improvements**: Extended `scripts/install-launchd.sh` with daemon management and status monitoring
- **Workflow utilities**: `statusHelper.ts` shared workflow helper

### Changed
- Updated relay harnesses (claude, opencode, gemini) with improved timeout and streaming
- Improved memory consolidation workflow
- Extended web-digest workflow with better source handling
- Added `openclaw` to HarnessType enum in vault-client types

## [0.2.0] - 2026-02-22

### Added
- **Gemini CLI harness**: Full Google Workspace integration (Docs, Sheets, Drive, Gmail, Calendar)
- **Gemini specialization**: Routing rules — Gemini handles Google Workspace, Claude handles coding
- **GEMINI.md**: Agent instructions for Gemini CLI harness
- **Harness capability matrix**: Each bot type advertises its capabilities to the orchestrator
- **Delegation routing guidelines**: HQ orchestrator routes tasks by harness capability

### Security
- Untracked `.gemini/` settings (contained hardcoded local paths)
- Removed tracked runtime state files (session files, usage data, worker IDs)
- Converted hardcoded plist files to `.plist.example` templates with `__HOME__`/`__AGENT_DIR__` placeholders
- Added pre-commit hook scanning for API key patterns
- Added `.env.example` root template for new users

## [0.1.0] - 2026-02-22

### Added
- **HQ Agent** (`apps/agent/`): Local worker agent using Pi SDK for job execution
- **Discord Relay** (`apps/discord-relay/`): Multi-bot system (Claude Code, OpenCode, Gemini CLI)
- **VaultClient** (`packages/vault-client/`): Shared filesystem-based data access layer
- **Terminal Chat** (`scripts/agent-hq-chat.ts`): Readline REPL with vault context injection
- **Local Daemon** (`scripts/agent-hq-daemon.ts`): Background cron replacement (health checks, embeddings, linking)
- **Vault-based data store**: All data as markdown + YAML frontmatter in `.vault/`
- **Job queue**: Atomic `fs.renameSync` claiming — safe for concurrent workers
- **Delegation system**: HQ → relay bot task orchestration via vault filesystem
- **Security system**: 4-tier security profiles (MINIMAL/STANDARD/GUARDED/ADMIN) with ToolGuardian
- **Human-in-the-loop approvals**: GUARDED profile triggers approval flow for dangerous operations
- **Skills system**: Modular runtime-loadable skills (PDF, DOCX, PPTX, XLSX, frontend-design, mcp-builder)
- **Context enrichment**: Vault search, pinned notes, memory facts injected into every prompt
- **Memory management**: [REMEMBER:], [GOAL:], [DONE:] tags auto-processed from responses
- **Scheduled workflows**: Daily/weekly scripts via macOS launchd
- **SQLite search**: FTS5 + vector embeddings via `SearchClient`
- **WebSocket server**: `ws://127.0.0.1:5678` for web UI integration
- **Voice message support**: Groq/Whisper transcription for Discord voice messages

[Unreleased]: https://github.com/CalvinMagezi/agent-hq/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CalvinMagezi/agent-hq/releases/tag/v0.1.0
