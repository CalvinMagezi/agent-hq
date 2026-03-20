# CLAUDE.md

## What This Is

Agent-HQ: Rust-based local-first AI agent hub. Single 6MB binary. Data lives in `.vault/` (markdown vault, gitignored).

## Architecture

- **Language**: Rust (Cargo workspace, 16 crates)
- **Binary**: `hq` at `~/bin/hq-rs` (6.0MB release build)
- **Config**: `~/.hq/config.yaml`
- **Vault**: `.vault/` (markdown + frontmatter, same format as before)
- **DB**: `.vault/_data/vault.db` (single SQLite, WAL mode)
- **LLM**: OpenRouter via `async-openai` with base URL swap

## Rules

- All source in `crates/` — standard Rust conventions (snake_case)
- `.vault/` is the center — shared memory, context engine, knowledge base
- Frontmatter: `gray_matter` crate (Rust port of JS gray-matter)
- Job/task claiming: `std::fs::rename` for atomic ops (NotFound = race lost)
- **Self-modification ban**: Agents MUST NOT write into the repo. Output → `.vault/`
- **No personal files in repo**: Use `.vault/` or external paths

## Entry Points

| What | Path |
|------|------|
| CLI binary | `crates/hq-cli/src/main.rs` |
| Agent session | `crates/hq-agent/src/session.rs` |
| Agent worker | `crates/hq-agent/src/worker.rs` |
| MCP server | `crates/hq-mcp/src/server.rs` |
| Daemon scheduler | `crates/hq-daemon/src/scheduler.rs` |
| Context engine | `crates/hq-context/src/engine.rs` |
| Vault client | `crates/hq-vault/src/client.rs` |
| Search (FTS5 + semantic) | `crates/hq-db/src/search.rs` |
| Discord bridge | `crates/hq-relay-discord/src/bridge.rs` |
| Telegram bridge | `crates/hq-relay-telegram/src/bridge.rs` |
| Memory system | `crates/hq-memory/src/lib.rs` |
| Sync protocol | `crates/hq-sync/src/crypto.rs` |

## Development

```bash
cargo check          # Type check all 16 crates
cargo test           # Run all 74 tests
cargo build --release -p hq-cli  # Release build (6MB)
cargo clippy         # Lint
```

## Crates

| Crate | Purpose |
|-------|---------|
| `hq-core` | Types, config, errors |
| `hq-vault` | Vault I/O, notes, jobs, tasks, query builder |
| `hq-db` | SQLite pool, FTS5, embeddings, graph links |
| `hq-llm` | LLM provider trait + OpenRouter |
| `hq-agent` | Session loop, coding tools, governance, worker |
| `hq-context` | 5-layer context engine, budgets, chunks |
| `hq-tools` | 47 HQ tools (vault, skills, agents, diagrams, etc.) |
| `hq-mcp` | MCP stdio server (2-tool gateway) |
| `hq-daemon` | Background scheduler, health, cleanup |
| `hq-sync` | File watcher, sync protocol, E2E crypto |
| `hq-memory` | Consolidator, ingester, querier, forgetter |
| `hq-relay` | Platform bridge, unified bot, harness |
| `hq-relay-discord` | Discord adapter (serenity/poise) |
| `hq-relay-telegram` | Telegram adapter (teloxide) |
| `hq-web` | WebSocket server, embedded web UI |
| `hq-cli` | 39 CLI commands |

## CLI Tools Available

- **`gws`** — Google Workspace CLI (`/opt/homebrew/bin/gws`, v0.8.0)
- **`hq-rs`** — Agent-HQ CLI (`~/bin/hq-rs`). 39 commands.
