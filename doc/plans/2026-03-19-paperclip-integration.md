---
title: "Paperclip Integration Plan"
status: planning
created: 2026-03-19
source: https://github.com/paperclipai/paperclip
tags: [planning, architecture, integration]
---

# Paperclip x Agent HQ: Integration Plan

## What Paperclip Is

[Paperclip](https://github.com/paperclipai/paperclip) (~29k GitHub stars) is an open-source orchestration platform for "zero-human companies." It manages **teams of AI agents** organized into company structures — org charts, budgets, governance, approval gates, and full audit trails. It uses Express + React (Vite) + PostgreSQL/PGlite + Drizzle ORM, with adapter patterns for Claude Code, Codex, Cursor, OpenCode, and others.

**Core innovation**: Treating AI agent management as a **company management problem** — org charts, budgets, governance, and accountability rather than pipelines and workflows.

## Where the Two Projects Align

| Concept | Agent HQ | Paperclip |
|---------|----------|-----------|
| Agent orchestration | Pi SDK + delegation tools | Express REST + adapter pattern |
| Multi-agent support | Relay bots (Claude, Gemini, OpenCode, Codex) | Adapters (Claude, Codex, Cursor, OpenCode, Pi) |
| Task distribution | FBMQ file-based queue + atomic `renameSync` | PostgreSQL + atomic checkout |
| Tracing | TraceDB (SQLite spans/events) | Full audit trail per conversation |
| Governance | SecurityProfiles + ToolGuardian | Approval gates + versioned config |
| Planning | PlanDB with phases + codemap | Goal ancestry chains |
| UI | PWA (TanStack Start, early stage) | React + Vite dashboard (mature) |
| Storage | Local vault (markdown + SQLite) | PostgreSQL/PGlite |

## Concepts Worth Incorporating

### 1. Goal Ancestry Chain (High Value, Low Complexity)

**What Paperclip does**: Every task traces back to the company mission through a goal ancestry chain. Agents see the "why," not just the task title.

**Why it matters for Agent HQ**: PlanDB already has plans with phases, but tasks created via `vault_create_job` or `delegate_to_relay` don't carry goal lineage. A job might say "refactor auth module" without connecting to "improve security posture" → "ship v2 with enterprise readiness."

**Integration approach**:
- Add `goalId` and `parentGoalId` fields to job frontmatter
- Create a `_system/GOALS.md` or SQLite `goals` table in planDB
- When creating jobs/tasks, require or infer goal linkage
- Surface goal context in delegation instructions so sub-agents understand purpose
- **Zero new dependencies** — just frontmatter fields + a PlanDB table

### 2. Per-Agent Budget Enforcement (High Value, Medium Complexity)

**What Paperclip does**: Monthly per-agent budgets. When an agent hits its limit, it stops. No runaway spend.

**What Agent HQ has**: `BudgetGuard` exists in vault-client but it's not deeply integrated into the delegation flow.

**Integration approach**:
- Enhance `BudgetGuard` with per-harness monthly limits (stored in `_system/BUDGET-CONFIG.md`)
- Track actual spend per delegation (model, tokens, estimated cost) in TraceDB spans
- Add budget check before `delegate_to_relay` — reject if over limit
- Daemon task: daily budget summary → push to Telegram
- **Zero new dependencies** — just extend existing BudgetGuard + TraceDB metadata

### 3. Structured Approval Gates (Medium Value, Low Complexity)

**What Paperclip does**: CEO agent cannot execute strategy without board review. Agents cannot hire other agents without approval. Config changes require approval.

**What Agent HQ has**: `governance.ts` has security profiles, but approval is binary (profile-based), not flow-based.

**Integration approach**:
- Add an `approvalRequired` flag to job/task frontmatter
- Create `_fbmq/approvals/pending/` queue (same atomic rename pattern)
- Daemon watches for pending approvals → pushes to Telegram/Discord with approve/reject buttons
- Agent blocks on `wait_for_approval(taskId)` before proceeding
- Approval history logged in TraceDB
- **Zero new dependencies** — reuses FBMQ pattern + existing notification infrastructure

### 4. Agent Org Chart with Roles (Medium Value, Medium Complexity)

**What Paperclip does**: Full hierarchies, roles, and reporting structures. Agents have defined relationships.

**What Agent HQ has**: `agentLoader.ts` loads agent definitions, `teamLoader.ts` loads team manifests. But there's no hierarchy or reporting structure — agents are flat peers.

**Integration approach**:
- Extend agent definition files (`.vault/agents/*.md`) with `reportsTo`, `role`, and `canDelegate` fields
- Add `_system/ORG-CHART.md` as a human-readable hierarchy view (auto-generated)
- Modify `delegate_to_relay` to respect org chart constraints (e.g., only managers can delegate to their reports)
- Team workflows already exist — org chart adds governance over who can start them
- **Zero new dependencies** — just frontmatter extensions + a new system note

### 5. Persistent Agent State Across Sessions (High Value, Medium Complexity)

**What Paperclip does**: Agents resume the same task context across heartbeats instead of restarting from scratch.

**What Agent HQ has**: Context engine assembles context per-request, but there's no "pick up where I left off" for a specific agent working on a multi-session task.

**Integration approach**:
- Create `_agent-sessions/{agentId}/state.json` — serialized checkpoint of current task progress
- When agent claims a job, check for existing state → inject as context
- On job pause/timeout, auto-save state (current phase, decisions made, files touched)
- Context engine gains a new "resumption layer" that loads prior state
- **Zero new dependencies** — just files + context engine extension

### 6. Adapter Pattern Formalization (Medium Value, Low Complexity)

**What Paperclip does**: Clean adapter interface — each agent type (Claude, Codex, Cursor) implements a standard contract. "If it can receive a heartbeat, it's hired."

**What Agent HQ has**: `relay-adapter-core` with `UnifiedAdapterBot` and harness routing, but adapters are tightly coupled to platform (Discord, Telegram) rather than to agent type.

**Integration approach**:
- Define a formal `AgentAdapter` interface in a shared package:
  ```typescript
  interface AgentAdapter {
    name: string;
    capabilities: string[];
    heartbeat(): Promise<HealthStatus>;
    execute(task: Task, context: AgentContext): AsyncGenerator<StreamChunk>;
    cancel(taskId: string): Promise<void>;
  }
  ```
- Refactor existing harness spawning logic to implement this interface
- Makes adding new agent types (e.g., Cursor, Windsurf) trivial
- **Zero new dependencies** — just a type interface + refactor

### 7. Multi-Workspace Isolation (Low Value for Now, High Complexity)

**What Paperclip does**: One deployment, many companies. Complete data isolation per company.

**How it maps to Agent HQ**: Could enable multiple vault roots — e.g., personal vault vs. work vault vs. client project vault, all managed by the same daemon.

**Recommendation**: Defer. Agent HQ's single-vault philosophy is a strength for simplicity. Revisit when users actually need multi-workspace.

## UI Concepts to Borrow

Paperclip's React dashboard is mature and mobile-accessible. Agent HQ's `hq-control-center` (TanStack Start PWA) could adopt:

### A. Agent Activity Dashboard
- **Live view** of which agents are active, what they're working on, time elapsed
- Map to: TraceDB active spans + relay health data (already available)
- Simple cards per agent with status indicator, current task, budget used

### B. Goal Tree Visualization
- **Hierarchical view** of goals → plans → tasks → subtasks
- Map to: PlanDB plans + job queue + goal ancestry (from concept 1 above)
- Tree/graph component showing goal lineage

### C. Budget & Spend Overview
- **Per-agent and per-model** spend tracking with monthly limits
- Map to: BudgetGuard data + TraceDB cost metadata
- Bar charts for monthly spend by harness

### D. Approval Queue UI
- **Pending approvals** with context, approve/reject buttons
- Map to: Approval gates (from concept 3 above)
- Simple list with action buttons

### E. Audit Log Browser
- **Searchable timeline** of all agent actions, decisions, tool calls
- Map to: TraceDB spans + events (already stored)
- Filterable table with trace drill-down

**Implementation note**: All of these can be built with the data Agent HQ **already collects** via TraceDB, vault jobs, and relay health. The gap is primarily in the UI layer, not the data layer.

## What NOT to Adopt

| Paperclip Concept | Why Skip It |
|---|---|
| PostgreSQL/PGlite | Agent HQ's vault + SQLite is simpler, more portable, and Obsidian-native. No reason to add a database server. |
| Express REST API | Agent HQ's relay server already handles this. Adding Express adds dependency bloat. |
| Drizzle ORM | Overkill for SQLite — `bun:sqlite` with `db.prepare().run()` is sufficient and faster. |
| pnpm | Bun workspaces are already working. |
| Company metaphor | Agent HQ's identity is a personal AI hub, not a "company." The org chart concept works without the business framing. |
| Marketplace (Clipmart) | Premature. Agent HQ's skill system and team manifests serve the same purpose locally. |
| Docker deployment | Against local-first philosophy. Keep `bun run agent` simplicity. |

## Recommended Implementation Order

| Phase | What | Effort | Value |
|-------|------|--------|-------|
| **Phase 1** | Goal ancestry chain (PlanDB + job frontmatter) | ~1 day | High — gives every task purpose |
| **Phase 2** | Per-agent budget enforcement (BudgetGuard enhancement) | ~1 day | High — prevents runaway spend |
| **Phase 3** | Approval gates (FBMQ pattern + notifications) | ~1 day | Medium — governance without friction |
| **Phase 4** | Persistent agent state (checkpoint/resume) | ~2 days | High — efficiency gain |
| **Phase 5** | Agent adapter interface formalization | ~1 day | Medium — extensibility |
| **Phase 6** | Org chart with roles | ~1 day | Medium — scales with agent count |
| **Phase 7** | Dashboard UI improvements (activity, budget, approvals) | ~3-5 days | High — visibility |

**Total: ~10-12 days of focused work, zero new dependencies.**

## Philosophy Alignment

The key insight is that Paperclip solves the **management layer** problem that Agent HQ's growing agent ecosystem will inevitably face. But where Paperclip reaches for PostgreSQL, REST APIs, and React SPAs, Agent HQ can implement the same concepts with:

- **Markdown frontmatter** instead of database rows
- **SQLite tables** in existing DBs instead of new schemas
- **FBMQ queues** instead of API endpoints
- **Telegram/Discord notifications** instead of dedicated dashboards (initially)
- **File-based state** instead of server-side sessions

This preserves Agent HQ's core strengths: **no cloud backend, no heavy dependencies, Obsidian-native, runs with `bun run agent`.**
