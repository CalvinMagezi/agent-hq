# Changelog

All notable changes to Agent-HQ will be documented in this file.

## [0.6.0] — 2026-03-21

> **Note**: Continues from v0.5.0 (Bun/TS monorepo). This release marks the full Rust rewrite.
> The npm package `@calvin.magezi/agent-hq` is deprecated — the canonical distribution is now
> the `hq` binary from [GitHub Releases](https://github.com/CalvinMagezi/agent-hq/releases).

### Major: Modular Architecture Refactor

The monolithic `start.rs` (3,084 lines) has been decomposed into a clean 24-file module hierarchy under `crates/hq-cli/src/commands/start/`.

- **`start/mod.rs`** — Component orchestrator
- **`start/common.rs`** — Shared types (ChannelState, model aliases)
- **`start/agent.rs`** — Job polling worker
- **`start/harness/`** — CLI subprocess runner with 30-minute timeout + NDJSON parsing
- **`start/daemon/`** — Scheduler + tasks organized by cycle speed (fast/periodic/scheduled/slow)
- **`start/relay/`** — Discord + Telegram bot implementations
- **`start/touchpoints/`** — Reactive file-change engine with 6 handlers + synaptic chains

### Major: Touch Points Engine (Restored)

Reactive vault-change handlers wired to `hq-sync::FileWatcher`, restoring the old Bun/TS behavior:

- **frontmatter-fixer** — Adds missing YAML frontmatter on note create/modify, chains to tag-suggester
- **size-watchdog** — Warns at 10KB, alerts at 25KB, writes alert notes at 50KB
- **tag-suggester** — Keyword-based tag suggestion (projects + topics)
- **folder-organizer** — Suggests moves based on frontmatter `project:` field (path-sanitized)
- **conversation-learner** — Extracts decisions/learnings from completed threads
- **stale-thread-detector** — Urgency-aware staleness, auto-archives 3x stale threads
- Config read from `.vault/_system/TOUCHPOINT-CONFIG.md`, logs to `TOUCHPOINT-LOG.md`
- Synaptic chain propagation with depth limit of 3

### Major: Memory System Wired

All `hq-memory` crate subsystems connected to the daemon and agent worker:

- **Consolidation**: `memory-consolidation` daemon task now calls `hq_daemon::run_memory_cycle()` (was a TODO stub)
- **Forgetting**: `memory-forgetting` calls `MemoryForgetter::run_cycle()` — 3-tier synaptic homeostasis decay
- **Ingestion**: Agent worker ingests job results as memories via `MemoryIngester::ingest()` (best-effort, Ollama-dependent)
- **Awake Replay**: Forward replay surfaces precedent memories on job start; reverse replay does credit assignment on job completion
- **Context Engine**: Agent worker now uses the 5-layer `ContextEngine::build_frame()` with SOUL, memory, pinned notes, and budget-aware token allocation

### Major: Morning Brief Pipeline (Restored)

Replaced all three stub tasks with real implementations:

- **6:00 AM EAT** — LLM-generated [S1]/[S2] conversational script + Kokoro TTS audio
- **6:30 AM EAT** — NotebookLM notebook creation with curated sources
- **7:00 AM EAT** — Rich markdown brief with calendar agenda (via `gws`), pending jobs, news highlights

### Added

- **Evening reflection** — New daemon task at 8:45 PM EAT generates introspective self-analysis, ingested as long-term memory
- **Daily synthesis** — LLM-powered reflection on the day's activity (was a static stub)
- **Proactive bot notifications** — 5-minute check for stuck/unclaimed jobs, sends alerts to last-active Telegram channel
- **Channel presence tracking** — Telegram relay writes `CHANNEL-PRESENCE.md` on every message
- **Vault cleanup task** — Daily: reconciles stale jobs (3-day threshold), prunes old touchpoint backups, detects empty stubs
- **Frontmatter audit task** — Daily: backfills tags on 20 untagged notes/cycle using keyword matching
- **FTS5 indexing** — `embeddings` task now indexes 50 notes/cycle into SQLite FTS5 (was a TODO)
- **Graph link building** — `vault-health` task scans wikilinks and populates `graph_links` table
- **Vault health metrics** — Reports wikilink count, dead links, link health percentage
- **5-minute harness heartbeat** — Discord/Telegram show "Still working… (Xm elapsed)" during long harness runs
- **30-minute harness timeout** — Kills runaway CLI harness subprocesses
- **Rust CI workflow** — `cargo check` + `cargo test` + `cargo clippy` + release builds for macOS ARM + Linux x64
- **Africa/Uganda news feeds** — Added Al Jazeera and TechCabal to news-pulse

### Fixed

- **RSS parsing** — Fixed Atom format support (HN, Guardian now parse correctly)
- **Port binding panic** — Graceful error instead of `unwrap()` on WS port conflict
- **`hq restart`** — Now robustly kills processes by name matching (not just PID files), launches background process
- **`hq stop`** — Three strategies: PID files, `pgrep` name matching, port freeing via `lsof`
- **`hq` command** — Unified binary name (`hq` primary, `hq-rs` backward-compat symlink)
- **`.gitkeep` false positive** — Proactive check now filters non-`.md` files
- **Stale job threshold** — Reduced from 7 days to 3 days

### Security

- Removed hardcoded personal identity from LLM prompts (now reads from gitignored SOUL.md)
- Added path traversal validation in `parse_skill()` and `folder_organizer`
- Bot token no longer leaked in download error messages
- Hardcoded `localhost:5678` replaced with `config.ws_port`

### Removed

- Placeholder daemon tasks that did nothing: `sblu-retraining`, `team-optimizer`, `plan-extraction`
- Ghost touchpoint configs: `news-clusterer`, `news-linker`, `news-digest` chain (not implemented)
- `MORNING_BRIEF_ENABLED` env var gate (morning brief is now a core feature)

## [0.1.0] — 2026-03-20

Initial Rust rewrite. Single binary replacing the Bun/TypeScript monorepo.
