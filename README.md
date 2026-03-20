# Agent-HQ

> **A local-first AI agent hub. Single Rust binary. Your machine, your data, your agents.**

Agent-HQ connects AI coding agents (Claude Code, Gemini CLI, OpenCode, Codex CLI) to every communication channel you use -- Discord, Telegram, WhatsApp, a Tailscale-secured PWA -- while keeping all your data in a markdown vault on your filesystem.

No cloud backend. No vendor lock-in. One 6 MB binary.

---

## How It Works

```
You (PWA / Discord / Telegram / WhatsApp / Terminal)
     |
     +-- HQ Control Center PWA  --> Tailscale-secured, installable on any device
     +-- Discord Relay          --> Claude Code / Gemini CLI / OpenCode
     +-- Telegram Relay         --> Voice, photos, documents, harness picker
     +-- WhatsApp Bridge        --> Voice, images, docs (Baileys via Node)
     +-- Terminal Chat          --> Streaming REPL
              |
              v
       hq-web (Axum WS + REST, port 5678)
              |
              v
       .vault/  <-- single source of truth
         |
         +-- _system/   SOUL - MEMORY - CRON-SCHEDULE
         +-- _jobs/     atomic job queue (pending -> running -> done)
         +-- _threads/  cross-platform conversation history
         +-- _logs/     daily briefs, scheduled task output
         +-- _data/     vault.db (SQLite, WAL mode)
         +-- Notebooks/ your notes, memories, projects
```

The vault is the center. Every agent reads from it and writes back to it. Switching harnesses or platforms mid-conversation does not lose context.

---

## Quick Start

### Prerequisites

- **Rust** 1.83+ (2024 edition) -- `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **At least one LLM API key** -- OpenRouter, Anthropic, or Google AI

### Install from Source

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
cargo build --release -p hq-cli    # produces a ~6 MB binary
cp target/release/hq ~/bin/hq      # or wherever you keep binaries
```

### First Run

```bash
hq init                # scaffold vault, create config
hq doctor              # verify setup
hq chat                # start an interactive LLM session
```

### Configuration

All configuration lives in `~/.hq/config.yaml`:

```yaml
vault_path: /path/to/your/.vault
openrouter_api_key: "your-api-key-here"
default_model: "anthropic/claude-sonnet-4"
ws_port: 5678

relay:
  discord_token: "your-discord-bot-token-here"
  telegram_token: "your-telegram-bot-token-here"
  discord_enabled: true
  telegram_enabled: true

agent:
  name: "hq-agent"
  max_concurrent_jobs: 4
  heartbeat_interval_secs: 30

daemon:
  embedding_batch_size: 10
  embedding_interval_secs: 600
```

API keys can also be set via environment variables: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`.

---

## CLI Commands

Agent-HQ ships 39 commands in a single binary. Run `hq help` for full usage.

### Getting Started

| Command | Description |
|---------|-------------|
| `hq init` | Full setup wizard (vault + config + services) |
| `hq setup` | First-run scaffold (vault only) |
| `hq health` | System health check |
| `hq doctor` | Diagnose common issues |
| `hq env` | Set up API keys interactively |
| `hq version` | Show version and build info |

### Chat and Agents

| Command | Description |
|---------|-------------|
| `hq chat` | Interactive terminal chat (default command) |
| `hq agent [harness]` | Spawn agent session (hq, claude, gemini, opencode, codex) |
| `hq orchestrate <task>` | Intelligent delegation with discovery + tracing |

### Services

| Command | Description |
|---------|-------------|
| `hq status` | Show vault status and system info |
| `hq start [component]` | Start components (all, agent, daemon, relay, telegram, whatsapp) |
| `hq stop [component]` | Stop components |
| `hq restart [component]` | Restart components |

### Monitoring

| Command | Description |
|---------|-------------|
| `hq logs [target] -l N` | View last N log lines |
| `hq errors [target] -l N` | Show error log lines and failed jobs |
| `hq follow [target]` | Live-tail log files |
| `hq ps` | Show all managed processes |

### Vault Operations

| Command | Description |
|---------|-------------|
| `hq vault [sub]` | Vault operations (list, tree, read, write, stats, context) |
| `hq search <query>` | Search vault notes (FTS5 full-text search) |
| `hq memory [sub]` | Show/manage memory and system context |

### Jobs, Tasks, and Plans

| Command | Description |
|---------|-------------|
| `hq jobs [sub]` | List/create/cancel/show jobs |
| `hq tasks [sub]` | List/create/show tasks |
| `hq plans [sub]` | Browse cross-agent plans |

### Teams and Agents

| Command | Description |
|---------|-------------|
| `hq teams [sub]` | List teams and run team workflows |
| `hq agents [sub]` | List/inspect agent definitions |

### Configuration

| Command | Description |
|---------|-------------|
| `hq config [key] [value]` | Show or edit configuration |
| `hq mcp [sub]` | Install/manage MCP server for Claude Desktop or editors |

### Daemon

| Command | Description |
|---------|-------------|
| `hq daemon [sub]` | Daemon management (start, stop, status, logs) |

### Advanced

| Command | Description |
|---------|-------------|
| `hq kill` | Force-kill all managed processes |
| `hq clean` | Remove stale locks and orphaned files |
| `hq install [target]` | Install as system service (launchd on macOS, systemd on Linux) |
| `hq uninstall [target]` | Remove system service |
| `hq update` | Check for and apply updates |

### Tools and Diagrams

| Command | Description |
|---------|-------------|
| `hq tools` | Check/install CLI tools (Claude, Gemini, OpenCode) |
| `hq diagram [sub]` | Generate diagrams via DrawIt (flow, map, deps, routes) |
| `hq benchmark` | Run model benchmark suite |

### Usage, Sync, and Web

| Command | Description |
|---------|-------------|
| `hq usage [sub]` | Show usage statistics |
| `hq sync [sub]` | Vault sync status |
| `hq pwa` | Open HQ web dashboard (port 4747) |

---

## Architecture

### Crate Structure

Agent-HQ is a Cargo workspace of 16 crates:

| Crate | Purpose |
|-------|---------|
| `hq-core` | Types, config loading (figment), error types |
| `hq-vault` | Vault I/O -- notes, jobs, tasks, query builder, frontmatter |
| `hq-db` | SQLite connection pool, FTS5 full-text search, embeddings, graph links |
| `hq-llm` | LLM provider trait + OpenRouter integration (via async-openai) |
| `hq-agent` | Session loop, coding tools, governance rules, background worker |
| `hq-context` | 5-layer token-budgeted context engine with profile system |
| `hq-tools` | 47 tool implementations (vault, skills, agents, diagrams, GWS, etc.) |
| `hq-mcp` | MCP stdio server -- 2-tool gateway (hq_discover + hq_call) |
| `hq-daemon` | Background scheduler, health checks, cleanup, embedding processor |
| `hq-sync` | File watcher (notify), sync protocol, E2E encryption (AES-256-GCM) |
| `hq-memory` | Memory consolidator, ingester, querier, forgetter |
| `hq-relay` | Platform bridge trait, unified bot, harness spawning, command dispatch |
| `hq-relay-discord` | Discord adapter (serenity + poise) |
| `hq-relay-telegram` | Telegram adapter (teloxide) |
| `hq-web` | Axum WebSocket server, REST API, embedded static web UI |
| `hq-cli` | 39 CLI commands, clap-derived argument parsing |

### Key Dependencies

| Purpose | Crate |
|---------|-------|
| Async runtime | tokio |
| CLI parsing | clap (derive) |
| LLM client | async-openai (base URL swapped to OpenRouter) |
| MCP protocol | rmcp |
| Database | rusqlite (bundled, WAL mode) |
| Serialization | serde, serde_json, serde_yaml |
| Markdown | pulldown-cmark, gray_matter |
| Web server | axum + tower-http |
| Discord | serenity + poise |
| Telegram | teloxide |
| File watching | notify |
| Config | figment (YAML + env) |
| HTTP | reqwest |
| Encryption | aes-gcm, pbkdf2 |

---

## Relay Adapters

### Discord

Built-in via the `hq-relay-discord` crate (serenity + poise). Supports multi-harness switching, streaming responses, slash commands, reactions, and thread management.

```bash
hq start relay       # start Discord relay
```

### Telegram

Built-in via the `hq-relay-telegram` crate (teloxide). Supports voice notes, photos, documents, inline harness picker, and reply context.

```bash
hq start telegram    # start Telegram relay
```

### WhatsApp

Node.js bridge using Baileys (multidevice). Lives in `bridges/whatsapp/`. Connects to the Rust backend via the `/api/wa-message` endpoint.

```bash
cd bridges/whatsapp && bun install && bun run index.ts
```

---

## Daemon

The daemon runs 27 interval-based background tasks via `DaemonScheduler`. It ticks every 30 seconds and fires tasks when their interval elapses. Task categories include:

- **Health checks** -- detect stuck jobs and offline workers
- **Embedding processing** -- batch-embed new vault notes
- **Memory consolidation** -- cross-harness insight merging
- **Cleanup** -- expire stale jobs, remove orphaned files
- **Plan sync** -- track cross-agent plan status
- **News pulse** -- aggregated information updates

Status is written to `.vault/DAEMON-STATUS.md` after every tick.

```bash
hq daemon start      # start the background daemon
hq daemon status     # check daemon status
hq daemon logs       # view daemon logs
```

---

## MCP Server

Agent-HQ exposes its full tool registry via MCP (Model Context Protocol) through a 2-tool gateway:

| Tool | Purpose |
|------|---------|
| `hq_discover` | Search the registry by keyword -- returns matching tools + descriptions |
| `hq_call` | Execute any tool by name with JSON input |

### Configure for Claude Code

Add to your project `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "/path/to/hq",
      "args": ["mcp", "serve"],
      "env": {
        "VAULT_PATH": "/path/to/your/.vault",
        "OPENROUTER_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Available Tool Categories

| Category | Examples |
|----------|---------|
| Vault | vault_search, vault_read, vault_list, vault_write_note, vault_context |
| Planning | create_plan, update_plan, search_plans |
| Image | generate_image |
| Diagrams | drawit_render, drawit_flow, drawit_map, create_diagram |
| Google Workspace | google_workspace_schema, google_workspace_read, google_workspace_write |
| Browser | browser_open, browser_click, browser_screenshot |
| Voice | speak (TTS) |
| Teams | list_agents, load_agent, list_teams, run_team_workflow |
| Benchmarks | model_benchmark |
| Skills | list_skills, load_skill |

---

## PWA Dashboard

The HQ Control Center is a React PWA (TanStack Start + Vite) that connects to the Rust backend via WebSocket. It provides:

- Real-time agent streaming
- Vault search and browsing
- Daemon status monitoring
- Harness switching
- Document viewers (DOCX, XLSX, PDF)
- Push notifications

The PWA lives in `apps/hq-control-center/` and can be served via Caddy for HTTPS (e.g., over Tailscale).

```bash
hq pwa               # start the web dashboard on port 4747
```

For HTTPS via Tailscale, a `Caddyfile` is provided at the repo root that reverse-proxies the TanStack SSR server (port 4747) and Rust API/WS backend (port 5678).

---

## The Vault

The vault (`.vault/`) is the single source of truth. All agents read from it and write back to it.

### System Files

| File | Purpose |
|------|---------|
| `SOUL.md` | Agent identity and principles |
| `MEMORY.md` | Persistent facts and goals |
| `PREFERENCES.md` | User workflow preferences |
| `VISION.md` | Architectural vision |
| `CRON-SCHEDULE.md` | Full cron schedule |
| `HEARTBEAT.md` | Actionable items + news pulse |
| `DAEMON-STATUS.md` | Last run status of all daemon tasks |

### Directory Structure

```
.vault/
  _system/      system markdown files
  _jobs/        atomic job queue (pending/ -> running/ -> done/)
  _threads/     conversation history
  _logs/        daily briefs, task logs
  _data/        vault.db (SQLite)
  Notebooks/    user notes, projects, knowledge
```

---

## Context Engine

The context engine (`hq-context`) assembles token-budgeted context frames with 5 layers:

1. **System** -- SOUL + harness instructions
2. **UserMessage** -- the current user turn
3. **Memory** -- long-term facts (private tags stripped)
4. **Thread** -- recent messages, older ones compacted
5. **Injections** -- pinned notes + search results

Surplus tokens cascade between layers (thread 50%, injections 35%, memory 15%).

---

## Development

```bash
cargo check                        # type-check all 16 crates
cargo test                         # run all tests
cargo build --release -p hq-cli    # release build (~6 MB)
cargo clippy                       # lint
```

### Project Layout

```
crates/          16 Rust crates (the core of Agent-HQ)
apps/
  hq-control-center/   PWA dashboard (React + TanStack Start)
bridges/
  whatsapp/             WhatsApp bridge (Node.js + Baileys)
web/
  dist/                 Embedded static web assets
Cargo.toml              Workspace root
Caddyfile               HTTPS reverse proxy config
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Rust (2024 edition) |
| Runtime | Tokio |
| Data | Markdown vault + YAML frontmatter |
| Database | SQLite (rusqlite, bundled, WAL mode) |
| Search | FTS5 full-text + embedding vectors |
| LLM | OpenRouter via async-openai |
| CLI | clap (derive mode) |
| MCP | rmcp |
| Web server | Axum + tower-http |
| Discord | serenity + poise |
| Telegram | teloxide |
| WhatsApp | Baileys (Node.js bridge) |
| File watching | notify |
| Config | figment (YAML + env vars) |
| Encryption | AES-256-GCM (aes-gcm + pbkdf2) |
| PWA | TanStack Start + Vite PWA + React 19 |
| Build | Cargo workspace, LTO + strip in release |

---

## License

MIT -- see [LICENSE](LICENSE).
