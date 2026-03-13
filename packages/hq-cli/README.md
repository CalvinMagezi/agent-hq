# agent-hq CLI

> Local-first AI agent hub — Claude, Gemini & Discord, all from one command.

## Quick Install

```bash
# Zero-install (auto-clones repo, installs Bun if needed)
npx @calvin.magezi/agent-hq

# Or with Bun (faster):
bunx @calvin.magezi/agent-hq
```

This will:
1. Install Bun if not present
2. Clone the agent-hq repo to `~/agent-hq`
3. Run `hq init` to set up everything

## From Source

```bash
git clone https://github.com/CalvinMagezi/agent-hq.git
cd agent-hq
bun install
bun scripts/hq.ts init
```

## First-Time Setup

After installation, run the guided walkthrough:

```bash
hq quickstart
```

Or set up step by step:

```bash
hq init                  # Full setup (vault, tools, services)
hq env                   # Configure API keys interactively
hq doctor                # Verify everything works
```

### API Keys

You need at least one of these to use AI chat:

| Key | Where to get it | Required? |
|-----|-----------------|-----------|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | Yes (or Gemini) |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Optional |
| `DISCORD_BOT_TOKEN` | [discord.com/developers](https://discord.com/developers/applications) | Optional |

Run `hq env` to set these interactively.

## Essential Commands

| Command | Description |
|---------|-------------|
| `hq` | Start chatting (default) |
| `hq quickstart` | Guided first-run walkthrough |
| `hq doctor` | Diagnose common issues |
| `hq env` | Set up API keys |
| `hq status` | Check what's running |
| `hq start all` | Start all services |
| `hq stop all` | Stop all services |
| `hq pwa` | Open the web dashboard |
| `hq vault open` | Open vault in Obsidian |
| `hq health` | Full health check |
| `hq logs [target]` | View logs |
| `hq help` | Essential commands |
| `hq help --all` | All commands |
| `hq help --agent` | Quick reference for AI agents |

## For AI Agents

The CLI is fully automatable:

```bash
OPENROUTER_API_KEY=sk-or-... \
  npx @calvin.magezi/agent-hq init --non-interactive
```

Run `hq help --agent` for the recommended command sequence.

## What's Included

- **Vault**: An Obsidian-compatible folder of markdown files — your AI's knowledge base
- **HQ Agent**: Background worker that processes AI jobs
- **Discord Relay**: Multi-bot system for chatting via Discord
- **Web Dashboard**: PWA on localhost:4747 for monitoring
- **Terminal Chat**: `hq` starts an interactive REPL
- **Daemon**: Background workflows (memory consolidation, web digests, etc.)

## License

MIT
