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

## Install

### Zero-install (bunx / npx)
```bash
bunx @calvin.magezi/agent-hq          # runs the hq CLI — installs the repo on first run
```

### Homebrew (macOS)
```bash
brew tap calvinmagezi/agent-hq
brew install hq
```

### Inside the repo
```bash
hq install-cli         # symlinks scripts/hq.ts → ~/.local/bin/hq
```

## Prerequisites

- **[Bun](https://bun.sh)** v1.1.0+ — `curl -fsSL https://bun.sh/install | bash`
- **[Git](https://git-scm.com)** — for cloning
- **A Discord bot token** — [Create one here](https://discord.com/developers/applications)
- **At least one AI CLI** — `hq tools` installs and authenticates these for you:
  - **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** — Free with Google account
  - **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** — Requires Anthropic subscription
  - **[OpenCode](https://github.com/opencode-ai/opencode)** — Multi-model CLI

## Quick Start

The fastest path — interactive setup handles everything:

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install
hq init
```

`hq init` will:
1. Install Claude CLI, Gemini CLI, and OpenCode (with your confirmation)
2. Authenticate each tool
3. Install the Google Workspace extension for Gemini + configure the Obsidian MCP
4. Scaffold the `.vault/` directory
5. Create `.env.local` templates
6. Install macOS launchd daemons (auto-start on login)
7. Run a full health check

Then fill in your Discord bot token in `apps/discord-relay/.env.local` and run:

```bash
hq start relay
```

DM your bot on Discord — if it responds, you're done.

## Full Setup (Manual)

### 1. Clone and install

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install
```

### 2. Install CLI tools

```bash
hq tools          # interactive: installs + authenticates Claude/Gemini/OpenCode
```

Or install each manually:
```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @google/gemini-cli          # Gemini CLI
npm install -g opencode                    # OpenCode
```

### 3. Initialize the vault

```bash
hq setup
```

Creates the `.vault/` directory with all required subdirectories and system files. Safe to re-run.

### 4. Configure environment

#### Discord Relay (`apps/discord-relay/.env.local`)

```bash
DISCORD_USER_ID=your_discord_user_id

# Enable the bots you want (at least one):
DISCORD_BOT_TOKEN=your_claude_bot_token           # Claude Code
DISCORD_BOT_TOKEN_OPENCODE=your_opencode_token    # OpenCode
DISCORD_BOT_TOKEN_GEMINI=your_gemini_bot_token    # Gemini CLI
```

#### HQ Agent (`apps/agent/.env.local`) — optional

Only needed for background job processing:

```bash
OPENROUTER_API_KEY=your_key    # or GEMINI_API_KEY for Gemini models
DEFAULT_MODEL=gemini-2.5-flash
```

### 5. Start services

```bash
hq start           # start agent + relay via launchd (after hq install)
# — or —
hq fg relay        # run relay in foreground (no launchd needed)
hq fg agent        # run agent in foreground
hq daemon start    # start background workflow daemon
```

## Setup for AI Agents

If you're an AI agent setting up Agent-HQ, use the non-interactive flow:

```bash
# Prerequisites: bun ≥1.1.0, git
bunx @calvin.magezi/agent-hq init --non-interactive --vault ~/.agent-hq-vault
```

This single command:
1. Checks `bun` and `git` are present (exits with clear error if not)
2. Clones the repo if not already in one
3. Runs `bun install`
4. Auto-installs Claude CLI, Gemini CLI, OpenCode via npm
5. Scaffolds the vault at `~/.agent-hq-vault`
6. Creates `.env.local` templates (fill in API keys + Discord token after)
7. Installs launchd daemons on macOS
8. Adds `hq` to `~/.local/bin`

**After init**, fill in these values and start:
```bash
# apps/discord-relay/.env.local
DISCORD_BOT_TOKEN=...
DISCORD_USER_ID=...

# apps/agent/.env.local
GEMINI_API_KEY=...   # or OPENROUTER_API_KEY

hq start
```

**Security**: Never commit `.env.local` files. All secrets go in gitignored env files only.

The vault schema, job types, and delegation flow are documented in the [NotebookLM workspace](https://notebooklm.google.com/notebook/d57fefa2-82f9-4810-82d1-a652a47ffc5f). For a full architecture deep-dive, see the [DeepWiki](https://deepwiki.com/CalvinMagezi/agent-hq).

## The `hq` CLI

All management goes through the `hq` command:

```
hq                        Interactive chat (default)
hq init                   First-time setup
hq tools                  Install/re-auth CLI tools
hq setup                  Scaffold vault only
hq status                 Service status
hq start [agent|relay]    Start services
hq stop  [agent|relay]    Stop services
hq restart                Restart everything
hq daemon start|stop|logs Background daemon
hq logs [target] [N]      View logs
hq follow                 Live-tail logs
hq health                 Full health check
hq ps                     All managed processes
hq install                Install launchd daemons
hq install-cli            Add hq to PATH
hq coo status             COO orchestrator status
```

## Development Commands

```bash
bun run build        # Workspace-wide production build
bun run lint         # Lint all packages
bun run check        # Lint + build all packages
hq setup             # Initialize/repair vault directory structure
hq health            # Check system health
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
