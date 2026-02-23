# Agent-HQ

> **📚 Full docs, architecture deep-dives, and future vision:**
> - **[Agent-HQ DeepWiki →](https://deepwiki.com/CalvinMagezi/agent-hq)** — Auto-generated deep wiki with full codebase exploration and architecture diagrams
> - **[Agent-HQ NotebookLM →](https://notebooklm.google.com/notebook/d57fefa2-82f9-4810-82d1-a652a47ffc5f)** — Ask questions, generate audio overviews, and visualize the system
> - **[Video Overview →](https://notebooklm.google.com/notebook/d57fefa2-82f9-4810-82d1-a652a47ffc5f?artifactId=a19ec78e-59a7-4078-aec4-def62656b22d)** — Watch the NotebookLM-generated video walkthrough of Agent-HQ

---

**Your personal AI assistant that lives on your machine.** Agent-HQ connects your favourite AI tools (Claude Code, Gemini CLI, OpenCode) to Discord, giving you a powerful AI assistant accessible from anywhere — while keeping all your data 100% local in an [Obsidian](https://obsidian.md) vault.

No cloud backend. No vendor lock-in. Your machine, your data, your agents.

```
You (Discord DM)
     │
     ▼
Discord Relay ──► Claude Code  ┐
                 Gemini CLI    ├──► .vault/ (local Obsidian vault)
                 OpenCode      ┘         │
                                         ├── Job Queue      (atomic markdown files)
                                         ├── Memory         (SOUL, MEMORY, PREFERENCES)
                                         ├── Notes + Search (SQLite FTS5 + embeddings)
                                         └── Delegation     ──► HQ Agent ──► Shell/Filesystem
```

## What You Get

- **Discord as your AI interface** — DM any of your bots, get responses from Claude, Gemini, or OpenCode
- **Persistent memory** — The agent remembers facts, goals, and context across sessions
- **Local job queue** — Queue background tasks, get results back in Discord
- **Multi-agent orchestration** — HQ delegates tasks to the right specialist bot
- **Scheduled workflows** — Daily web digests, memory consolidation, project tracking
- **Voice messages** — Send voice notes, get transcribed and processed responses
- **Full machine access** — Agent can run code, edit files, push git commits, search your vault

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
DEFAULT_MODEL=gemini-2.5-flash
```

### 4. Start services

```bash
bun run relay        # Start Discord relay bots
bun run agent        # Start HQ agent (optional, for job processing)
bun run chat         # Terminal chat interface (optional)
bun run daemon       # Background workflow daemon (optional)
```

## Setup for AI Agents

If you're an AI agent setting up Agent-HQ on behalf of a user, follow these steps:

1. **Check prerequisites**: Verify `bun --version` ≥ 1.1.0 and at least one CLI harness is installed
2. **Clone and install**: `git clone ... && bun install`
3. **Run setup**: `bun run setup` — creates `.vault/` with all required structure
4. **Check vault health**: `bun run status` — validates system files and directory layout
5. **Configure env files**: Copy `.env.example` templates, fill in tokens from the user
6. **Security note**: Never commit `.env.local` files. All credentials go in gitignored env files only.
7. **Start services**: `bun run relay` is the minimum — add `agent` and `daemon` for full capability
8. **Verify**: DM the Discord bot — if it responds, setup is complete

The vault schema, job types, delegation flow, and all system files are documented in the [NotebookLM workspace](https://notebooklm.google.com/notebook/d57fefa2-82f9-4810-82d1-a652a47ffc5f). For a full codebase deep dive, see the [DeepWiki](https://deepwiki.com/CalvinMagezi/agent-hq).

## Development Commands

```bash
bun run build        # Workspace-wide production build
bun run lint         # Lint all packages
bun run check        # Lint + build all packages
bun run setup        # Initialize/repair vault directory structure
bun run status       # Check system health
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

## Acknowledgements

Agent-HQ stands on the shoulders of some great projects and ideas:

- **[Pi SDK](https://github.com/mariozechner/pi)** by [@mariozechner](https://github.com/mariozechner) — The agent execution engine powering the HQ worker. Pi's tool system, session management, and coding agent are the backbone of everything the HQ agent does.

- **[claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay)** by [@godagoo](https://github.com/godagoo) — Inspired the architecture for a secure, ban-resistant relay that uses official CLI tools rather than unofficial API wrappers. The pattern of wrapping CLI harnesses instead of direct API access is what keeps this relay safe and sustainable.

- **[OpenClaw](https://github.com/opencode-ai/opencode)** — Inspired the multi-harness design and the idea that different AI tools have different strengths worth routing to explicitly.

- **[Obsidian](https://obsidian.md)** — The knowledge management app that doubles as our entire database. The vault format (markdown + YAML frontmatter + wikilinks) is the foundation of Agent-HQ's local-first architecture.

- **Anthropic's research on agent orchestration** — The [building effective agents](https://www.anthropic.com/engineering/building-c-compiler) post shaped how we think about multi-agent delegation, tool design, and keeping humans in the loop for dangerous operations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup guide, project principles, and PR process.

## License

MIT — see [LICENSE](LICENSE).
