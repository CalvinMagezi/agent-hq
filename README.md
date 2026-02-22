# Agent-HQ

A local-first AI agent hub built on an Obsidian vault. Agent-HQ gives you a personal AI assistant with full access to your machine, controllable from the terminal or Discord.

All data lives in an Obsidian vault (`.vault/`) on the local filesystem — no cloud backend required.

## Architecture

```text
.
├── .vault/                # Obsidian vault (local data store)
│   ├── _system/           # Agent system files (SOUL.md, MEMORY.md, etc.)
│   ├── _jobs/             # Job queue (pending/, running/, done/, failed/)
│   ├── _delegation/       # Relay task queue (pending/, claimed/, completed/)
│   ├── _threads/          # Chat conversation history
│   ├── _logs/             # Date-partitioned job logs
│   └── Notebooks/         # User content (Memories, Projects, Daily Digest)
├── apps/
│   ├── agent/             # Local worker agent (Pi SDK, job execution)
│   └── discord-relay/     # Multi-bot Discord relay (Claude Code, OpenCode, Gemini CLI)
├── packages/
│   └── vault-client/      # Shared vault data access layer (@repo/vault-client)
├── scripts/
│   ├── agent-hq-chat.ts   # Terminal chat CLI
│   ├── agent-hq-daemon.ts # Background workflow daemon
│   └── workflows/         # Scheduled daily/weekly workflows
└── turbo.json             # Turborepo pipeline config
```

### How the pieces fit together

```
Discord DM ──> Discord Relay ──> CLI Harnesses (Claude Code, OpenCode, Gemini)
                    │                   │
                    ├── .vault/ ◄───────┘ (delegation, memory, context)
                    │     │
Terminal Chat ──────┘     ├── Job Queue (markdown files, atomic rename)
                          ├── Notes + Search (SQLite FTS5 + embeddings)
                          ├── Memory (SOUL, MEMORY, PREFERENCES)
                          └── Delegation Queue ──> HQ Agent ──> Shell/Filesystem
```

- **HQ Agent** — Polls vault for jobs, executes with Pi SDK (bash, files, web search), writes logs
- **Discord Relay** — Multi-bot system bridging Discord to CLI harnesses with session persistence
- **Terminal Chat** — Readline REPL with streaming responses and vault context injection
- **Local Daemon** — Background cron workflows (health checks, embeddings, note linking)
- **VaultClient** — Shared package for filesystem-based data access

## Prerequisites

- **[Bun](https://bun.sh)** v1.1.0+
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** (for Discord relay)
- **macOS** for launchd auto-start

## Setup

### 1. Clone and install

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install
```

### 2. Configure environment

#### HQ Agent (`apps/agent/.env.local`)

```bash
VAULT_PATH=                # Path to .vault/ directory (default: auto-resolved)
OPENROUTER_API_KEY=        # For LLM model access
DEFAULT_MODEL=             # LLM model ID (default: "moonshotai/kimi-k2.5")
```

#### Discord Relay (`apps/discord-relay/.env.local`)

```bash
DISCORD_BOT_TOKEN=         # Discord Developer Portal
DISCORD_USER_ID=           # Your Discord user ID
VAULT_PATH=                # Path to .vault/ directory
```

### 3. Start services

```bash
bun run agent        # Start HQ agent (job processing)
bun run relay        # Start Discord relay bots
bun run chat         # Terminal chat interface
bun run daemon       # Background workflow daemon
```

## Development Commands

```bash
bun run build        # Workspace-wide production build
bun run lint         # Lint all packages
bun run check        # Lint + build all packages
```

## Discord Relay Commands

DM your bot or @mention it in a server. Any non-command message is sent to the CLI harness.

| Command | Description |
|---------|-------------|
| `!reset` | New session + clear all settings |
| `!session` | Show current session info |
| `!model <name>` | Set model (opus, sonnet, haiku, or full ID) |
| `!opus` / `!sonnet` / `!haiku` | Quick model switch |
| `!memory` | View stored facts and goals |
| `!help` | Show all available commands |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun |
| Data | Obsidian vault (markdown + YAML frontmatter) |
| Search | SQLite FTS5 + embedding vectors |
| LLM | OpenRouter (configurable model) |
| Agent | Pi SDK |
| Discord | discord.js v14 |
| Build | Turborepo, Bun workspaces |
