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
- **At least one CLI harness** (pick the one(s) you use):
  - **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** — Free with Google account
  - **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — Requires Anthropic subscription
  - **[OpenCode](https://github.com/opencode-ai/opencode)** — Multi-model CLI
- **A Discord bot token** — [Create one here](https://discord.com/developers/applications)
- **macOS** for launchd auto-start (optional)

## Quick Start (Gemini-Only)

The simplest way to get started — only requires Gemini CLI and a Discord bot.

```bash
# 1. Clone and install
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install

# 2. Initialize the vault
bun run setup

# 3. Configure the Discord relay
cp apps/discord-relay/.env.local.example apps/discord-relay/.env.local
```

Edit `apps/discord-relay/.env.local` — you only need two values:

```bash
DISCORD_USER_ID=your_discord_user_id
DISCORD_BOT_TOKEN_GEMINI=your_gemini_bot_token
```

```bash
# 4. Start the relay
bun run relay
```

DM your Gemini bot on Discord and start chatting. That's it.

## Full Setup

### 1. Clone and install

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install
```

### 2. Initialize the vault

```bash
bun run setup
```

Creates the `.vault/` directory with all required subdirectories and default system files. Safe to re-run — existing files are never overwritten.

### 3. Configure environment

#### Discord Relay (`apps/discord-relay/.env.local`)

```bash
DISCORD_USER_ID=your_discord_user_id

# Enable the bots you want (at least one):
DISCORD_BOT_TOKEN=your_claude_bot_token           # Claude Code
DISCORD_BOT_TOKEN_OPENCODE=your_opencode_token    # OpenCode
DISCORD_BOT_TOKEN_GEMINI=your_gemini_bot_token    # Gemini CLI
```

See `apps/discord-relay/.env.local.example` for all available options.

#### HQ Agent (`apps/agent/.env.local`) — optional

Only needed if you want background job processing.

```bash
OPENROUTER_API_KEY=your_key
DEFAULT_MODEL=moonshotai/kimi-k2.5
```

### 4. Start services

```bash
bun run relay        # Start Discord relay bots
bun run agent        # Start HQ agent (optional, for job processing)
bun run chat         # Terminal chat interface (optional)
bun run daemon       # Background workflow daemon (optional)
```

## Development Commands

```bash
bun run build        # Workspace-wide production build
bun run lint         # Lint all packages
bun run check        # Lint + build all packages
bun run setup        # Initialize/repair vault directory structure
```

## Discord Relay Commands

DM your bot or @mention it in a server. Any non-command message is sent to the CLI harness.

| Command | Description |
|---------|-------------|
| `!reset` | New session + clear all settings |
| `!session` | Show current session info |
| `!model <name>` | Set model (e.g. `pro`, `flash`, `opus`, `sonnet`) |
| `!memory` | View stored facts and goals |
| `!help` | Show all available commands |

**Gemini-specific**: `!pro`, `!flash` for quick model switch.

**Claude-specific**: `!opus`, `!sonnet`, `!haiku`, `!effort low|medium|high`.

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
