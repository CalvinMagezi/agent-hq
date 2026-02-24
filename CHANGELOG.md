# Changelog

All notable changes to Agent-HQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-02-24

### Added
- **VaultSync engine** (`@repo/vault-sync`): Event-driven file change detection replacing poll-based architecture. FileWatcher (`fs.watch` recursive), FullScanner (safety-net hourly), ChangeLog (append-only SQLite journal), SyncState (version tracking + SHA-256 hashing), EventBus (typed pub/sub), LockManager (advisory locks), ConflictResolver (merge-frontmatter strategy)
- **SyncedVaultClient**: Drop-in replacement for `VaultClient` with sync-awareness and `.on()` event subscriptions
- **Native Relay Server** (`@repo/agent-relay-server`): Bun.serve WebSocket+REST gateway on port 18900. Auth via `AGENTHQ_API_KEY`, routes chat/job/event messages between CLI clients and the HQ agent
- **RelayClient SDK** (`@repo/agent-relay-protocol`): Typed client for connecting to the relay server with streaming chat, job submission, and event subscriptions
- **relay-adapter-discord** (`apps/relay-adapter-discord/`): Thin Discord bot using RelayClient with streaming message edits and command routing
- **Cross-device vault sync** (`@repo/vault-sync-protocol`): E2E encrypted sync protocol (WebCrypto AES-256-GCM, HMAC device auth, envelope wrap/unwrap)
- **Vault sync server** (`@repo/vault-sync-server`): Bun.serve WebSocket relay — VaultRoom, DeviceRegistry, ChangeRouter; zero-knowledge design
- **Obsidian vault-sync plugin** (`plugins/obsidian-vault-sync`): Desktop+mobile plugin for cross-device vault synchronization with settings, conflict resolution, and device management modals
- **Orchestration tracing** (`@repo/vault-client/trace`): `TraceDB` class — SQLite at `.vault/_embeddings/trace.db` with `traces`, `spans`, `span_events` tables. Full distributed trace for HQ→relay orchestration flows
- **TraceReporter** (`apps/agent/lib/traceReporter.ts`): Watches active traces every 5s, broadcasts `trace.progress` events via agent WebSocket, writes `_system/ORCHESTRATION-STATUS.md`
- **Task cancellation**: Signal files at `_delegation/signals/cancel-{taskId}.md` — relay polls every 2s and calls `harness.kill(channelId)`
- **Result overflow**: Large results (>8KB) stored in `_delegation/results/result-{taskId}.md`; summary inline in task frontmatter
- **Delegation security constraints**: `DelegationSecurityConstraints` type — blocked commands, filesystem access, allowed directories, no-git/no-network flags, max execution timeout via `Promise.race()`
- **Delegation artifact cleanup** (daemon): Hourly task purges stale signal files (>1hr) and result files (>7 days)
- **Event-driven daemon**: Daemon now subscribes to VaultSync events — `note:created`/`note:modified` trigger immediate embeddings, `system:modified` triggers heartbeat processing, `approval:created` triggers expiry check
- **Event-driven relay**: Discord relay uses shared VaultSync instance for `task:created` events; 30s polling fallback replaces 5s
- **Event-driven agent adapter**: `AgentAdapter.initSync()` upgrades job detection to `job:created` events with 30s polling fallback
- **Relay path in terminal chat**: Chat CLI routes through relay server when `RELAY_SERVER=1` or `RELAY_HOST` is set; streaming deltas + job submission via `RelayClient`
- **`vault-client` trace export**: `./trace` export added to `@repo/vault-client` package.json exports
- **Trace relay protocol messages**: `trace:status`, `trace:status-response`, `trace:progress`, `trace:cancel-task`, `trace:cancel-task-result` added to relay message union
- **`VaultClient.readFullResult(taskId)`**: Reads overflow result files from `_delegation/results/`
- **Plugin build tooling**: `bun run plugin:build` and `bun run plugin:install` scripts; esbuild pipeline for Obsidian plugin

### Changed
- **Daemon polling intervals lengthened**: Heartbeat 2min→5min, embeddings 10min→30min (events handle fast path)
- **Discord relay delegation**: 5s polling replaced by event-driven monitoring with 30s safety-net
- **Agent index**: Initializes `SyncedVaultClient` via `adapter.initSync()` for event-driven job pickup
- **Result cap removed**: Relay no longer truncates to 10,000 chars; overflow goes to result files instead
- **`plugins/*`** added to root workspace workspaces array

### Security

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
