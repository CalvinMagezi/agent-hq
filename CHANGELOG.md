# Changelog

All notable changes to Agent-HQ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Unattended Setup CLI** (`scripts/hq.ts`): Revamped `hq init` with step-tracking (`initState.ts`), dependency preflight auto-installation, and support for injecting API keys via shell environment variables (e.g. `OPENROUTER_API_KEY=... hq init -y`) for fully headless deployment.
- **`hq update` command** (`scripts/hq.ts`): New command to automatically fetch the latest version, update dependencies, and restart background services.
- **Speak Tool / TTS** (`packages/hq-tools/src/tools/tts.ts`): Added local Text-to-Speech tool featuring Kokoro-82M (default), F5-TTS (voice cloning from reference), and macOS `say` fallback.
- **Telegram Voice Notes** (`apps/relay-adapter-telegram/`): Telegram relay now converts all generated or sent audio files into OGG Opus format via `ffmpeg` so they render natively as voice notes in the app.
- **Vault Cartographer Worker** (`scripts/vault-workers/workers/vaultCartographer.ts`): New vault worker (SBLU-1) running every 4 hours to analyze vault structural health—finding dead links, orphans, and semantic cluster gaps using Ollama models.
- **SBLU Retraining Daemon** (`scripts/agent-hq-daemon.ts`): Added automated 3 AM EAT background task to trigger model fine-tuning and Weaver database retraining (`scripts/sblu/retrain.ts`).
- **Control Center Diagrams & Performance** (`apps/hq-control-center/`): Added Markdown Table support and a new DiagramViewer (`/drawit` route/canvas). Optimized AI chat token streaming with 50ms batching to prevent excessive re-renders.
- **Weaver Training Logging** (`apps/agent/lib/promptBuilder.ts`): RAG query context pairs are now logged to `_embeddings/weaver-training.jsonl` to improve SBLU-4 model embeddings retrieval.
- **HQ Control Center Vault Redesign** (`apps/hq-control-center/`): Moved `notes` and `chat` routes into a unified `/vault` UI with a slide-out Chat Panel. Added `SelectionToolbar` for sending text selections directly to the chat context.
- **Synaptic Homeostasis in Vault Memory** (`packages/vault-memory/`): Implemented memory decay and pruning mechanisms (`forgetter.ts`, `db.ts`) to actively remove old, low-importance, unconsolidated memories while protecting frequently-accessed ones.
- **Memory Ingestion Salience Detection** (`packages/vault-memory/src/ingester.ts`): Added `applySalienceBoost` to recognize important milestones and risks to boost their retention priority, mirroring biological synaptic tagging.
- **Topic Clustering Consolidation** (`packages/vault-memory/src/consolidator.ts`): Groups unconsolidated memories by topic for focused meta-synthesis insights.
- **Daily RSS News Pulse** (`scripts/agent-hq-daemon.ts`): Added `refreshNewsPulse` task that fetches headlines from selected tech feeds to organically update `HEARTBEAT.md` without API dependencies.
- **Codex CLI Harness** (`apps/discord-relay/src/harnesses/codex.ts`): Added Codex CLI harness (`codex exec --json`) with session resumption and standard orchestration context injection.
- **Claude Scheduled Tasks** (`scripts/agent-hq-daemon.ts`): New cron engine that automatically loads `SKILL.md` files from `~/.claude/scheduled-tasks/` and executes them via `claude -p` at scheduled intervals without session persistence.
- **Codex Web/WebSocket Support** (`apps/hq-control-center/`, `ws-server.ts`): Built-in Codex session and streaming support in HQ Control Center, along with a new chat scroll-to-bottom UI control.
- **Codex Telegram/WhatsApp Relay** (`apps/relay-adapter-telegram/`, `apps/relay-adapter-whatsapp/`): Integrated Codex local harness into Telegram and WhatsApp relay adapters, selectable via `!harness codex`.
- **HQ Web PWA** (`apps/hq-control-center/`): Migrated control center from Electron to a modern PWA served by Bun and Vite. Features new React frontend, WebSocket server, and backend API routes for managing agents and jobs.
- **Vault Sync Server** (`packages/vault-sync-server/`): Added vault sync and iCloud bridge daemons to the native agent tooling. Registered in macOS launchd via `hq start vault-sync` and `hq start icloud-bridge`.
- **Vault Memory Context** (`packages/vault-memory/`): Added memory consolidation workflow with native Ollama client integration.
- **Google Workspace Skill** (`packages/hq-tools/skills/google-workspace/`): Added agent skills and tools for integrating with Google Workspace APIs.
- **Context Engine** (`packages/context-engine/`): New unified, token-aware, and budget-driven context management layer. Replaces fragmented context assembly with a centralized engine that builds `ContextFrame`s. Features include token budgeting with cascaded surplus, layered assembly (system, memory, thread, injections), compaction strategies (thread summarization, chunk truncation), and an in-memory chunk index for notes. Wired into Discord relay and Agent Relay Server.
- **Vault Workers** (`scripts/vault-workers/`): Six lightweight AI background agents that proactively improve the Obsidian vault. Runs within the existing daemon scheduler when `VAULT_WORKERS_ENABLED=true`. Workers are write-light — they only create new notes (tagged `source: vault-worker`) and never modify existing ones, making them fully reversible. LLM cascade: Ollama (free, local) → Gemini Flash Lite → Gemini Flash, so workers never reach expensive frontier models.
  - **`gap-detector`** (6hr): Finds notes < 200 words and creates an analysis noting what content is likely missing.
  - **`idea-connector`** (4hr): Uses vector embeddings to find note pairs with high similarity (0.75–0.95) that share no wiki-links and explains the conceptual bridge.
  - **`project-nudger`** (24hr): Finds projects with no activity in 7+ days and suggests concrete next actions or archive decisions.
  - **`note-enricher`** (8hr): Suggests tags and a one-sentence summary for recently-created untagged notes.
  - **`daily-preparer`** (24hr, time-gated 22:00–23:59): Creates a briefing note for tomorrow based on today's memories and pending job queue.
  - **`orphan-rescuer`** (12hr): Finds notes in the embedding index with zero graph connections and suggests which existing notes they could link to.
  - **`AuditLog`** (`scripts/vault-workers/auditLog.ts`): Append-only per-day audit trail at `_logs/workers/YYYY-MM-DD.md`.
  - **`WORKER-STATUS.md`** (`_system/WORKER-STATUS.md`): Per-worker run stats (processed, created, LLM calls, errors) written after each run, mirroring `DAEMON-STATUS.md`.
- **Ollama provider** (`apps/agent/lib/modelConfig.ts`): Added `"ollama"` as a native provider. `isOllamaModel()` helper, `checkOllamaHealth()` lightweight health-check (2s timeout), and `buildModelConfig()` branch that maps `ollama/<model>` IDs to the OpenAI-compatible local endpoint (`http://localhost:11434/v1`). Zero cost config; no API key required.
- **Worker-tier fallback chain** (`apps/agent/lib/modelFallback.ts`): `ollama/qwen3.5:9b → gemini-2.5-flash-lite → gemini-2.5-flash` and `ollama/llama3.2:3b → gemini-2.5-flash-lite → gemini-2.5-flash` chains ensure workers never escalate to expensive frontier models.
- **WhatsApp full media capabilities** (`apps/relay-adapter-whatsapp/`): All Baileys-supported message types — image/video/document/sticker send+receive, AI vision for received images (OpenRouter), polls, locations, contacts (vCard), reactions (auto 👁️/✅), message editing/deletion/forwarding, reply quoting, WhatsApp-native markdown formatting. 9 new commands: `!react`, `!poll`, `!location`, `!sticker`, `!forward`, `!delete`, `!edit`, `!media`, `!format`. New files: `formatter.ts` (markdown→WhatsApp), `media.ts` (MediaHandler with vision, sticker conversion via sharp, temp file management).

- **WhatsApp agentic orchestration** (`apps/relay-adapter-whatsapp/src/bot.ts`): Messages auto-route through the HQ agent → Discord harness delegation pipeline with live status updates via vault event subscriptions (`task:claimed`, `task:completed`, `job:completed`). 10-minute failsafe timeout with fallback to direct OpenRouter chat.
- **WhatsApp native orchestration** (`apps/relay-adapter-whatsapp/src/orchestrator.ts`): Intent classification auto-delegates workspace tasks (calendar, Gmail, Drive) to Gemini CLI and coding tasks (git, debug, refactor) to Claude Code, with general chat going direct.
- **WhatsApp model identity** (`apps/relay-adapter-whatsapp/src/bot.ts`): `!model` shows actual active model name; `!gemini` shortcut for Gemini 2.5 Flash via OpenRouter; system prompt includes model capabilities and routing guidance.
- **CFO agent** (`apps/cfo/`): Financial intelligence agent for Agent-HQ with budget tracking and cost analysis.
- **WhatsApp Relay Adapter** (`apps/relay-adapter-whatsapp/`): Native WhatsApp self-chat relay using Baileys. This enables routing messages via the relay server and is securely locked to the owner's self-chat via `WHATSAPP_OWNER_JID`.
- **`hq wa` commands** (`scripts/hq.ts`): New commands for managing the WhatsApp adapter including `hq wa` (foreground), `hq wa reset` (clear thread), `hq wa reauth` (clear credentials), and service management like `hq start whatsapp`.
- **Relay Server fallback** (`packages/agent-relay-server/src/handlers/chat.ts`): Added OpenRouter fallback logic if the agent bridge is disabled (`AGENT_WS_PORT=0`), enabling direct OpenRouter routing.
- **`hq init` command** (`scripts/hq.ts`): Full first-time setup in one command — checks prerequisites, installs dependencies, scaffolds vault, creates `.env.local` templates, installs macOS launchd daemons, and adds `hq` to PATH. Supports `--non-interactive` flag for agent-driven installs.
- **`hq tools` command** (`scripts/hq.ts`): Installs and authenticates Claude CLI, Gemini CLI, and OpenCode. Automatically installs the Google Workspace extension for Gemini and writes the Obsidian MCP server config to `~/.gemini/settings.json`.
- **`hq setup` command** (`scripts/hq.ts`): Inline vault scaffolding (previously only `scripts/setup.ts`). Creates all `.vault/` directories and seeds system files.
- **`hq daemon` command** (`scripts/hq.ts`): Manage the background workflow daemon — `start`, `stop`, `status`, `logs [N]` subcommands with PID file tracking.
- **`packages/hq-cli/`**: New NPM package `agent-hq` — `bunx agent-hq` delegates to `scripts/hq.ts` inside the repo or bootstraps a fresh install when run globally.
- **`homebrew/hq.rb`**: Homebrew formula ready to publish as `brew install calvinmagezi/agent-hq/hq`.

### Changed
- **Web Digest Rewrite** (`scripts/workflows/web-digest.ts`): Switched from Brave Search to a local RSS feed aggregation model via `DIGEST-FEEDS.md`, using local Ollama if available for free synthesis.
- **Vault WebSockets Context Injection** (`apps/hq-control-center/ws-server.ts`): Server now accepts UI context (file or text selection) for chat messages, passing it to the AI.
- **Novelty Deduplication in Queries** (`packages/vault-memory/src/querier.ts`): Prevents repetitive context flooding by filtering redundant memories.
- **`hq-cli` renamed** to `@calvin.magezi/agent-hq` (npm squatting conflict with existing `agent-hq` package).
- **`hq` CLI targets**: Updated `start`, `stop`, `restart`, `logs`, `errors`, `fg`, `status`, and `health` commands to natively support `whatsapp` and `relay-server`.
- **`install-launchd.sh`**: Added `com.agent-hq.relay-server` and `com.agent-hq.whatsapp` to macOS launchd services installation.
- **`scripts/hq.ts`** help text: Fixed spacing/alignment bugs; restructured into logical sections with new FIRST-TIME SETUP and BACKGROUND DAEMON groups.
- **`package.json`** (root): `status` and `setup` scripts now delegate to `hq.ts`; added `tools` and `hq` script aliases.
- **`README.md`**: Rewrote install, Quick Start, Full Setup, and "Setup for AI Agents" sections to use the `hq` CLI. Added `bunx agent-hq` / Homebrew install instructions and full `hq` CLI reference table.
- **`CLAUDE.md`**: Updated monorepo structure and Development Commands to reflect `hq` as the single CLI entry point and `packages/hq-cli/` as the NPM package.

### Fixed
- **`vault-client` getPendingTasks** (`packages/vault-client/`): Now scans `_delegation/pending/` directory for legacy markdown task files, fixing delegation routing for bots that use file-based task detection.
- **`hq-cli` npm bin name**: Fixed binary name in package.json and updated Homebrew formula sha256.
- **WhatsApp chat timeout**: Bumped from 2min to 10min to accommodate longer LLM responses; added `GROQ_API_KEY` to launchd plist for voice transcription.

### Removed
- **External Orchestrators & Finance Agents**: Removed `COO` and `CFO` background processes, `hq coo` CLI commands, and related watchdog/daemon integrations.
- **OpenClaw Bridge**: Removed `initBridge` and `stopBridge` logic from the daemon.
- **Queue/fbmq Setup**: Removed `fbmq` queue initialization from `scripts/setup.ts` and dropped related directories (`_fbmq/*`, `_delegation/coo_*`, `_system/orchestrators`) from vault defaults.
- **Control Center Share Route**: Removed the `/share` PWA route and sidebar link from `apps/hq-control-center`.
- **`scripts/agent-hq-status.ts`**: Superseded by `hq status` / `hq health`.
- **`scripts/migrate-queues.ts`**: One-time migration utility no longer needed.
- **`scripts/setup-gemini-plugins.sh`**: Superseded by `hq tools`.

### Security
- **WhatsApp media handler**: Path traversal sanitization on document filenames (strip directory components via `path.basename()` + character whitelist). WebP magic byte detection fixed to check RIFF subtype bytes 8-11 (prevents WAV/WebP confusion). Prompt injection delimiting with `<user_message>` tags in delegation instructions. Task-to-job ID tracking prevents wrong-job race condition from clearing `processing` flag prematurely. TTS availability check (`canSynthesize`) before enabling `!voice on`.
- **`scripts/hq.ts` — `isAlive()`**: Added numeric PID validation before shell interpolation, preventing injection via tampered lock/PID files.
- **`scripts/hq.ts` — `cmdCoo install`**: Replaced `execSync(\`git clone ${arg}...\`)` with `spawnSync("git", ["clone", arg, targetDir])` to eliminate command injection via user-controlled URL.
- **`scripts/hq.ts` — `cmdInit`**: Replaced `sh(\`git clone ${repoUrl}...\`)` with `spawnSync` for the same reason.
- **`scripts/hq.ts` — `confirmInstall()`**: Prompt passed as `$1` positional argument to `bash -c` instead of string interpolation, eliminating bash injection via prompt text.
- **`packages/discord-core/src/fileAttachments.ts`**: Added `isPathAllowed()` path confinement before reading any AI-referenced file. Permitted roots: `VAULT_PATH` and `tmpdir()`. Dotfiles rejected unconditionally, blocking prompt-injection exfiltration of `~/.ssh`, `~/.aws`, etc.

### Added (2026-03-03)
- **DrawIt diagram pipeline** (`scripts/hq.ts`, `packages/hq-tools/`): End-to-end diagram generation via `hq diagram` CLI command. Supports `flow` (flowcharts with decision diamonds), `create` (structured architecture/graph with auto-layout), `map` (codebase architecture map), `deps` (package dependency graph), `routes` (Next.js route tree), and `render` (export existing `.drawit` to PNG). Outputs `[FILE: path | name]` marker for automatic image sharing.
- **`!diagram` / `!draw` Discord command** (`apps/discord-relay/src/commands.ts`): Instant diagram generation bypassing the LLM — runs `hq diagram <args>` via `execSync`, parses the `[FILE:]` marker, and returns the PNG as a Discord file attachment. Shown in `/help` embed for all harness types.
- **`!diagram` / `!draw` WhatsApp command** (`apps/relay-adapter-whatsapp/src/bot.ts`): Same pipeline as Discord — runs `hq diagram`, parses `[FILE:]` marker, sends PNG via `bridge.sendImage()`. Listed in `!help` output.
- **Diagram instructions in context enricher** (`packages/agent-relay-server/src/bridges/contextEnricher.ts`): System prompt for all harness types (claude-code, gemini-cli, opencode) now includes `hq diagram` usage instructions so AI agents know to use the CLI for diagram requests and include the `[FILE:]` marker in their responses.
- **`packages/hq-tools/src/tools/drawit.ts`**: New tool file exposing `DrawItFlowTool`, `AnalyzeDiagramTool`, and `CreateDiagramTool` for agent-facing diagram generation — no NDJSON knowledge required; handles SVG export and PNG conversion automatically.
- **DrawIt skill** (`packages/hq-tools/skills/drawit/SKILL.md`): Agent skill documentation for diagram creation patterns.
- **Telegram relay adapter** (`apps/relay-adapter-telegram/`): Full-featured Telegram bot relay with Telegraf. Supports text messages, image/document/voice note receive and send, AI vision (OpenRouter), voice transcription (Groq Whisper), TTS voice replies (OpenAI), and commands: `!help`, `!model`, `!gemini`, `!reset`, `!status`, `!voice`. Locked to a single authorised `TELEGRAM_USER_ID` via `guard.ts`.
- **Telegram harness orchestration** (`apps/relay-adapter-telegram/src/orchestrator.ts`, `sessionOrchestrator.ts`): Intent-based routing (coding→Claude Code, workspace→Gemini CLI, general→direct OpenRouter) with persistent per-harness session IDs for conversation continuity.
- **Telegram formatter** (`apps/relay-adapter-telegram/src/formatter.ts`): Converts markdown/Discord formatting to Telegram HTML parse mode (`<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`). Strips unsupported markdown syntax.
- **`hq tg` CLI commands** (`scripts/hq.ts`): `hq tg` (foreground debug), `hq tg reset` (clear state + session), `hq tg status`, `hq tg logs [N]`, `hq tg errors [N]`. Added `telegram` to `hq start|stop|restart` targets.
- **`telegram` client type** (`packages/agent-relay-protocol/src/client.ts`, `types.ts`): Added `"telegram"` as a valid `clientType` in `RelayClientConfig` and `AuthMessage`.
- **Telegram preamble in context enricher** (`packages/agent-relay-server/src/bridges/contextEnricher.ts`): Dedicated Telegram system prompt instructing HTML-only formatting and mobile-friendly response style.

- **Agent roles system** (`apps/agent/lib/agentRoles.ts`): New `AgentRole` type (`worker | researcher | reviewer | planner | devops | coder | workspace`) formalising agent specialisations across the delegation pipeline.
- **Execution modes** (`apps/agent/lib/executionModes.ts`): `ExecutionMode` type (`quick | standard | thorough`) with per-mode context budget multipliers (0.5× / 1× / 2×). Exposed as optional params on `delegate_to_relay` tool.
- **Model fallback** (`apps/agent/lib/modelFallback.ts`): Automatic model fallback chain helper for graceful degradation when primary model is unavailable.
- **WhatsApp `[FILE:]` attachment sending** (`apps/relay-adapter-whatsapp/src/bot.ts`): `extractAndSendFiles()` method strips `[FILE: /path | name]` markers from AI responses and sends each file as a WhatsApp image, matching the existing Discord attachment pattern.
- **`opencode` harness target** (`apps/relay-adapter-whatsapp/src/orchestrator.ts`): Added `"opencode"` as an explicit `TargetHarness` value.
- **Granular `DetectedRole`** (`apps/relay-adapter-whatsapp/src/orchestrator.ts`): `detectIntent()` now returns a `DetectedRole` alongside intent/harness — sub-classifies coding messages into `reviewer | planner | devops | researcher | coder`.
- **Agent skill bridge** (`apps/agent/skills.ts`): `SKILLS_DIR`, `getAutoLoadedSkillContent`, `buildSkillsSummary` are now re-exported from `@repo/hq-tools`, keeping skills centrally managed and available to all agents.
- **`@repo/hq-tools` workspace dependency** (`apps/agent/package.json`): Added `"@repo/hq-tools": "workspace:*"` so the agent can consume shared tools from the monorepo package.
- **`packages/hq-tools/`**: New shared package consolidating skill loading utilities and shared tooling across agents.

### Changed (2026-03-03)
- **WhatsApp formatter placeholders** (`apps/relay-adapter-whatsapp/src/formatter.ts`): Replaced `__CODEBLOCK_N__` / `__INLINECODE_N__` string sentinels with null-byte delimiters (`\x00CBN\x00` / `\x00ICN\x00`) to prevent regex false-positives when code blocks contain double-underscores.
- **WhatsApp reconnect logic** (`apps/relay-adapter-whatsapp/src/whatsapp.ts`): Separate handling for `loggedOut` (hard exit) vs `connectionReplaced` (15s back-off vs 3s). Removed `shouldIgnoreJid` hook from Baileys config — security filtering moved entirely to `handleMessagesUpsert` via `WhatsAppGuard` to prevent Baileys internal protocol message loss.
- **`governance.ts` / `index.ts`** — `role` and `executionMode` args threaded through to delegation calls.
- **`promptBuilder.ts`** — Updated to consume role and executionMode for context-aware prompt construction.
- **`modelConfig.ts`** — Model configuration updated to support new fallback chain.
- **`SkillLoader` methods** (`apps/agent/skills.ts`): `getAutoLoadedContent()` and `loadAllSkills()` now delegate to `@repo/hq-tools`, trimming ~40 lines of duplicate logic.

### Fixed (2026-03-03)
- **WhatsApp Desktop conflict**: `connectionReplaced` disconnect code now triggers a 15s delay (vs 3s) before reconnect, reducing rapid reconnection loops when WhatsApp Desktop is also active.
- **`load_skill` error message**: Now lists available skills when the requested skill is not found, aiding discoverability.

### Added (prior entries)
- **`hq` CLI — unified entry point** (`scripts/hq.ts`): All management now flows through the single `hq` command. New commands: `hq init` (full first-time setup), `hq tools` (install + authenticate Claude CLI / Gemini CLI / OpenCode), `hq setup` (vault scaffold), `hq daemon start|stop|status|logs` (background daemon management).
- **`hq init --non-interactive`**: Fully scriptable, agent-runnable install — checks prerequisites, clones repo, installs deps, sets up CLI tools, scaffolds vault, creates `.env.local` templates, installs launchd daemons, and adds `hq` to PATH. No prompts required.
- **`hq tools`**: Interactive and non-interactive CLI tool installer. Checks for and installs Claude Code CLI, Gemini CLI, and OpenCode via npm; verifies authentication; installs Google Workspace extension for Gemini; writes Obsidian MCP server config to `~/.gemini/settings.json`.
- **`packages/hq-cli/`** — NPM package `agent-hq` (`bunx agent-hq`): Thin wrapper that delegates to `scripts/hq.ts` when inside the monorepo, or bootstraps a fresh install via `hq init` when run globally.
- **Homebrew formula** (`homebrew/hq.rb`): Ready-to-publish formula for `brew tap calvinmagezi/agent-hq && brew install hq`.
- **Discord file attachments** (`packages/discord-core/src/fileAttachments.ts`): All bots can now send files. AI responses include `[FILE: /path]` markers; the bot strips them and uploads as Discord attachments.
- **`@repo/discord-core` package** (`packages/discord-core/`): Shared Discord implementation (DiscordBotBase, chunking, streaming, thread management, presence, typing, intent classification, command registry) used by both the relay and the HQ agent bot.

### Changed
- **`hq` CLI help text** reformatted with correct spacing, aligned columns, and grouped sections.
- **Root `package.json`**: `status`, `setup`, `tools` scripts now delegate to `hq.ts`; `"hq"` shortcut added.
- **README.md**: Rewrote Install, Quick Start, Full Setup, and Setup for AI Agents sections around the new `hq` CLI. Added `hq` command reference table.
- **CLAUDE.md**: Updated monorepo structure, CLI section, and dev commands to reflect the consolidated CLI.

### Removed
- **`scripts/agent-hq-status.ts`**: Superseded by `hq status` and `hq health`.
- **`scripts/migrate-queues.ts`**: One-time migration utility, no longer needed.
- **`scripts/setup-gemini-plugins.sh`**: Superseded by `hq tools`.
- **`apps/discord-relay/src/chunker.ts`**, **`apps/discord-relay/src/intent.ts`**: Moved to `@repo/discord-core`.
- **`apps/agent/lib/discordPresence.ts`**, **`apps/agent/lib/intentClassifier.ts`**: Moved to `@repo/discord-core`.

### Security
- **`isAlive()`**: Validates PID is numeric before shell interpolation, preventing injection from tampered lock files.
- **`cmdCoo install`**: Replaced `execSync(\`git clone ${arg}\`)` with `spawnSync("git", ["clone", arg, ...])` to eliminate shell injection.
- **`cmdInit` clone**: Replaced `sh(\`git clone ${repoUrl}\`)` with `spawnSync` for the same reason.
- **`confirmInstall()`**: Prompt string now passed as a positional bash argument (`$1`) instead of being interpolated into `-c "..."`, preventing prompt injection.
- **`fileAttachments.ts`**: Added `isPathAllowed()` path confinement — `[FILE:]` markers are only honoured for paths inside `VAULT_PATH` and the OS temp directory, blocking prompt-injection-driven exfiltration of credentials or system files.

### Added
- **Pluggable COO Architecture** (`apps/agent/lib/cooRouter.ts`, `packages/vault-client/src/orchestratorAdapter.ts`): Implementation of the Chief Operating Officer (COO) routing pattern. Allows delegating intent planning to external orchestrators while maintaining a secure sandboxed bridge.
- **`fbmq` Queue Integration** (`packages/vault-sync/src/eventBus.ts`, `scripts/setup.ts`): Transitioned delegation and job queues to `fbmq` for improved reliability and performance. Added `_fbmq/` directory monitoring to `EventBus`.
- **COO Watchdog & Bridge** (`scripts/agent-hq-daemon.ts`, `scripts/orchestrator-bridge/`): New daemon task for monitoring external orchestrators with heartbeat tracking, dead man's switch (auto-revert to internal mode), and circuit breakers for rate/error anomalies.
- **Queue Migration Utility** (`scripts/migrate-queues.ts`): CLI tool to migrate legacy file-based pending tasks and jobs to the new `fbmq` system.
- **COO CLI Command** (`scripts/hq.ts`): Added `hq coo` command for orchestrator management.
- **HQ Control Center (React/Electron App)** (`apps/hq-control-center/`): Added a new desktop interface featuring a Simulation Room with pixel-art avatars, a responsive VaultGraph view, layout + furniture management, settings page and a backend Electron Daemon Manager.
- **Ignored Build Outputs**: Added `.gitignore` rules for `release/` in Control Center to prevent committing built binaries.
- **Code Mode & Graph-RAG** (`apps/agent/skills/code-mapper/`, `packages/vault-client/src/graph.ts`, `packages/vault-mcp/src/tools/code-graph.ts`): Implemented a deterministic codebase mapping system that translates architecture into Obsidian notes. Features include blast radius analysis, outbound dependency context, and native HQ Agent tool integration (no MCP hop required for basic graph queries).
- **Skill Awareness for HQ Agent** (`apps/agent/lib/chatSession.ts`, `apps/agent/skills.ts`): HQ Agent now has native `load_skill` and `list_skills` tools. Added `code-mapper` to `AUTO_LOAD_SKILLS` to ensure the Code Mode protocol is always in-context during coding tasks.
- **Context budget accounting** (`apps/agent/index.ts`): Pre-calculates prompt component sizes and dynamically truncates pinned notes and skills when approaching the ~100K character limit
- **Adaptive safety breaker** (`apps/agent/index.ts`): `MAX_TOOL_CALLS` now scales per security profile — ADMIN: 50, GUARDED/STANDARD: 20, MINIMAL: 5
- **Timestamp injection** (`apps/agent/index.ts`): HQ agent prompts now include `Current time: <ISO timestamp>` for time-aware reasoning
- **Terminal chat dynamic context** (`scripts/agent-hq-chat.ts`): Refactored from static system prompt to per-turn dynamic context with recent activity, semantic search, and full timestamp
- **Terminal chat memory intents** (`scripts/agent-hq-chat.ts`): `[REMEMBER:]`, `[GOAL:]`, and `[DONE:]` tags now processed in CLI responses, matching Discord relay behavior
- **MEMORY.md auto-rotation** (`packages/vault-client/src/agentAdapter.ts`): Work log entries capped at 20 — oldest entries automatically pruned on append
- **RECENT_ACTIVITY.md entry types** (`packages/vault-client/src/types.ts`): `RecentActivityEntry` and `LiveTaskOutput` interfaces
- **Recent activity context API** (`packages/vault-client/src/index.ts`): `getRecentActivity()` and `getRecentActivityContext()` methods for cross-surface conversation history
- **Delegation planner tool** (`apps/agent/lib/delegationPlannerTool.ts`): Clarification-first protocol for orchestrator task planning
- **Delegation tools (vault)** (`apps/agent/lib/delegationToolsVault.ts`): Full vault-based delegation tool implementations
- **Live task output tracking** (`packages/vault-client/src/index.ts`): `writeLiveOutput()` and `readLiveOutput()` for streaming delegation results
- **Stale live output cleanup** (`scripts/agent-hq-daemon.ts`): Daemon now purges stale `_delegation/live/*.md` files older than 1 hour
- **Discord bot for HQ agent** (`apps/agent/discordBot.ts`): Direct Discord integration for the HQ agent
- **Chat session manager** (`apps/agent/lib/chatSession.ts`): Async system context building with vault integration
- **`vault-gateway` package** (`packages/vault-gateway/`): New authenticated proxy between HQ agents and the Obsidian Local REST API. Hono-based server with bearer-token ACL middleware (admin / relay / readonly roles), path-based ACL for relay agents, and transparent HTTPS proxying with self-signed cert support
- **`vault-mcp` package** (`packages/vault-mcp/`): New MCP server exposing the vault over the Model Context Protocol. Tools: filesystem CRUD, note read/write with auto-locking, advisory lock acquire/release, REST API passthrough, advanced batch-read, and tag/frontmatter management
- **`VaultEventBus`** (`packages/vault-client/src/events.ts`): File-system event bus using `fs.watch` — emits typed `VaultEvent` objects (`note:created`, `note:modified`, `note:deleted`, `system:modified`, `job:created`, `approval:created`) with debouncing and path filtering

### Changed
- **Discord relay streaming** (`apps/relay-adapter-discord/src/bot.ts`): Replaced single-message-edit pattern with progressive multi-message delivery — sends reply chunks at paragraph boundaries instead of editing a placeholder
- **Discord relay context enrichment** (`apps/discord-relay/src/context.ts`): Enhanced system instructions for claude-code, gemini-cli, and opencode harnesses with clarification-first protocol and delegation guidelines
- **Gemini harness** (`apps/discord-relay/src/harnesses/gemini.ts`): Improved prompt construction and tool integration
- **OpenCode harness** (`apps/discord-relay/src/harnesses/opencode.ts`): Enhanced streaming and context handling
- **RECENT_ACTIVITY.md frontmatter** (`packages/vault-client/src/index.ts`): Content truncated to 200 chars in YAML frontmatter to prevent file bloat while keeping full text in markdown body
- **Health check** (`scripts/hq.ts`): Fixed `opencode` version check flag (`--version` instead of `version`)
- **`hq restart` single-instance enforcement** (`scripts/hq.ts`): Restart now runs `findAllInstances()` before and after stop, force-kills any survivors with `kill -9`, then confirms exactly one process per target is alive after start — eliminates duplicate agent/relay processes
- **Vault Sync Ignore Pattern** (`packages/vault-sync/src/utils.ts`): Added `.tmp/` to ignored sync patterns.

### Removed
- **Legacy OpenClaw Bridge** (`scripts/openclaw-bridge.ts`): Replaced by the unified `orchestrator-bridge`.

### Security
- **Env var scrubbing expanded** (`apps/agent/governance.ts`): Added `DISCORD_BOT_TOKEN_OPENCODE` and `DISCORD_BOT_TOKEN_GEMINI` to `SENSITIVE_ENV_VARS` — prevents leakage to child processes
- **Network egress logging** (`apps/agent/governance.ts`): Bash spawn hook now logs when child processes use `curl`, `wget`, `nc`, `ping`, or `ssh`
- **Path sandboxing** (`apps/agent/governance.ts`): `ToolGuardian` accepts `allowedPaths` and blocks file write operations outside `TARGET_DIR` and `VAULT_PATH`
- **`vault-gateway` agent token auth hardened** (`packages/vault-gateway/src/server.ts`): Replaced hardcoded placeholder tokens (`admin-secret-token`, `relay-secret-token`) with env-var-driven parsing via `AGENT_TOKENS`. Format: comma-separated `token:role:id` triples. Server exits immediately on startup if no tokens are configured outside of mock/test mode
- **`vault-gateway` `.env.example`** (`packages/vault-gateway/.env.example`): Added environment template documenting all required variables; includes `openssl rand -hex 32` tip for generating secure tokens

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
