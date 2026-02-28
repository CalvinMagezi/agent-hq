# agent-hq CLI

> Local-first AI agent hub — Claude, Gemini & Discord, all from one command.

## Install

### via bunx / npx (zero-install)
```bash
bunx agent-hq
# or
npx agent-hq
```

### via Homebrew
```bash
brew tap calvinmagezi/agent-hq
brew install hq
```

### Manual (inside the repo)
```bash
hq install-cli   # symlinks scripts/hq.ts → ~/.local/bin/hq
```

## First-time setup

```bash
# Interactive (asks questions)
hq init

# Unattended — safe for agent/CI execution
hq init --non-interactive

# Custom vault location
hq init --vault /path/to/my/vault --non-interactive
```

## Commands

| Command | Description |
|---------|-------------|
| `hq` | Start interactive chat |
| `hq init` | Full first-time setup |
| `hq setup` | Scaffold vault only |
| `hq status` | Service status |
| `hq start [agent\|relay\|all]` | Start services |
| `hq stop [agent\|relay\|all]` | Stop services |
| `hq restart` | Restart everything |
| `hq daemon start\|stop\|logs` | Background daemon |
| `hq logs [target] [N]` | View logs |
| `hq follow` | Live-tail logs |
| `hq health` | Full health check |
| `hq ps` | All managed processes |
| `hq install` | Install launchd daemons |
| `hq coo status` | COO orchestrator status |

## Agent-installable

This CLI is designed to be fully installable by an AI agent:

```bash
# Prerequisites: bun, git
bunx agent-hq init --non-interactive \
  --vault ~/.agent-hq-vault
```

The init command will:
1. Check prerequisites (bun, git)
2. Install dependencies
3. Scaffold the vault
4. Create `.env.local` templates
5. Install macOS launchd daemons
6. Add `hq` to your PATH

## License

MIT © Calvin Magezi
