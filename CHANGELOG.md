# Changelog

All notable changes to Agent-HQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Cross-Agent Planning System** (`@repo/hq-tools/planDB`): SQLite-backed plan tracking with FTS5 search. Includes `PlanKnowledgeEngine` for LLM-powered pattern extraction from completed plans and `planStatusSync` for frontmatter-to-DB synchronization.
- **Awake Replay Engine** (`@repo/vault-memory/awakeReplay`): Implements "preplay" and "credit assignment" via forward/reverse replay of memories. Triggered by job/task creation and completion to ground agent reasoning in past precedents.
- **HQ Browser Integration** (`packages/hq-browser`): Managed headless browser server with lifecycle management in the daemon. Adds `browser_open`, `browser_type`, `browser_click`, and `browser_screenshot` tools to the agent skillset.
- **Progressive Codebase Understanding** (`@repo/hq-tools/codemap`): Automated "codemap" generation. `CodemapEngine` tracks file purposes, exports, and patterns with confidence decay over time. Includes `codemapRefresher` background worker.
- **Daemon Task Expansion**: New background tasks for plan status syncing, pattern extraction, codemap refreshing, and plan archival/pruning.

### Changed
- **Memory System**: Added `processPendingDeltas` to the memory querier for asynchronous pattern separation.
- **Daemon Context**: Enriched with `MemorySystem` extensions for Awake Replay and Plan Knowledge management.

## [0.6.0] - 2026-03-11

### Added
- **Unified Relay Architecture** (`@repo/relay-adapter-core`): `UnifiedAdapterBot` class with shared command dispatcher (`commands.ts`), `VaultThreadStore` (`threadStore.ts`), harness router (`harnessRouter.ts`), platform bridges (`platformBridge.ts`), delegation handler (`delegation.ts`), and chat handler (`chatHandler.ts`). All adapters now share a single orchestration core.
- **Platform bridges**: `PlatformBridge` interface + concrete bridges for Telegram, WhatsApp, Discord, and Web (PWA). Each adapter is now a thin ~260 LOC bridge instead of a ~1500 LOC monolith.
- **Cross-platform thread continuity**: `VaultThreadStore` persists conversations as JSON in `.vault/_threads/`. `!continue <threadId>` and `!fork` commands let users pick up conversations across platforms.
- **BudgetGuard** (`@repo/vault-client`): Per-agent monthly budget enforcement via vault. Reads limits from `_usage/budget.md` frontmatter, scans daily usage logs, blocks over-budget agents.
- **Capability resolver** (`@repo/hq-tools`): Agent fallback chain resolution for harness-aware delegation routing.
- **Touch Points system** (`scripts/touchpoints/`): Event-driven vault enrichment pipeline — conversation learner, preference extraction, tag suggester, folder organizer, news clusterer/linker, stale thread detector, size watchdog, frontmatter fixer.
- **Platform config from vault**: `_system/PLATFORM-CONFIG.md` allows per-platform timeout and notification customization. `!config reload` applies changes live.
- **Agent definition enhancements**: `fallbackChain` and `performanceProfile` fields added to agent frontmatter schema across all 15 agent definitions.
- **BNI website** submodule added (`apps/bni-website`).

### Changed
- Telegram bot (`apps/relay-adapter-telegram/src/bot.ts`): Reduced from ~1470 LOC to ~260 LOC thin bridge over `UnifiedAdapterBot`.
- WhatsApp bot (`apps/relay-adapter-whatsapp/src/bot.ts`): Reduced from ~1730 LOC to thin bridge.
- Discord relay bot (`apps/discord-relay/src/bot.ts`): Reduced from ~780 LOC; shared logic moved to `@repo/relay-adapter-core`.
- HQ Control Center WebSocket server (`ws-server.ts`): Chat handling delegated to `UnifiedAdapterBot` via `WebBridge`.
- `LocalHarness` (`@repo/relay-adapter-core`): Expanded with Codex CLI support, session state persistence, and configurable timeouts.
- Agent prompt builder: Enriched with capability resolver output and agent role sections.
- News pulse daemon: RSS URL sanitization for markdown safety.
- `agentLoader.ts`: `AGENTS_DIR` resolved via `import.meta.url` instead of `process.cwd()`.

### Security
- **Path traversal on `!export`**: Validates resolved path stays within vault root (unifiedBot.ts, telegram/bot.ts).
- **Path traversal on `threadId`**: Safe ID regex `^[a-zA-Z0-9_-]{1,120}$` in `VaultThreadStore` and `ws-server.ts`.
- **Path traversal on `parseAgentFile`**: Containment check ensures resolved path stays under `AGENTS_DIR`.
- **Path traversal on `getNoteTree`**: Added `startsWith` vault containment guard.
- **Command injection on `!diagram`**: Shell metacharacters stripped from user input before `execSync`.
- **WebSocket server bind**: Changed from `0.0.0.0` to `127.0.0.1` by default (configurable via `WS_BIND_HOST`).
- **TOCTOU race in `BudgetGuard.recordSpend`**: Atomic exclusive file create (`{ flag: 'wx' }`).
- **`Infinity.toFixed()` crash**: `isFinite()` guard before formatting budget values.
- **RSS URL markdown injection**: Parentheses/brackets percent-encoded before embedding in HEARTBEAT.md.

## [0.5.0] - 2026-03-10

### Added
- **`@repo/relay-adapter-core` package** (`packages/relay-adapter-core/`): Shared infrastructure for Telegram and WhatsApp relay adapters — VoiceHandler, LocalHarness, SessionOrchestrator, MediaHandler, intent detection, and formatter utilities. Eliminates ~1,776 lines of duplication between adapters.
- **Vertical Agent Teams** (`packages/hq-tools/`): 15 agent definitions across 5 verticals, 4 team manifests with sequential/parallel/gated stages, workflow engine, performance tracker, team optimizer. New HQ tools: `list_agents`, `load_agent`, `list_teams`, `run_team_workflow`.
- **Vault tools in HQ-Tools** (`packages/hq-tools/src/tools/vault.ts`): 7 vault tools (`vault_search`, `vault_read`, `vault_context`, `vault_list`, `vault_batch_read`, `vault_write_note`, `vault_create_job`) consolidated from removed `vault-mcp` package.
- **Unattended Setup CLI** (`scripts/hq.ts`): Revamped `hq init` with step-tracking, dependency preflight, and env var injection for headless deployment.
- **`hq update` command**: Auto-fetch latest version, update deps, restart services.
- **Speak Tool / TTS** (`packages/hq-tools/src/tools/tts.ts`): Kokoro-82M, F5-TTS voice cloning, macOS `say` fallback.
- **Telegram relay adapter** (`apps/relay-adapter-telegram/`): Full Telegraf bot with text/image/document/voice, AI vision, Whisper transcription, TTS, orchestration routing, formatter.
- **Codex CLI Harness** (`apps/discord-relay/src/harnesses/codex.ts`): Session resumption, orchestration context injection, Web/WebSocket support.
- **Vault Cartographer Worker** (SBLU-1): Vault structural health analysis every 4h — dead links, orphans, semantic gaps.
- **SBLU Retraining Daemon**: Automated 3 AM model fine-tuning pipeline (extract → MLX-LM LoRA → GGUF → Ollama).
- **Context Engine** (`packages/context-engine/`): Token-aware, budget-driven context management with cascaded surplus and compaction strategies.
- **Vault Workers** (`scripts/vault-workers/`): 6 AI background agents (gap-detector, idea-connector, project-nudger, note-enricher, daily-preparer, orphan-rescuer).
- **Synaptic memory improvements**: Salience tagging, homeostatic decay, topic-clustered consolidation, novelty deduplication.
- **Daily RSS News Pulse**: Brave Search replaced with local RSS aggregation via `DIGEST-FEEDS.md`.
- **Google Workspace integration**: `gws` CLI tools for all agents, 3 HQ tools, auto-loaded skill.
- **WhatsApp full media capabilities**: 9 commands, AI vision, sticker conversion, polls, locations, reactions.
- **DrawIt diagram pipeline**: `hq diagram` CLI + `!diagram` Discord/WhatsApp commands + HQ tools.
- **Agent roles & execution modes**: 6 typed sub-agent profiles, 3 execution modes (quick/standard/thorough).
- **HQ Control Center PWA** with teams UI, diagram viewer, vault redesign, Codex streaming.

### Changed
- **Monorepo refactoring** (Phase 1-4): Split `vault-client/src/index.ts` (1,645→7 files), `apps/agent/index.ts` (1,562→5 files), `scripts/hq.ts` (2,139→8 files), `scripts/agent-hq-daemon.ts` (2,002→9 files), `apps/agent/lib/delegationToolsVault.ts` (945→8 files). All via re-export barrels for backward compatibility.
- **Telegram & WhatsApp adapters**: 5 files each replaced with thin re-exports from `@repo/relay-adapter-core`. WhatsApp's `media.ts` extends core `MediaHandler` with Baileys-specific download/sticker logic.
- **`vault-mcp` removed**: All vault tools consolidated into `@repo/hq-tools` unified MCP gateway.
- **`vault-gateway` removed**: Orphaned package with zero imports.
- **Dead code deleted**: `apps/agent/lib/delegationTools.ts`, `apps/agent/lib/retry.ts` (replaced by vault equivalents).
- **Web Digest**: Switched from Brave Search to local RSS feed aggregation.
- **`hq-cli` renamed** to `@calvin.magezi/agent-hq` (npm v0.4.0).
- **WhatsApp reconnect**: Separate `loggedOut` vs `connectionReplaced` handling with different back-off timers.
- **Model fallback chain**: Cross-model fallback on transient errors with flash/pro/worker tiers.

### Fixed
- **`vault-native` package**: Fixed `"main"` and `"types"` pointing to empty `.d.ts` — now point to `index.ts` directly.
- **`vault-sync` scanner**: `detectDeletions()` parameter typed as `Set<string>` to match `getAllPaths()` return type.
- **`modelFallback` test**: Updated assertion to match current `gemini-3.1-pro-preview` in fallback chain.
- **`vault-client` getPendingTasks**: Now scans `_delegation/pending/` for legacy markdown task files.
- **WhatsApp chat timeout**: Bumped from 2min to 10min.
- **`hq restart`**: Single-instance enforcement with force-kill of survivors.

### Removed
- **`packages/vault-mcp/`**: Replaced by `packages/hq-tools/` unified MCP gateway.
- **`packages/vault-gateway/`**: Orphaned package, zero imports in codebase.
- **`apps/agent/lib/delegationTools.ts`**: Replaced by `delegationToolsVault.ts`.
- **`apps/agent/lib/retry.ts`**: Replaced by `modelFallback.ts`.
- **External Orchestrators & Finance Agents**: Removed COO/CFO processes, `hq coo` CLI, watchdog integrations.
- **Stale env references**: Removed `BRAVE_SEARCH_API_KEY`, Convex URLs from env examples and turbo.json.

### Security
- **Path traversal prevention** (`packages/hq-tools/src/tools/vault.ts`): Added `resolveVaultPath()` boundary check to all vault read/write/list tools — rejects `../` traversal outside vault root.
- **Hardcoded path removal**: Replaced 5 instances of hardcoded `/Users/calvinmagezi/...` paths with `os.homedir()`, `import.meta.dir`, or env var fallbacks across `ws-server.ts`, `server/vault.ts`, `server/context.ts`, `server/teams.ts`, `retrain.ts`, `monitor-scheduled-tasks.ts`.
- **VAPID email**: Replaced hardcoded email with placeholder in `ws-server.ts`.
- **`.claude/` gitignored**: Machine-specific Claude Code project settings excluded from version control.
- **WhatsApp media handler**: Path traversal sanitization, WebP magic byte fix, prompt injection delimiting.
- **`scripts/hq.ts`**: PID validation, `spawnSync` for git clone, positional bash arguments for prompts.
- **`fileAttachments.ts`**: Path confinement to vault + tmpdir, dotfile rejection.
- **Env var scrubbing**: Added multi-bot Discord tokens to sensitive vars list.
- **Path sandboxing**: `ToolGuardian` blocks writes outside allowed directories.

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

[Unreleased]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CalvinMagezi/agent-hq/releases/tag/v0.1.0
