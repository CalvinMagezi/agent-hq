# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agent-HQ** is a Bun monorepo implementing a local-first AI agent hub. All data lives in an Obsidian vault (`.vault/`) on the local filesystem. The system features:
- **HQ-Agent**: Local worker (Pi SDK) that executes jobs from the vault's job queue
- **Discord Relay**: Multi-bot system (Claude Code, OpenCode, Gemini CLI) for Discord-based interaction
- **VaultClient**: Shared package for filesystem-based data access (replaces cloud backend)
- **Terminal Chat**: CLI chat interface (`bun run chat`)
- **Local Daemon**: Background cron workflows (`bun run daemon`)

Package manager: **Bun** (v1.1.0+)

## Monorepo Structure

```
.
├── .vault/                # Obsidian vault (local data store)
│   ├── _system/           # Agent system files (SOUL.md, MEMORY.md, etc.)
│   ├── _jobs/             # Job queue (pending/, running/, done/, failed/)
│   ├── _delegation/       # Relay task queue (pending/, claimed/, completed/)
│   ├── _threads/          # Chat conversation history
│   ├── _logs/             # Date-partitioned job logs
│   ├── _approvals/        # Human-in-the-loop approvals
│   ├── _usage/            # Token/cost tracking
│   ├── _embeddings/       # Local search index (gitignored)
│   ├── _moc/              # Maps of Content (Obsidian navigation)
│   └── Notebooks/         # User content (Memories, Projects, Daily Digest, etc.)
├── apps/
│   ├── agent/             # Local worker agent ("hq-agent", Pi SDK)
│   └── discord-relay/     # Multi-bot Discord relay
├── packages/
│   ├── vault-client/      # Shared vault data access layer (@repo/vault-client)
│   ├── vault-sync/        # File sync engine with event-driven change detection (@repo/vault-sync)
│   └── convex/            # Legacy Convex backend (archived, not used)
├── scripts/
│   ├── agent-hq-chat.ts   # Terminal chat CLI
│   ├── agent-hq-daemon.ts # Background workflow daemon
│   ├── install-launchd.sh  # macOS scheduler setup
│   └── workflows/         # Ported daily/weekly workflow scripts
└── turbo.json             # Turborepo pipeline config
```

## Development Commands

**All commands run from the monorepo root unless specified otherwise.**

```bash
# Core services
bun run agent        # Start HQ agent (job processing)
bun run relay        # Start Discord relay bots
bun run chat         # Terminal chat interface
bun run daemon       # Background workflow daemon

# Building & linting
bun run build        # Workspace-wide production build
bun run lint         # Lint all packages
bun run check        # Lint + build all packages

# Package-specific
bun --cwd apps/agent start              # Run agent directly
bun --cwd apps/discord-relay start      # Run relay directly
```

## Architecture

### 1. Vault (Data Store)
**Location**: `.vault/`

All data is stored as markdown files with YAML frontmatter in an Obsidian vault. The vault is the single source of truth — no cloud backend.

**Job Queue**: Files in `_jobs/pending/` → claimed via atomic `fs.renameSync` to `_jobs/running/` → completed to `_jobs/done/`

**Delegation**: HQ creates tasks in `_delegation/pending/` → relay bots poll and claim via rename to `_delegation/claimed/` → results in `_delegation/completed/`

**System Files**: `_system/SOUL.md` (identity), `_system/MEMORY.md` (persistent memory), `_system/PREFERENCES.md` (user prefs), `_system/HEARTBEAT.md` (actionable heartbeat)

### 2. VaultClient Package
**Location**: `packages/vault-client/`

Exported as `@repo/vault-client` workspace package. All apps import from this.

**Key Exports**:
- `VaultClient` — Core CRUD for jobs, notes, delegation, settings
- `SearchClient` (`@repo/vault-client/search`) — SQLite FTS5 + vector search
- `AgentAdapter` (`@repo/vault-client/agent-adapter`) — Compatibility wrapper for HQ agent

**Frontmatter Parsing**: Uses `gray-matter` for reading/writing YAML frontmatter in markdown files.

**Atomic Operations**: Job/task claiming uses `fs.renameSync` — if two workers race, only one rename succeeds (ENOENT for loser).

### 2b. VaultSync Package
**Location**: `packages/vault-sync/`

Exported as `@repo/vault-sync`. Event-driven file change detection engine that sits alongside/underneath the Obsidian vault layer.

**Key Exports**:
- `VaultSync` — Main orchestrator (watcher + scanner + change log + event bus)
- `SyncedVaultClient` — Drop-in replacement for `VaultClient` with sync-awareness and advisory locking
- `EventBus` — Typed pub/sub for vault change events
- `ChangeLog` — Append-only SQLite journal (guaranteed delivery, cursor-based consumption)
- `SyncState` — File version tracking with content hashing
- `LockManager` — Advisory file-level locks for write atomicity
- `ConflictResolver` — Deterministic conflict resolution (merge-frontmatter strategy)

**Architecture** (inspired by PasteMax + Syncthing):
- **FileWatcher**: `fs.watch({ recursive: true })` with per-path debounce (300ms) + stability checks (1000ms)
- **FullScanner**: Periodic safety-net scan (1hr) using mtime+size pre-filter then SHA-256 content hashing
- **EventBus**: Classifies raw fs events into domain events (`job:created`, `task:claimed`, `note:modified`, etc.)
- **ChangeLog**: Append-only SQLite journal; consumers resume from cursor positions after crash
- **SyncState**: Tracks file versions with device ID tagging for future P2P sync

**Database**: `.vault/_embeddings/sync.db` (separate from `search.db`; uses `bun:sqlite` with WAL mode)

**Integration**: Daemon, Agent, and Relay use event subscriptions with polling fallbacks:
- Daemon: `note:created` triggers immediate embedding, `system:modified` triggers heartbeat processing
- Agent: `job:created` event replaces 5s polling (30s fallback)
- Relay: `task:created` event replaces 5s delegation polling (30s fallback)

### 3. Local Worker Agent (HQ)
**Location**: `apps/agent/`

A polling worker that picks up jobs from the vault and executes them locally using the Pi SDK.

**Core Architecture**:
- Uses `AgentAdapter` from `@repo/vault-client/agent-adapter`
- Detects new jobs via `job:created` events (sync engine) with 30s polling fallback via `adapter.onUpdate()`
- Executes jobs with Pi SDK tools: `BashTool`, `FileTool`, `LocalContextTool`, `MCPBridgeTool`
- Writes logs to `_logs/YYYY-MM-DD/` via `adapter.addJobLog()`
- Updates job status: `pending` → `running` → `done`/`failed`

**Key Files**:
- `index.ts` — Main entry point, polling loop, tool registration
- `governance.ts` — Security profiles (`MINIMAL`, `STANDARD`, `ADMIN`) and `ToolGuardian` class
- `skills.ts` — Skill loading infrastructure
- `lib/delegationToolsVault.ts` — HQ orchestration tools (delegate, health, status, aggregate)

**Worker Identity**:
- Worker ID: `apps/agent/.agent-hq-worker-id`
- Local Memory: `apps/agent/agent-hq-context.md`
- Sessions: `apps/agent/.agent-hq-sessions/`

#### Agent Skills System

Skills are modular capabilities loaded at runtime from `apps/agent/skills/{name}/`:
```
skills/
├── pdf/           # PDF processing
├── docx/          # Word document processing
├── pptx/          # PowerPoint processing
├── xlsx/          # Excel processing
├── frontend-design/  # Frontend code generation
├── mcp-builder/   # MCP server builder
├── skill-creator/ # Meta-skill for creating new skills
└── find-skills/   # Discover available skills
```

Each skill has a `SKILL.md` with YAML frontmatter (name, description, license). The agent's `load_skill` tool dynamically loads skills by name.

#### Agent Job Types

Three job modes supported:
1. **`background`** — Fire and forget (default)
2. **`rpc`** — Return a value via `submit_result` tool
3. **`interactive`** — Multi-turn conversation with user via `chat_with_user` tool (status cycles through `running` ↔ `waiting_for_user`)

#### Agent Security

`governance.ts` implements a permission-gating system:
- `SecurityProfile` enum: `MINIMAL` (read-only), `STANDARD` (+ write), `ADMIN` (all tools)
- `ToolGuardian` class wraps tools with permission checks based on profile
- Default policies defined in `DEFAULT_POLICIES`

### 4. Discord Relay
**Location**: `apps/discord-relay/`

Multi-bot system supporting Claude Code, OpenCode, and Gemini CLI harnesses.

**Key Files**:
- `index.ts` — Entry point, multi-bot startup
- `src/bot.ts` — `BotInstance` class, message handling, delegation polling
- `src/vaultApi.ts` — `VaultAPI` class (filesystem-based, replaces old HTTP client)
- `src/context.ts` — Context enrichment (pinned notes, memory, search)
- `src/memory.ts` — Memory intent parsing ([REMEMBER:], [GOAL:], [DONE:])
- `src/commands.ts` — Discord `!` commands (!model, !reset, !memory, etc.)
- `src/harnesses/` — CLI harness implementations (claude, opencode, gemini)

**Delegation Flow**: Relay bots poll `_delegation/pending/` every 5s → claim matching tasks → execute via harness → report results

### 5. Terminal Chat CLI
**Location**: `scripts/agent-hq-chat.ts`

Readline-based REPL with streaming responses. Calls OpenRouter API directly, injects vault context (SOUL, MEMORY, PREFERENCES, pinned notes).

### 6. Local Daemon
**Location**: `scripts/agent-hq-daemon.ts`

Long-running Bun process replacing cloud-based crons:

| Interval | Task |
|----------|------|
| 1 min | Expire stale approvals |
| 2 min | Process heartbeat note |
| 5 min | Health check (stuck jobs, offline workers) |
| 5 min | Relay health check |
| 10 min | Process pending embeddings |
| 1 hr | Clean up stale jobs (>7 days) |
| 6 hr | Note linking (cosine similarity) |

### 7. Scheduled Workflows
**Location**: `scripts/workflows/`

Scripts run via macOS launchd (`scripts/install-launchd.sh`):
- `memory-consolidation.ts` — Daily 3 AM
- `web-digest.ts` — Daily 7 AM
- `preference-tracker.ts` — Sunday 8 AM
- `knowledge-analysis.ts` — Saturday 6 AM
- `project-tracker.ts` — Friday 9 AM
- `model-tracker.ts` — Monday 9 AM

## Vault Schema

Data is stored as markdown files with YAML frontmatter:

**Job file** (`_jobs/pending/job-{timestamp}-{hash}.md`):
```yaml
---
jobId: "job-1708646400-abc123"
type: background|rpc|interactive
status: pending
priority: 50
securityProfile: standard
createdAt: 2026-02-22T00:00:00Z
---
# Instruction
The actual task instruction here.
```

**Note file** (`Notebooks/{folder}/{title}.md`):
```yaml
---
noteType: note|digest|system-file|report
tags: []
pinned: false
source: manual|web-digest|memory-consolidation
embeddingStatus: pending|embedded|failed
createdAt: 2026-02-22T00:00:00Z
---
```

**Delegation task** (`_delegation/pending/task-{id}.md`):
```yaml
---
taskId: "research-1"
jobId: "job-abc123"
targetHarnessType: claude-code|opencode|gemini-cli|any
status: pending
priority: 50
createdAt: 2026-02-22T00:00:00Z
---
```

## Environment Variables

### Agent (`apps/agent/.env.local`)
```bash
VAULT_PATH=              # Path to .vault/ directory (default: auto-resolved)
OPENROUTER_API_KEY=      # For non-Gemini models via OpenRouter
GEMINI_API_KEY=          # For Gemini models via Google API directly (optional)
DEFAULT_MODEL=           # LLM model ID (default: "gemini-2.5-flash")
TARGET_DIR=              # Agent working directory (default: CWD)
```

**Provider routing**: Models starting with `gemini-` or `google/gemini-` use `GEMINI_API_KEY` directly when set, falling back to OpenRouter. All other models use `OPENROUTER_API_KEY`. Model config is centralized in `apps/agent/lib/modelConfig.ts`.

### Discord Relay (`apps/discord-relay/.env.local`)
```bash
DISCORD_BOT_TOKEN=       # Claude Code bot token
DISCORD_USER_ID=         # Your Discord user ID
VAULT_PATH=              # Path to .vault/ directory
DISCORD_BOT_TOKEN_OPENCODE=  # Optional: OpenCode bot token
DISCORD_BOT_TOKEN_GEMINI=    # Optional: Gemini CLI bot token
```

## Key Conventions

### Filenames
- Use camelCase for source files (e.g., `vaultApi.ts`, not `vault-api.ts`)

### VaultClient Usage Pattern
```typescript
import { VaultClient } from "@repo/vault-client";

const vault = new VaultClient("/path/to/.vault");

// Job queue
const job = await vault.getPendingJob("worker-1");
await vault.claimJob(job.jobId, "worker-1");  // atomic rename
await vault.updateJobStatus(job.jobId, "done");

// Notes
await vault.createNote("Projects", "My Note", "content", { tags: ["ai"] });
const results = await vault.searchNotes("query", 5);

// Delegation
await vault.createDelegatedTasks("job-123", [{ ... }]);
const tasks = await vault.getPendingTasks("claude-code");
```

### Agent Adapter Pattern
```typescript
import { AgentAdapter } from "@repo/vault-client/agent-adapter";

const adapter = new AgentAdapter("/path/to/.vault");

// Same API as old ConvexClient calls
const ctx = await adapter.getAgentContext();
await adapter.updateJobStatus(jobId, "running");
await adapter.addJobLog(jobId, "info", "Processing...");
```

## HQ Agent Flow

1. Job created as markdown file in `_jobs/pending/` (via chat CLI, Discord, or delegation)
2. Sync engine detects new file via `fs.watch` -> emits `job:created` event (or 30s polling fallback)
3. Agent picks up job via atomic rename to `_jobs/running/`
4. Agent executes with Pi SDK tools
5. Agent writes logs to `_logs/YYYY-MM-DD/`
6. For delegation: agent creates tasks in `_delegation/pending/`
7. Relay bots pick up delegated tasks via `task:created` events (or 30s polling fallback)
8. Agent updates job status to `done`/`failed` (moved to `_jobs/done/` or `_jobs/failed/`)

**Security**: Agent runs with local user permissions, gated by `ToolGuardian` security profiles.

## Important Notes

- The `packages/convex/` directory is archived legacy code — do not use or modify
- The `.vault/_embeddings/` directory is gitignored (contains `search.db` for FTS5/embeddings and `sync.db` for file change tracking)
- Job claiming uses atomic `fs.renameSync` — safe for concurrent workers
- Frontmatter is parsed with `gray-matter` — all data files use YAML frontmatter
- OpenRouter is the LLM provider for all AI operations
