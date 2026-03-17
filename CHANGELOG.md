# Changelog

All notable changes to Agent-HQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.13] - 2026-03-17

### Added
- **Model Registry** (`packages/context-engine/src/models/`): Typed `ModelRegistry` with vault-file overrides (`_system/MODEL-REGISTRY.md`), alias resolution, prefix matching, and checkpoint config derivation. Default specs for Claude 4.6, Gemini 3.1/2.5, GPT-5.4/o3, Qwen 3.5 local.
- **Session Management** (`packages/context-engine/src/session/`): Infinite session system with SQLite-backed persistence, checkpoint creation/resume, multi-surface support (Discord, CLI, REST, WhatsApp, Telegram, Agent), message batching/debouncing, and semantic recall over checkpoints.
- **Privacy Utilities** (`packages/context-engine/src/utils/privacy.ts`): `stripPrivateTags()` removes `<private>…</private>` blocks from context before assembly.
- **Office Document Viewers** (HQ Control Center):
  - `DocxViewer` — Server-side DOCX→HTML conversion via mammoth with glass-morphism UI.
  - `HtmlViewer` — Dual-mode HTML preview (rendered iframe + source view) with dark-friendly stylesheet injection.
  - `SpreadsheetViewer` — Multi-sheet XLSX viewer with row counts, column headers, and 500-row truncation.
  - `NoteEditor` — Edit/preview toggle for markdown notes with Cmd+S save and unsaved-change warnings.
  - `OfficeFileCard` — Fallback card for unsupported office formats (PPTX, XLS) with download link.
- **Model Benchmark Tool** (`packages/hq-tools/src/tools/modelBenchmark.ts`): 10 Agent-HQ-specific evaluation tests (tool-use, JSON extraction, code gen, context stress, instruction following, summarization, multi-turn, error recovery, markdown gen, cost routing) with LLM-based judge scoring. Reports saved to vault.
- **Touch Points — Connection Weaver** (`scripts/touchpoints/points/connectionWeaver.ts`): Semantic "See Also" link suggestions on note create/modify with 24-hour cooldown and backup-before-modify safety.
- **Touch Points — Daily Synthesis** (`scripts/touchpoints/points/dailySynthesis.ts`): Evening cross-pollination run (20:30–22:00 EAT) that gathers signals across news, vault changes, link health, memory, and AI intelligence to surface unexpected connections. Replaces 5 older insight-generation workers.
- **Touch Points — Vault Health** (`scripts/touchpoints/points/vaultHealth.ts`): Periodic (6h) structural analysis — dead links, orphans, cluster gaps — with daily archival for SBLU training data.
- **Vault Cleanup Script** (`scripts/cleanup/vaultCleanup.ts`): One-time migration for removing auto-generated insight files, `.sync-conflict-` duplicates, stale MOCs, and graph-link HTML sections. Dry-run mode included.
- **Context Engine tests**: Added `ModelRegistry` and session lifecycle tests (`registry.test.ts`, `session.test.ts`).

### Changed
- **CLAUDE.md**: Condensed from ~390 lines to ~48 lines — essential rules, entry points, dev commands only.
- **Context Engine model limits**: Refactored from hardcoded map to `ModelRegistry` lookup with vault override support.
- **Chunk Index scoring**: Enhanced with recency decay and pin weighting for better relevance ranking.
- **Daemon scheduler**: Integrated new touchpoints (connection-weaver, daily-synthesis, vault-health) with periodic vs event-driven scheduling.
- **SBLU training pipeline**: Improved extract/convert/train scripts for vault cartographer fine-tuning.
- **Model tracker workflow**: Enhanced with expanded model spec coverage.
- **Vault workers**: Refactored away old auto-generation system in favor of touchpoint-driven enrichment.

### Fixed
- **Model Registry type safety**: `loadVaultOverrides()` now properly merges partial vault specs into existing entries instead of passing `Partial<ModelSpec>` where `ModelSpec` was required. New specs from vault require all fields present.

### Security
- **XSS — DocxViewer**: Added DOMPurify sanitization on mammoth HTML output before `dangerouslySetInnerHTML` rendering.
- **XSS — HtmlViewer**: Added DOMPurify sanitization on vault HTML file content before iframe `srcDoc` injection.

## [0.6.12] - 2026-03-16

### Added
- **Provider-agnostic LLM abstraction** (`packages/vault-client/src/models.ts`): New `resolveEmbeddingProvider()`, `resolveChatProvider()`, `resolveVisionProvider()` functions auto-detect the best available provider from env vars. Priority: Gemini → Anthropic → OpenRouter → Ollama → none. New `fetchEmbedding()` function uses plain `fetch()` with zero SDK dependencies.
- **Anthropic direct API support** (`apps/agent/lib/modelConfig.ts`): Added `ANTHROPIC_API_KEY` env var and `isAnthropicModel()` detection. Agent routing: Ollama → Gemini → Anthropic → OpenRouter. Users with only a Claude API key can now run the agent directly.
- **Multi-provider vision** (`packages/relay-adapter-core/src/media.ts`): Image description now supports Gemini (generateContent API), Anthropic (Messages API with base64 images), and OpenRouter. Auto-detected from env vars.
- **Multi-provider chat fallback** (`packages/agent-relay-server/src/handlers/chat.ts`): Relay server chat fallback now supports Gemini, Anthropic, and OpenRouter with proper SSE streaming for each. Lazy provider resolution avoids module-load-order issues with env-loader.
- **CLI harness availability check** in `hq doctor`: Reports which CLI tools (claude, codex, gemini, opencode) are on PATH.
- **Anthropic API key prompt** in `hq env` interactive setup (step 2b).
- **`@repo/env-loader`** adopted across all apps/adapters, replacing per-app `dotenv` calls.

### Changed
- **`hq init`**: API key warning changed from blocking to informational — "Relay harnesses (Claude, Codex, Gemini) work without keys."
- **`hq doctor`**: Missing API keys downgraded from `fail()` to `warn()` — no longer increments issue count. Relay adapters are functional with zero LLM keys via CLI harnesses.
- **`hq quickstart`**: Updated messaging to clarify API keys are optional for relay-only setups.
- **Daemon embedding processor**: Uses provider abstraction instead of hardcoded OpenRouter `fetch()`. Gracefully skips embeddings when no provider is configured (FTS5 keyword search remains active).
- **`.env.example`**: Expanded with all documented env vars (Telegram, WhatsApp, voice, Google Workspace, Ollama), all values blank/commented.

### Fixed
- **`process.env` mutation in MediaHandler**: Removed global side-effect where legacy `openRouterApiKey` config was injected into `process.env`. Now uses direct provider config without env pollution.
- **Module-load-order race**: Chat handler provider detection changed from module-level constant to lazy resolution, preventing `{ type: "none" }` when env-loader hasn't run yet.
- **Misleading Ollama fallback**: Embedding provider no longer optimistically returns Ollama when no keys are set. Only returns Ollama if `OLLAMA_BASE_URL` is explicitly configured.
- **Discord bot typing indicator**: Fixed stuck typing indicator on 404 job status responses.

## [0.6.10] - 2026-03-16

### Fixed
- **Cross-platform hardening (Windows/Linux guards)**: Comprehensive audit and fix of all platform-specific assumptions.
  - `isAlive()` replaced `kill -0` shell command with `process.kill(pid, 0)` — now works correctly on Windows and any POSIX platform without a shell in PATH.
  - All `process.platform !== "darwin"` guards tightened to `=== "linux"`, preventing `systemctl` and systemd commands from running on Windows.
  - `killAllInstances()`: `launchctl stop` now darwin-only; `pkill` calls guarded against `win32`.
  - `findAllInstances()` / `killProcessTree()`: Unix process utilities (`pgrep`, `lsof`, `ps`) guarded with `win32` early-return.
  - `isPortInUse()`: Windows branch added using `netstat -ano`; `uptime()` early-returns `"?"` on Windows.
  - `cmdFg()`: `launchctl stop` guarded to darwin; Linux branch added using `systemctl --user stop`.
  - `cmdUninstall()`: Full Linux systemd uninstall path added (was macOS-only).
  - Post-update systemd reinstall guard changed to `=== "linux"`.
- **Gemini settings corruption**: Silent `catch {}` on `JSON.parse` of `~/.gemini/settings.json` now aborts with a warning instead of overwriting the file with an empty object.
- **`hq update` robustness**:
  - Explicit `git` not-installed check before version fetch (previously showed misleading "could not reach GitHub" error).
  - `git ls-remote` now has a 10-second timeout (was unbounded, could block 30s on slow connections).
  - `git stash push` failure is now fatal before `git reset --hard` — prevents silent data loss.
- **`opencode --version` pipe**: Removed `| head -1` shell pipe (broken on Windows `cmd.exe`); replaced with JS `.split("\n")[0]`.
- **`drawit` binary fallback**: Now checks `/usr/local/bin/drawit` before failing (previously only checked `/opt/homebrew/bin/drawit`).
- **Daemon hardcoded paths**:
  - Three `process.env.HOME ?? "/Users/" + process.env.USER` patterns replaced with `os.homedir()`.
  - `teamsDir` for team-optimizer now resolved via `import.meta.dir` instead of `VAULT_PATH/../Documents/GitHub/...` (personal machine path).
- **`initState.ts`**: Config directory now uses `getPlatform().configDir` — resolves to `%AppData%\agent-hq` on Windows, `~/Library/Application Support/agent-hq` on macOS, `~/.config/agent-hq` on Linux.

## [0.6.9] - 2026-03-16

### Added
- **`hq update` command** (full rewrite): Robust update flow replacing the previous stub.
  - Version check via `git ls-remote` (no npm registry lag).
  - Displays changelog (commits between current and `origin/main`) before applying.
  - Stops running services → optional stash → `git fetch` + `git reset --hard origin/main` → `bun install` → post-update migration → restarts services.
  - `--check` flag: non-destructive version check only.
  - `--force` flag: auto-stashes local changes before reset.
  - Refreshes systemd units on Linux after update.
  - Re-installs CLI symlink if it changed.

## [0.6.8] - 2026-03-16

### Added
- **`--skip-ollama` flag** for `hq init`: Skips Ollama installation step (for VPS/cloud environments).
- **`--skip-tools` flag** for `hq init`: Skips CLI tool installation (Claude Code, Gemini CLI, OpenCode).
- **`--profile vps` preset** for `hq init`: Combines `--non-interactive --skip-ollama --skip-tools` for headless server setup.
- **`hq doctor` vault path check**: Detects if `VAULT_PATH` contains a different username than the current user (catches copy-paste path errors from other machines).
- **`engines` field in `hq-cli/package.json`**: `bun >= 1.1.0` constraint added.
- **`version:sync` script** in root `package.json`: Keeps `hq-cli` version in lockstep with monorepo version.

### Fixed
- **`InitStateManager` path**: Init state file moved from repo root (`.hq-init-state.json`) to `~/.config/agent-hq/init-state.json` with automatic migration of existing files. Survives `git clean`.
- **`HQ_BROWSER_ENABLED`**: Changed from opt-out (`!== "false"`) to opt-in (`=== "true"`) — browser automation no longer starts by default on headless servers.
- **Ollama**: No longer blocks `hq init` if not installed — gracefully skipped with a note.
- **Dynamic binary resolution** in `morning-brief-audio.ts`: `python3`, `ffmpeg`, `gws` now resolved via `resolveBin()` walking `$PATH`; overridable via `PYTHON_BIN`, `FFMPEG_BIN`, `GWS_BIN` env vars.
- **Hardcoded personal paths** in `train.sh` and `convert.sh`: `~/.sblu-env` now uses `$HOME` instead of `/Users/calvinmagezi/`.

### Changed
- **`hq init` non-interactive**: Skips Google Workspace OAuth prompt (can be configured manually later).
- **Linux service management** (`hq start`): Detached spawn with PID file writing for `agent`, `relay`, `telegram`, `whatsapp`, `relay-server` targets.
- **`hq install` on Linux**: Generates systemd user unit files at `~/.config/systemd/user/` and enables them.
- **Log/PID paths**: Platform-conditional — `~/Library/Logs/` (macOS), `~/.local/share/agent-hq/{logs,pids}/` (Linux).

## [0.6.7] - 2026-03-15

### Added
- **SSE streaming** for HQ Control Center PWA chat: Real-time token-by-token streaming via Server-Sent Events.
- **Harness status indicator**: PWA shows which harness is active and its current state.
- **Morning brief audio** (`scripts/morning-brief-audio.ts`): Generates local audio digest via Kokoro TTS.

### Fixed
- **VPS/Linux compatibility**: Initial pass at cross-platform setup — replaced macOS-only log paths, added Linux detection in `hq start`.
- **`.gitignore` hardening**: Added `.discord-harness-sessions.json`, `.web-harness-sessions.json`, `.harness-active-pid`, and screenshot artifacts.

## [0.6.5] - 2026-03-13

### Added
- **Cross-Agent Planning System** (`@repo/hq-tools/planDB`): SQLite-backed plan tracking with FTS5 search, knowledge extraction, and `plan-sync` daemon task.
- **`hq plans`** CLI command: List, view, and manage agent plans from the terminal.
- **PWA Plans UI**: View active and completed plans in the HQ Control Center.

### Fixed
- Marketplace display bug in PWA (verified with screenshots).

## [0.6.4] - 2026-03-13

### Added
- **CLI Overhaul — New User Experience**: Complete rewrite of the CLI's first-run experience for new users and AI agents.
  - **`hq doctor`**: Diagnostic command checking 12 items (Bun, Git, vault, deps, API keys, Discord, Ollama, ports, MCP, services) with actionable fix suggestions for each failure.
  - **`hq env`**: Interactive API key setup — prompts for OpenRouter, Gemini, Discord keys with links to where to get them. Reads/preserves existing `.env.local` values.
  - **`hq pwa`** (aliases: `hq web`, `hq dashboard`): Starts the HQ Control Center PWA and opens browser automatically.
  - **`hq vault open`**: Opens the vault in Obsidian (auto-detects installation, shows download link if missing).
  - **`hq quickstart`**: Guided first-run wizard — walks through init, API keys, Obsidian setup, and prints a summary of next steps.
  - **`hq help --agent`**: Machine-readable ordered command checklist for AI agents using the CLI.
  - **Tiered help**: `hq help` now shows ~20 essential commands by default; `hq help --all` shows the full reference.
- **Node.js-compatible bootstrap** (`packages/hq-cli/bin/hq`): Rewritten from Bun TypeScript to plain Node.js CommonJS. `npx @calvin.magezi/agent-hq` now works even without Bun installed — auto-installs Bun via `curl` if missing.
- **Shared helpers** (`scripts/hq/shared.ts`): `readLine()`, `isPortInUse()`, `parseEnvFile()`, `writeEnvFile()` utilities.
- **Cross-Agent Planning System** (`@repo/hq-tools/planDB`): SQLite-backed plan tracking with FTS5 search. Includes `PlanKnowledgeEngine` for LLM-powered pattern extraction from completed plans and `planStatusSync` for frontmatter-to-DB synchronization.
- **Awake Replay Engine** (`@repo/vault-memory/awakeReplay`): Implements "preplay" and "credit assignment" via forward/reverse replay of memories. Triggered by job/task creation and completion to ground agent reasoning in past precedents.
- **HQ Browser Integration** (`packages/hq-browser`): Managed headless browser server with lifecycle management in the daemon. Adds `browser_open`, `browser_type`, `browser_click`, and `browser_screenshot` tools to the agent skillset.
- **Progressive Codebase Understanding** (`@repo/hq-tools/codemap`): Automated "codemap" generation. `CodemapEngine` tracks file purposes, exports, and patterns with confidence decay over time. Includes `codemapRefresher` background worker.
- **Daemon Task Expansion**: New background tasks for plan status syncing, pattern extraction, codemap refreshing, and plan archival/pruning.

### Changed
- **Post-init output**: Replaced `cmdHealth()` dump with structured "Getting Started" card showing numbered next steps.
- **hq-cli package**: Bumped to v0.6.4, removed Bun engine requirement (now `node >= 18.0.0`), removed dead Homebrew references from README.
- **Root README**: Updated Install section (npx works without Bun), CLI section (shows new commands), Quick Start for AI agents (uses `hq doctor`).
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

[Unreleased]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.13...HEAD
[0.6.13]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.12...v0.6.13
[0.6.12]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.10...v0.6.12
[0.6.10]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.9...v0.6.10
[0.6.9]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.8...v0.6.9
[0.6.8]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.7...v0.6.8
[0.6.7]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.5...v0.6.7
[0.6.5]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/CalvinMagezi/agent-hq/compare/v0.6.0...v0.6.4
[0.6.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/CalvinMagezi/agent-hq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/CalvinMagezi/agent-hq/releases/tag/v0.1.0
