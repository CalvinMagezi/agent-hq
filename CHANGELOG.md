# Changelog

All notable changes to Agent-HQ are documented in this file.

---

## v0.1.0 — Complete Rust Rewrite (2025)

Agent-HQ has been completely rewritten from a Bun/TypeScript monorepo to a single Rust binary. This is a ground-up rewrite -- every component was reimplemented in Rust.

### What Changed

**Runtime**: Bun (Node.js-compatible) replaced by native Rust binary via Tokio.

**Binary size**: From ~200 MB node_modules to a single 6 MB statically-linked binary.

**Memory**: From ~80-150 MB (Node.js heap) to <50 MB resident.

**Architecture**: From Turborepo monorepo with 20+ npm packages to a Cargo workspace with 16 crates.

### Major Features

#### Core (Rust)
- 39 CLI commands via clap (derive mode)
- Single `~/.hq/config.yaml` config file (figment: YAML + env vars)
- SQLite database with WAL mode, FTS5 full-text search, and embedding storage
- Vault I/O with gray_matter frontmatter parsing
- Atomic job queue using filesystem rename operations

#### Agent
- Interactive terminal chat with streaming LLM responses
- Multi-harness agent sessions (hq, claude, gemini, opencode, codex)
- Orchestrator with discovery engine and execution tracing
- 5-layer token-budgeted context engine with surplus cascading
- Background worker with heartbeat and concurrent job execution

#### Tools
- 47 tool implementations: vault ops, skills, agents, diagrams, Google Workspace, image generation, TTS, browser automation, planning, benchmarks, workflows
- MCP stdio server with 2-tool gateway (hq_discover + hq_call) via rmcp

#### Relay
- Unified relay framework with PlatformBridge trait
- Discord adapter (serenity + poise): streaming, reactions, slash commands, threads
- Telegram adapter (teloxide): voice, photos, documents, reply context
- WhatsApp bridge (Baileys via Node.js): media handling, self-chat loop prevention
- CLI harness spawning for all 8 harnesses (Claude Code, Gemini CLI, OpenCode, Codex CLI, etc.)

#### Daemon
- 27 scheduled background tasks on interval-based scheduler
- Health checks (stuck jobs, offline workers)
- Embedding processor (batch embedding of new vault notes)
- Memory consolidation (cross-harness insight merging)
- Job cleanup (stale/done job expiry)
- Plan status sync
- News pulse aggregation
- DAEMON-STATUS.md written after every tick

#### Web
- Axum WebSocket server with REST API endpoints
- Embedded static web assets
- PWA dashboard (TanStack Start + React 19 + Vite PWA)
- Caddy reverse proxy for Tailscale HTTPS

#### Sync
- File watcher via notify crate
- E2E encrypted sync protocol (AES-256-GCM + PBKDF2)

#### Memory
- Ingester, consolidator, querier, and forgetter modules
- Cross-conversation memory extraction
- Queryable long-term fact storage

### Breaking Changes from TypeScript Version

- **No more npm/bun**: Install via `cargo build` instead of `bun install`
- **Config location changed**: `~/.hq/config.yaml` replaces scattered `.env.local` files
- **No more Turborepo**: Single `cargo build` command builds everything
- **Pi SDK removed**: Agent session loop is now native Rust
- **grammY replaced by teloxide**: Telegram adapter rewritten
- **discord.js replaced by serenity/poise**: Discord adapter rewritten
- **TanStack Start remains**: The PWA is still TypeScript but connects to the Rust backend
- **Baileys bridge remains**: WhatsApp adapter is still Node.js, connecting via HTTP API
- **Port changed**: WebSocket/API server is now on port 5678 (was 18900)

### Migration Notes

If upgrading from the TypeScript version:

1. **Build the Rust binary**: `cargo build --release -p hq-cli`
2. **Run init**: `hq init` to scaffold the new config file
3. **Move API keys**: Transfer keys from `.env.local` files into `~/.hq/config.yaml`
4. **Vault is compatible**: The `.vault/` directory format is unchanged -- markdown + YAML frontmatter, SQLite database in `_data/`
5. **Reinstall services**: Use `hq install all` to set up launchd/systemd units for the new binary
6. **PWA still needs npm**: `cd apps/hq-control-center && bun install && bun run build`

### Crate Map

| Crate | Replaces (TS) |
|-------|---------------|
| `hq-cli` | `packages/hq-cli` + `scripts/hq.ts` |
| `hq-core` | `packages/vault-types` + `packages/env-loader` |
| `hq-vault` | `packages/vault-client` |
| `hq-db` | SQLite logic from vault-client |
| `hq-llm` | LLM calls from agent-core |
| `hq-agent` | `apps/agent` + Pi SDK |
| `hq-context` | `packages/context-engine` |
| `hq-tools` | `packages/hq-tools` |
| `hq-mcp` | MCP server from hq-tools |
| `hq-daemon` | `scripts/agent-hq-daemon.ts` + touchpoints |
| `hq-sync` | `packages/vault-sync` + `packages/vault-sync-protocol` |
| `hq-memory` | `packages/vault-memory` |
| `hq-relay` | `packages/relay-adapter-core` + `packages/agent-relay-server` |
| `hq-relay-discord` | `apps/discord-relay` + `apps/relay-adapter-discord` |
| `hq-relay-telegram` | `apps/relay-adapter-telegram` |
| `hq-web` | `packages/agent-relay-server` (WS) + embedded UI |
