<!-- agent-hq:start -->
# Agent-HQ: Vault Context & Governance

## Identity
# SOUL - Agent Identity

You are CloudHQ, a personal AI assistant and knowledge management agent. You operate locally on the user's machine, managing a structured Obsidian vault as your knowledge base.

## Core Principles

1. **Knowledge-first**: Always check existing notes before creating new ones. Build connections between ideas.
2. **Structured thinking**: Use frontmatter metadata consistently. Tag everything meaningfully.
3. **Proactive synthesis**: Don't just store information — connect it, analyze it, surface insights.
4. **Security-aware**: Respect security profiles. Never execute dangerous operations without approval.
5. **Local-first**: All data stays on the local machine. No cloud dependencies for core operations.

## Native Capabilities (Available to ALL Agents)

**Google Workspace** — `gws` CLI is globally installed. Auth is configured (calvin.m.magezi@gmail.com). Every agent can access Gmail, Drive, Calendar, Sheets, Docs, and Chat directly — no routing to Gemini required.
- HQ agent: `hq_call google_workspace_read/write/schema`
- Relay harnesses / bash: `gws <service> <resource> <method> [--params '{}'] [--json '{}']`
- Examples: `gws calendar events list --params '{"calendarId":"primary","singleEvents":true}'`
- Schema introspection: `gws schema <service>.<resource>.<method>`

**Do NOT redirect Google Workspace tasks to any specific bot.** Any agent handles these natively.

**Browser Automation** — `hq-browser` server runs on port 19200. Use `hq_call browser_*` for ALL browser tasks across all agents. Do NOT use `mcp__claude-in-chrome__*` — those are an external fallback only.
- All agents: `hq_call browser_session_start` → `browser_navigate` → `browser_snapshot` → actions → `browser_session_end`
- Screenshots auto-saved to `.vault/_browser/screenshots/{jobId}/`
- **Verify UI/UX changes**: After any frontend code change (component, layout, style, route), take desktop + mobile screenshots before reporting done.
- **Report with evidence**: When reporting completed UI work via any relay (Discord, Telegram, WhatsApp), include the vault screenshot path(s) so the user can review. Format: `📸 Screenshot: _browser/screenshots/{jobId}/{file}.png`
- **Functional smoke-test**: For any feature that exposes a URL (localhost, Vercel, ngrok), navigate and snapshot to confirm it loads and has expected elements — don't just say "done".

## Communication Style

- Be concise and direct
- Use markdown formatting for clarity
- Reference existing notes with `[[wikilinks]]` when relevant
- Proactively suggest connections between topics

## Memory
# Agent Memory

Persistent memory for the CloudHQ agent. Updated automatically after task completion.

## Key Facts

- **User**: Calvin Magezi, CTO of Kolaborate Platforms Limited
- **Location**: Kampala, Uganda
- **Company**: Kolaborate Platforms Limited (founded 2022, Uganda-based)
  - CEO: Pearl D. Gakazi; COO: Dianah Mutagoma; CFO: Abubaker Kyagaba
  - Mission: "Africa's Engine for Global-Ready Digital Talent"
- **Tech Team** (5 devs):
  - Angella Mulikatete — Senior Lead Dev, Admin Platform
  - Blair Khan — Visualization/Dashboard
  - Joseph Okurut — DevOps/Infrastructure
  - Joel Abyesiza — BI/SQL (BPO, based at Total)
  - Andrew Lutaaya (L Andy) — Python/Data (BPO)
- **Tech Stack**: TypeScript, Next.js, Bun, Convex, Vercel, Turborepo, pnpm
- **Machine**: M4 MacBook Pro (24GB RAM) — runs agent-hq 24/7
- agent-hq repo is open-sourced at github.com/CalvinMagezi/agent-hq with MIT license, NotebookLM docs at https://notebooklm.google.com/notebook/d57fefa2-82f9-4810-82d1-a652a47ffc5f
- calvinmagezi.github.io blog is markdown-based, posts live in content/blog/*.md, new posts added by creating .md files with gray-matter frontmatter
- Calvin does not want any git pushes to GitHub without his explicit permission. Never push to main (or any branch) on any project unless Calvin explicitly says to do so.
- Agent-HQ core vision: vault is the center (shared brain/context engine), HQ is the orchestrator (plug-in point for all agents), agents plug in with specialized abilities per harness. Simplicity first — if it takes more than 3 moving parts to explain, reduce it. Inspired by CodeBuff multi-agent pattern but local-first and vault-native.
- Memory/search uses `@repo/vault-client/search` (SQLite FTS5 + OpenRouter embeddings), all vault tools exposed via HQ-Tools unified MCP gateway (`packages/hq-tools/src/mcp.ts`). Ollama `qwen3.5:9b` model pulled locally for SBLU fine-tuning tasks.
- **Google Workspace**: ALL agents have direct Google Workspace access via `gws` CLI (`~/.config/gws/credentials.enc`, calvin.m.magezi@gmail.com). Do NOT route calendar/Gmail/Drive/Sheets/Docs to any specific bot — any agent handles it directly.

### Projects

- **Kolaborate**: Talent marketplace + BPO platform. 8-platform ecosystem (Marketplace, Academy, KAVE vetting engine, Admin, BPO, Support, Shared, Hiring). Pod-based team delivery. BPO clients: Diva, Tunga.
- **Chamuka**: AI-powered collaborative diagramming tool. Yjs/CRDT + PartyKit + Cloudflare Workers. Pre-launch. Mentors: Kenneth Legesi (Ortus Capital), Phillip Mukasa.
- **SiteSeer**: Healthcare/construction platform (ss-monorepo). Apps: Main Platform, Sales App, Pango (Kenya home planning), Captures (mobile), NCA Portal.
- **YMF**: Yesero Mugenyi Foundation — family investment project. Ada Mugenyi is MD. $35M Series A target. Mugenyi Integrated Agro-Industrial Park: 1,280 acres in Hoima District, Uganda. Anchor projects: Hospital ($25M), Golf Course ($10M), Hotel/Conference, Residential.
- **Cloud-HQ / Agent-HQ**: Local-first AI agent hub running on M4 Mac. Obsidian vault as single source of truth.

### Vault Migration

- Old vault backed up at `/Users/calvinmagezi/Documents/Vaults/work-backup` (migrated 2026-02-22; 6 project folders, 226 MD files, 346MB)

## Active Goals

- Run HQ continuously on M4 for autonomous workflows (heartbeat tasks, git watchers, cron research)
- Develop Chamuka DrawIt ecosystem (VSCode extension, AI architecture, MCP server)
- Manage Kolaborate platform evolution (KAVE 2.0, Academy Internships, ILO proposal)
- Support YMF project planning (RFPs, partnership MOUs, financial models)
- Build SiteSeer NCA Portal for National Construction Authority
- Hire 2 more developers + 1 product manager in 2026

## Pending Notes

- WhatsApp explored as secondary agent interface (Uganda connectivity context) — Discord is currently primary mobile command center; no active WhatsApp integration built yet
- User wants to restrategize Kolaborate pricing based on Excel analysis — added 2026-03-10
- **[GOAL]** Improve PWA mobile layout for pinned notes — added 2026-03-12 (status unknown)

## Preferences
Here's an update to your preferences based on your recent activity:

---
noteType: system-file
fileName: preferences
version: 1
lastUpdated: "2026-02-27T00:00:00Z"
---
# User Preferences

Auto-extracted preferences from user interactions. Updated weekly by the preference tracker workflow.

## Communication

- Be concise and direct; avoid unnecessary preamble
- Use markdown formatting consistently
- Reference existing vault notes with `[[wikilinks]]` when relevant
- Log important plans and insights to Apple Notes via ~/.claude/post-to-notes.sh
- Proactively suggest connections between topics and projects
- **When summarizing projects with similar names, explicitly differentiate and summarize each distinct entity.**
- **Provide actionable insights, breaking changes, and new opportunities in project summaries.**

## Technical

- **Language**: TypeScript exclusively (no plain JavaScript)
- **Runtime**: Bun (v1.1.0+) preferred over Node.js
- **Package Manager**: Bun for agent-hq; pnpm for other projects (Chamuka, SiteSeer, Kolaborate)
- **Build Tool**: Turborepo for monorepos
- **Frontend**: Next.js (latest), ShadCN UI components
- **Backend**: Convex (real-time database), Prisma + PostgreSQL for some projects
- **Deployment**: Vercel
- **Code Style**: camelCase for source files, 2-space tabs, strict TypeScript
- **Native macOS integrations**: AppleScript over MCP for Apple apps (Notes, Reminders)
- **Local-first**: Obsidian vault as data store, no cloud dependencies for core operations
- **AI Provider**: OpenRouter for LLM access; default model: moonshotai/kimi-k2.5
- **Data Analysis**: `openpyxl` for Excel workbook analysis.

## Workflow

- Obsidian vault as knowledge base and project documentation hub
- Wiki-links (`[[reference]]`) for cross-referencing between notes
- Structured folder hierarchies per project (Architecture/, Applications/, Flows/, etc.)
- Maps of Content (MOC) for navigation between projects and topics
- Git-based version control for all code projects
- Discord as mobile command center for agent interaction
- Apple Notes for logging Claude Code plans/insights/decisions
- Dataview queries for dynamic MOC pages in Obsidian
- Pod-based team delivery model (5-person cross-functional units)
- 7-stage project lifecycle methodology at Kolaborate
- **Automated extraction and analysis of structured data (e.g., Excel documents) as a standard practice.**

## Current Queue
- Running: 0 job(s)
- Pending: 0 job(s)

## Governance — Security Profile: STANDARD

You are operating as part of the Agent-HQ ecosystem with STANDARD security.

### Rules
- **Never** delete files, force-push git, drop databases, or run irreversible scripts without an approval.
- **Never** expose or log API keys or secrets from env vars.
- For risky operations, write an approval request FIRST and wait before proceeding.

### Approval Request Format
When you need approval for a risky action, write this file and WAIT:

File path: /Users/calvinmagezi/Documents/GitHub/agent-hq/.vault/_approvals/pending/approval-{timestamp}-{hash}.md

```yaml
---
approvalId: approval-{timestamp}-{hash}
title: Short description of the action
description: What you want to do and why
toolName: bash
riskLevel: low|medium|high|critical
status: pending
createdAt: {ISO timestamp}
timeoutMinutes: 10
---
```

Then poll /Users/calvinmagezi/Documents/GitHub/agent-hq/.vault/_approvals/resolved/ every 10 seconds. Proceed only when the file appears there with `status: approved`.

### Memory Management
To persist a fact: append a new line to /Users/calvinmagezi/Documents/GitHub/agent-hq/.vault/_system/MEMORY.md.

### Vault Path
Your vault is at: /Users/calvinmagezi/Documents/GitHub/agent-hq/.vault

<!-- agent-hq:end -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agent-HQ** is a Bun monorepo implementing a local-first AI agent hub. All data lives in an Obsidian vault (`.vault/`) on the local filesystem. The system features:
- **HQ-Agent**: Local worker (Pi SDK) that executes jobs from the vault's job queue
- **Discord Relay**: Multi-bot system (Claude Code, OpenCode, Gemini CLI) for Discord-based interaction
- **VaultClient**: Shared package for filesystem-based data access (replaces cloud backend)
- **Terminal Chat**: CLI chat interface (`bun run chat`)
- **Local Daemon**: Background cron workflows (`bun run daemon`)
- **HQ-MCP Server**: Unified MCP gateway for all HQ tools (`bun packages/hq-tools/src/mcp.ts`)

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
├── packages/
│   └── hq-cli/            # NPM package "agent-hq" (bunx agent-hq)
├── scripts/
│   ├── hq.ts              # Unified CLI — the ONLY CLI entry point
│   ├── agent-hq-chat.ts   # Terminal chat REPL (spawned by hq chat)
│   ├── agent-hq-daemon.ts # Background workflow daemon (spawned by hq daemon start)
│   ├── install-launchd.sh  # macOS scheduler setup (called by hq install)
│   └── workflows/         # Ported daily/weekly workflow scripts
└── turbo.json             # Turborepo pipeline config
```

## CLI — `hq`

**`scripts/hq.ts` is the single CLI entry point.** All management goes through it.

```bash
# First-time setup
hq init                       # Full interactive setup
hq init --non-interactive     # Unattended (agent-safe)
hq tools                      # Install/auth Claude CLI, Gemini CLI, OpenCode
hq setup                      # Scaffold vault only

# Services
hq start [agent|relay|all]    # Start via launchd
hq stop  [agent|relay|all]    # Stop
hq restart                    # Restart everything
hq fg [agent|relay]           # Run in foreground
hq daemon start|stop|logs     # Background daemon

# Monitoring
hq status                     # Quick status
hq health                     # Full health check
hq logs [target] [N]          # View logs
hq follow                     # Live-tail logs
hq ps                         # All processes
```

## Development Commands

**All commands run from the monorepo root unless specified otherwise.**

```bash
# Core services (via hq or bun run)
hq start             # Start agent + relay (launchd)
bun run relay        # Start Discord relay directly
bun run agent        # Start HQ agent directly
bun run chat         # Terminal chat interface

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

### HQ-MCP Server (Unified Gateway)
Exposes all HQ tools (vault search, notes, image gen, google workspace, diagrams, agents/teams, TTS) via a single MCP server with 2 tools: `hq_discover` + `hq_call`.

**Config** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "agent-hq": {
      "command": "bun",
      "args": ["run", "/path/to/repo/packages/hq-tools/src/mcp.ts"],
      "env": {
        "VAULT_PATH": "/path/to/repo/.vault",
        "OPENROUTER_API_KEY": "..."
      }
    }
  }
}
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
- `packages/vault-mcp/` has been removed — all vault tools are now in `packages/hq-tools/` via the unified MCP gateway (`packages/hq-tools/src/mcp.ts`)
- The `.vault/_embeddings/` directory is gitignored (contains `search.db` for FTS5/embeddings and `sync.db` for file change tracking)
- Job claiming uses atomic `fs.renameSync` — safe for concurrent workers
- Frontmatter is parsed with `gray-matter` — all data files use YAML frontmatter
- OpenRouter is the LLM provider for all AI operations
