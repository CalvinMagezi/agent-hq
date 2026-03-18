# Agentic Teams: Multi-Harness Orchestration Plan

> **Status**: RFC / Planning
> **Date**: 2026-03-18
> **Scope**: Extend Agent-HQ's team system to orchestrate heterogeneous AI coding agents across 9+ harness types with SMART traceability, A2A-compatible data model, and layered security.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture](#2-current-architecture)
3. [Harness Research & Integration Matrix](#3-harness-research--integration-matrix)
4. [A2A Protocol Analysis](#4-a2a-protocol-analysis)
5. [Architecture Design](#5-architecture-design)
6. [SMART Traceability System](#6-smart-traceability-system)
7. [Security Architecture](#7-security-architecture)
8. [Implementation Phases](#8-implementation-phases)
9. [Open Questions & Risks](#9-open-questions--risks)

---

## 1. Executive Summary

Agent-HQ already has a sophisticated team orchestration system: declarative `TeamManifest` YAML pipelines, multi-stage workflows (sequential/parallel/gated), quality gates, performance tracking, capability resolution with fallback chains, and a PWA control center. The core architecture is sound.

**What's missing** is the actual execution bridge. The `WorkflowEngine` creates delegated tasks in the vault but relies on relay adapters to claim and execute them. The `LocalHarness` currently supports 4 CLI tools (`claude-code`, `opencode`, `gemini-cli`, `codex-cli`). We need to:

1. **Expand harness support** to 9+ CLI agents (adding Copilot CLI, Cursor CLI, Qwen Code, Mistral Vibe, Ollama-backed agents, and optionally LogiCoal)
2. **Handle native orchestration** — several new harnesses have built-in multi-agent capabilities (fleet mode, subagents) that we should leverage rather than fight
3. **Adopt A2A data model** for interoperability without the HTTP overhead
4. **Build SMART traceability** so every team run is Specific, Measurable, Achievable, Relevant, and Time-bound — fully auditable
5. **Harden security** across trust boundaries when mixing cloud APIs, local models, and CLI tools with varying permission models

---

## 2. Current Architecture

### What We Have

```
TeamManifest (YAML/MD)          AgentDefinition (YAML/MD)
  ├─ stages[]                     ├─ preferredHarness
  │  ├─ pattern: seq/par/gated    ├─ fallbackChain[]
  │  ├─ agents[]                  ├─ baseRole
  │  └─ gates[]                   └─ performanceProfile
  │
  ▼
WorkflowEngine
  ├─ runStage() → seq or Promise.all()
  ├─ evaluateGate() → PASS/NEEDS_WORK/BLOCKED
  └─ submitAndWaitForTask() → vault delegation
       │
       ▼
  VaultClient.createDelegatedTasks()
       │
       ▼ (claimed by relay/daemon)
  LocalHarness.run()
       ├─ runClaude()   → spawn claude -p ... --output-format stream-json
       ├─ runOpenCode() → spawn opencode run -p ...
       ├─ runGemini()   → spawn gemini --yolo -p ...
       └─ runCodex()    → spawn codex exec --json ...
```

### Key Files

| Component | Path |
|-----------|------|
| Team types | `packages/hq-tools/src/types/teamManifest.ts` |
| Agent types | `packages/hq-tools/src/types/agentDefinition.ts` |
| Harness | `packages/relay-adapter-core/src/localHarness.ts` |
| Workflow engine | `packages/hq-tools/src/workflowEngine.ts` |
| Capability resolver | `packages/hq-tools/src/capabilityResolver.ts` |
| Performance tracker | `packages/hq-tools/src/performanceTracker.ts` |
| Team optimizer | `packages/hq-tools/src/teamOptimizer.ts` |
| PWA store | `apps/hq-control-center/src/store/hqStore.ts` |
| Model config | `apps/agent/lib/modelConfig.ts` |

### Existing Harness Types

```typescript
type LocalHarnessType = "claude-code" | "opencode" | "gemini-cli" | "codex-cli";
type HarnessType = "claude-code" | "opencode" | "gemini-cli" | "any";
```

---

## 3. Harness Research & Integration Matrix

### 3.1 Integration Readiness Matrix

| Harness | Headless Mode | Streaming Output | Session Resume | Free Tier | Native Orchestration | Integration Effort |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Claude Code** (existing) | `-p` flag | `stream-json` NDJSON | `--resume` / `--continue` | Yes (via Anthropic API) | Subagents | Already done |
| **OpenCode** (existing) | `run -p` | Text | No | Yes (open source) | No | Already done |
| **Gemini CLI** (existing) | `-p` flag | Text | No | Yes (Google AI Studio) | No | Already done |
| **Codex CLI** (existing) | `exec --json` | NDJSON | `resume <thread-id>` | Yes (OpenAI free tier) | No | Already done |
| **GitHub Copilot CLI** | `-p` flag | JSONL/JSON-RPC | Cross-session memory | 50 req/mo free | Fleet mode, cloud agents | Medium |
| **Cursor CLI** | `-p` flag | `stream-json` NDJSON | `--resume` | 50 req/mo (limited) | Background agents, 8x parallel | Hard (TTY requirement) |
| **Qwen Code** | `-p` / `--acp` | `stream-json` NDJSON | `--continue` | 2000 req/day free | SubAgents | Easy |
| **Mistral Vibe** | `--prompt` | `--output streaming` NDJSON | `--resume <id>` | Free (Devstral 2 promo) | SubAgents, skills | Easy |
| **Ollama** (via agents) | REST API | NDJSON streaming | N/A | Fully free (local) | None (inference only) | Medium |
| **LogiCoal** | Unknown | Unknown | Claims yes | Free with limits | 7 built-in agents | Blocked (no docs) |

### 3.2 Detailed Harness Profiles

#### GitHub Copilot CLI (`copilot`)
- **Install**: `npm install -g @github/copilot-cli` or `brew install github/copilot-cli/copilot`
- **Headless**: `copilot -p "task" --allow-all-tools --model claude-sonnet-4-6 -s`
- **Streaming**: JSONL events, JSON-RPC via SDK
- **Native orchestration**: Fleet mode (`/fleet`) breaks plans into parallel subagents. Can delegate to cloud coding agent via `&` prefix (runs in GitHub Actions, opens draft PRs)
- **Session**: Cross-session memory, automatic context compression
- **Free tier reality**: 50 premium requests/month is impractical for automation. Pro ($10/mo, 300 req) or Pro+ ($39/mo, 1500 req) needed for real use. Opus 4.6 costs 10x per request
- **Best for**: GitHub-integrated workflows, PR creation, code review with security scanning
- **Integration pattern**: Spawn as child process, parse JSONL output. Fleet mode is interesting but unclear if it can be driven programmatically — investigate JSON-RPC SDK

#### Cursor CLI (`cursor-agent`)
- **Install**: `curl https://cursor.com/install -fsSL | bash`
- **Headless**: `agent chat -p "task" --output-format stream-json`
- **Critical limitation**: **Requires real TTY**. Direct `spawn()` from Node/Bun **hangs indefinitely** and exits with SIGTERM (code 143). Community workaround: tmux wrapper
- **Streaming**: `--output-format stream-json --stream-partial-output` (NDJSON) — but TTY requirement makes this unreliable in subprocess mode
- **Session**: `agent ls`, `--resume`, `agent resume`
- **Free tier**: Hobby plan (50 premium req/mo) — limited agent access. Pro ($20/mo) required for full CLI agent
- **Native orchestration**: Up to 8 parallel agents via git worktrees, cloud background agents, GitHub Actions integration
- **Integration pattern**: **tmux wrapper** is the only reliable approach. Spawn `tmux new-session -d -s cursor-<id>`, send keys, capture pane output. This is fragile
- **Recommendation**: **Defer** to Phase 3. The TTY requirement makes it a poor harness candidate today. Monitor for SDK/headless improvements

#### Qwen Code (`qwen`)
- **Install**: `npm install -g @qwen-code/qwen-code` (Node.js 20+)
- **Headless**: `qwen -p "task" --output-format stream-json --yolo` or ACP mode (`qwen --acp`)
- **Streaming**: Full NDJSON with `--include-partial-messages` for content deltas
- **Session**: `--continue [session-id]`, project-scoped under `~/.qwen/projects/`
- **Free tier**: **Excellent** — 2,000 requests/day, 60/min, no token limit via Qwen OAuth. Also supports BYOK and local models
- **Native orchestration**: SubAgents (sequential today, parallel execution proposed). Agent Swarm and Agent Team features in development
- **ACP mode**: JSON-RPC 2.0 over stdio — **ideal for harness integration**. This is how IDEs integrate; bidirectional control with structured responses
- **Best for**: High-volume tasks, budget-conscious workflows, tasks where generous rate limits matter
- **Integration pattern**: Prefer `--acp` mode for full bidirectional control, or `-p` with `--output-format stream-json` for simple fire-and-forget. Very similar to Claude Code's pattern
- **Caveat**: Headless mode tends to produce shallower results than interactive mode

#### Mistral Vibe (`vibe`)
- **Install**: `pip install mistral-vibe` or download binary from releases
- **Headless**: `vibe --prompt "task" --output json --max-turns N --max-price X`
- **Streaming**: `--output streaming` (NDJSON per message)
- **Session**: `--resume SESSION_ID` or `--continue` (most recent)
- **Free tier**: CLI is Apache 2.0. API has free "Experiment" plan. Devstral 2 **currently free** (promotional). Post-promo: $0.40/$2.00 per M tokens
- **Native orchestration**: SubAgents for targeted tasks, custom agent modes, skills system (markdown templates)
- **Tool control**: `--enabled-tools TOOL` whitelists specific tools (glob/regex). `--max-price` sets cost ceiling
- **Best for**: Open-source friendly workflows, tasks requiring cost control, workflows where Apache 2.0 licensing matters
- **Integration pattern**: Very clean — `vibe --prompt "..." --output streaming --max-turns N`. Parse NDJSON. Resume sessions for multi-phase work. Close to Claude Code's UX

#### Ollama (local inference backend)
- **What it is**: Not a coding agent — an **inference server** for running local LLMs
- **Role in architecture**: Backend for other harness types, or paired with lightweight agent wrappers
- **Install**: `curl -fsSL https://ollama.ai/install.sh | sh`
- **Integration**: REST API at `localhost:11434`, OpenAI-compatible endpoints, native `ollama` npm package
- **Best models for coding**: Qwen2.5-Coder 32B, Devstral 24B, Qwen 3.5 35B-A3B, DeepCoder 14B
- **Free**: Completely. Local compute, no API costs
- **Security benefit**: Air-gapped execution for sensitive codebases — no data leaves the machine
- **Two integration patterns**:
  1. **Ollama as model backend for Claude Code**: Claude Code can connect to Ollama's Anthropic Messages API (since v0.14.0). Free agentic coding
  2. **Ollama as model backend for OpenCode/Qwen Code**: Point these tools at `localhost:11434` via OpenAI-compatible API
- **Limitation**: Local models are weaker at complex reasoning. Best for routine tasks, code formatting, test generation, documentation

#### LogiCoal
- **Status**: **Not recommended for integration at this time**
- **Reason**: No public GitHub repo, no documented headless mode, no SDK/API, no evidence of structured output. Website returns 403 errors. Very new with minimal public footprint
- **Interesting feature**: 7 built-in specialized agents (Orchestrator, Coder, Researcher, Planner, Reviewer, Tester, DevOps) with smart model routing
- **Action**: Monitor for public API documentation. Revisit if they publish a headless mode or SDK

### 3.3 Recommended Integration Priority

| Phase | Harnesses | Rationale |
|-------|-----------|-----------|
| **Phase 1** (immediate) | Qwen Code, Mistral Vibe | Clean headless APIs, generous free tiers, easy to add alongside existing harnesses |
| **Phase 2** (next) | GitHub Copilot CLI, Ollama tier | Copilot's Fleet mode + cloud agents add unique capabilities. Ollama adds air-gapped local execution |
| **Phase 3** (later) | Cursor CLI | Wait for TTY requirement fix or SDK. Use tmux wrapper only if essential |
| **Defer** | LogiCoal | Insufficient documentation for programmatic integration |

---

## 4. A2A Protocol Analysis

### 4.1 What A2A Provides

Google's Agent-to-Agent protocol (now Linux Foundation, v1.0) defines:
- **Agent Cards**: JSON metadata describing agent capabilities, skills, auth requirements, and I/O modalities. Published at `/.well-known/agent-card.json`
- **Tasks**: Lifecycle objects with states (SUBMITTED → WORKING → COMPLETED/FAILED/BLOCKED), history, artifacts, and session grouping
- **Messages & Parts**: Unified content structure for text, files (inline or URI), and structured data
- **Transport**: JSON-RPC 2.0 over HTTP POST, SSE streaming, push notification webhooks
- **Security**: OAuth2, OpenID Connect, API keys, mTLS, JWS-signed Agent Cards

### 4.2 A2A vs Our Architecture

| A2A Concept | Agent-HQ Equivalent | Gap |
|-------------|---------------------|-----|
| Agent Card | `AgentDefinition` frontmatter | Our agents lack skill-level input/output mode declarations |
| Task | `DelegatedTask` | Our tasks lack the full A2A lifecycle states and artifact model |
| Message/Part | Task instruction/result strings | We pass plain text; A2A supports multimodal parts |
| Agent discovery | `agentLoader.ts` + file scan | No runtime discovery protocol |
| Streaming | `onToken` callback | Informal; no structured event protocol |
| Session | `sessionId` on harness | We track sessions per-harness, not per-workflow |

### 4.3 Recommendation: Hybrid A2A Adoption

**Adopt A2A's data model. Skip A2A's transport for local agents.**

Rationale:
- Our agents are **local CLI child processes**, not networked services. HTTP JSON-RPC adds latency and complexity with zero benefit for local IPC
- Auth (OAuth2, mTLS) is unnecessary when all agents run under the same user
- Agent discovery is trivial — we scan markdown files on disk
- **BUT**: A2A's data model (Agent Cards, Task lifecycle, Part/Artifact structures) is well-designed and gives us ecosystem compatibility for free

**Concrete adoption plan**:

1. **Extend `AgentDefinition`** to include an A2A-compatible `skills[]` array with typed input/output modes
2. **Adopt A2A Task states** in our `DelegatedTask` type: SUBMITTED, WORKING, INPUT_REQUIRED, COMPLETED, CANCELED, FAILED, REJECTED, AUTH_REQUIRED
3. **Replace plain-text results** with a `Part[]` model supporting text, file references, and structured data (JSON)
4. **Add an `Artifact` concept** for rich outputs (diffs, test results, screenshots, generated files)
5. **Build an optional A2A HTTP gateway** later (Phase 4) if we want to expose agents externally or consume third-party A2A agents
6. **Use `@a2a-js/sdk` types** (Apache 2.0) for schema definitions without depending on the Express server

This gives us **interoperability potential** without paying the **local overhead tax**.

---

## 5. Architecture Design

### 5.1 Expanded Type System

```typescript
// Extended harness types
type HarnessType =
  | "claude-code"
  | "opencode"
  | "gemini-cli"
  | "codex-cli"
  | "copilot-cli"
  | "cursor-cli"
  | "qwen-code"
  | "mistral-vibe"
  | "ollama"       // Ollama-backed agent (via opencode/qwen/claude pointing at localhost)
  | "any";

// A2A-inspired skill declaration on AgentDefinition
interface AgentSkill {
  name: string;
  description: string;
  inputModes: ("text" | "file" | "json")[];
  outputModes: ("text" | "file" | "json" | "diff" | "test-report")[];
  tags: string[];
}

// A2A-inspired task lifecycle
type TaskState =
  | "submitted"
  | "working"
  | "input_required"  // agent needs clarification
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"        // agent cannot handle this task
  | "auth_required";  // harness needs credentials

// Rich output model
interface TaskPart {
  type: "text" | "file" | "json" | "diff" | "error";
  content?: string;       // for text, diff, error
  filePath?: string;      // for file references
  data?: unknown;         // for structured json
  mimeType?: string;
}

interface TaskArtifact {
  artifactId: string;
  name: string;
  parts: TaskPart[];
  createdAt: string;
}
```

### 5.2 Harness Abstraction Layer

The key insight: **new harnesses have native orchestration that we should delegate to, not replicate**.

```
┌──────────────────────────────────────────────────────┐
│              WorkflowEngine (unchanged)               │
│  Stages → Agents → Gates → Performance tracking       │
└─────────────────────┬────────────────────────────────┘
                      │ submitAndWaitForTask()
                      ▼
┌──────────────────────────────────────────────────────┐
│              HarnessOrchestrator (new)                 │
│                                                       │
│  1. CapabilityResolver → pick harness                 │
│  2. HarnessAdapter.spawn(instruction, config)         │
│  3. Stream events → TaskState updates                 │
│  4. Collect artifacts → TaskArtifact[]                │
│  5. Detect native orchestration → delegate if better  │
└────────┬──────┬──────┬──────┬──────┬──────┬──────────┘
         │      │      │      │      │      │
    ┌────▼──┐┌──▼───┐┌─▼──┐┌─▼───┐┌─▼───┐┌─▼────┐
    │Claude ││Qwen  ││Vibe││Copil││Gemi ││Ollama│
    │Code   ││Code  ││    ││ot   ││ni   ││      │
    │Adapter││Adapt.││Adpt││Adapt││Adapt││Adapt.│
    └───────┘└──────┘└────┘└─────┘└─────┘└──────┘

Each adapter implements:
  interface HarnessAdapter {
    type: HarnessType;
    spawn(instruction: string, config: SpawnConfig): HarnessSession;
    isAvailable(): Promise<boolean>;
    supportsNativeOrchestration(): NativeOrchestrationCapabilities;
  }

  interface HarnessSession {
    onEvent(cb: (event: HarnessEvent) => void): void;
    onArtifact(cb: (artifact: TaskArtifact) => void): void;
    waitForCompletion(): Promise<TaskResult>;
    kill(): void;
    sessionId?: string;  // for resume
  }
```

### 5.3 Native Orchestration Delegation

This is the **differentiating design choice**. Traditional orchestration tools (CrewAI, LangGraph) treat every agent as a dumb executor. But our harnesses are smart:

| Harness | Native Capability | Delegation Strategy |
|---------|-------------------|---------------------|
| Claude Code | Subagents, 100-turn auto-continue | Let Claude Code handle complex multi-file tasks as a single unit. Don't break them into micro-tasks |
| Copilot CLI | Fleet mode (parallel subagents) | For large features, send the whole plan to Fleet mode instead of manually parallelizing |
| Qwen Code | SubAgents (sequential), future swarm | Delegate research-heavy tasks — Qwen's generous rate limits make it ideal for breadth-first exploration |
| Mistral Vibe | SubAgents, skills system | Use Vibe's built-in skills for standardized workflows (deploy, lint, docs) |
| Cursor | 8x parallel via git worktrees | If integrated, delegate worktree-based parallel tasks to Cursor's native parallelism |

**Decision framework** for the `HarnessOrchestrator`:
```
IF task.complexity === "high" AND harness.supportsNativeOrchestration():
  → Send entire task to harness, let it orchestrate internally
  → Monitor via streaming events, enforce time/cost limits externally
ELSE:
  → Break task into sub-tasks per TeamManifest stages
  → Dispatch each sub-task to individual harness instances
```

This means our `TeamManifest` stages become **hints**, not rigid execution plans. An advanced harness might handle multiple stages internally.

### 5.4 Ollama Integration Architecture

Ollama is unique — it's not a coding agent but an inference backend. Two integration paths:

**Path A: Ollama as a model backend for existing harnesses**
```
Agent Definition:
  preferredHarness: qwen-code
  modelHint: ollama/qwen2.5-coder:32b

→ HarnessOrchestrator spawns:
  OLLAMA_HOST=localhost:11434 qwen -p "task" --provider ollama --model qwen2.5-coder:32b
```

**Path B: Ollama as a standalone harness via wrapper**
```
Agent Definition:
  preferredHarness: ollama
  modelHint: devstral:24b

→ OllamaAdapter:
  1. Ensure ollama serve is running
  2. Build agent loop: prompt → tool calls → execute → observe → repeat
  3. Use ollama npm package for chat completions
  4. Expose as HarnessSession with structured events
```

Path A is simpler and recommended. Path B only needed if we want fine-grained control over the agent loop for local models.

### 5.5 Configuration Model

```yaml
# .vault/_config/harnesses.yaml
harnesses:
  claude-code:
    enabled: true
    command: claude
    flags: ["--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"]
    maxTurns: 100
    model: opus
    sessionTtlMs: 14400000  # 4 hours
    timeoutMs: 3600000      # 1 hour
    securityProfile: standard

  qwen-code:
    enabled: true
    command: qwen
    flags: ["--output-format", "stream-json", "--include-partial-messages"]
    maxTurns: 50
    model: qwen3-coder
    authMode: oauth  # or api-key
    securityProfile: standard

  mistral-vibe:
    enabled: true
    command: vibe
    flags: ["--output", "streaming"]
    maxTurns: 30
    maxPrice: 0.50  # USD cost ceiling per task
    model: devstral-2
    securityProfile: standard

  copilot-cli:
    enabled: true
    command: copilot
    flags: ["--allow-all-tools", "-s"]
    model: claude-sonnet-4-6
    nativeOrchestration: fleet  # use fleet mode for parallel tasks
    securityProfile: guarded

  ollama:
    enabled: true
    host: "localhost:11434"
    defaultModel: qwen2.5-coder:32b
    backendFor: ["qwen-code", "opencode"]  # harnesses that can use ollama as backend
    securityProfile: admin  # full local trust

  cursor-cli:
    enabled: false  # disabled until TTY issue resolved
    command: agent
    ttyWrapper: tmux
    securityProfile: guarded
```

---

## 6. SMART Traceability System

Every team run must be **S**pecific, **M**easurable, **A**chievable, **R**elevant, and **T**ime-bound.

### 6.1 Trace Model

```typescript
interface SmartTrace {
  // S — Specific: What exactly was requested and what was delivered
  traceId: string;                    // UUID, propagated through all tasks
  teamName: string;
  instruction: string;                // Original user request
  goalDecomposition: GoalStep[];      // How the instruction was broken down

  // M — Measurable: Quantifiable outcomes
  metrics: {
    totalDurationMs: number;
    tokenUsage: Record<HarnessType, { input: number; output: number }>;
    costUsd: number;                  // Total API costs across all harnesses
    turnsPerAgent: Record<string, number>;
    gateResults: Record<string, GateOutcome>;
    filesModified: string[];
    testsRun: number;
    testsPassed: number;
    linesChanged: { added: number; removed: number };
  };

  // A — Achievable: Was each step within the agent's capability?
  capabilityLog: CapabilityEvent[];   // Harness selection, fallbacks, failures

  // R — Relevant: Does the output match the intent?
  relevanceScore?: number;            // Set by synthesis agent or quality gate (0-1)
  synthesisVerdict?: string;          // Human-readable summary of relevance

  // T — Time-bound: Timing data for every step
  timeline: TimelineEvent[];          // Ordered list of all events with timestamps
  startedAt: string;
  completedAt: string;
  deadlineMs?: number;                // Optional time budget
  deadlineMet: boolean;
}

interface GoalStep {
  stepId: string;
  description: string;
  assignedAgent: string;
  assignedHarness: HarnessType;
  resolvedHarness: HarnessType;  // May differ due to fallback
  status: TaskState;
  artifacts: TaskArtifact[];
}

interface CapabilityEvent {
  timestamp: string;
  agentName: string;
  preferredHarness: HarnessType;
  resolvedHarness: HarnessType;
  fallbackDepth: number;
  reason?: string;  // "preferred offline", "rate limited", "timeout"
}

interface TimelineEvent {
  timestamp: string;
  type: "stage_start" | "stage_end" | "agent_start" | "agent_end"
      | "gate_start" | "gate_end" | "fallback" | "retry"
      | "native_delegation" | "artifact_produced" | "error";
  stageId?: string;
  agentName?: string;
  harnessType?: HarnessType;
  details: string;
  durationMs?: number;
}
```

### 6.2 Trace Storage

```
.vault/_traces/
  ├─ {traceId}/
  │   ├─ trace.md           # YAML frontmatter + human-readable summary
  │   ├─ timeline.jsonl     # Append-only event log
  │   ├─ artifacts/         # Files produced by agents
  │   │   ├─ {artifactId}.md
  │   │   └─ {artifactId}.diff
  │   └─ agent-logs/        # Raw output per agent
  │       ├─ feature-coder.log
  │       └─ reality-checker.log
```

### 6.3 PWA Trace Visualization

The control center already has `TeamRunMonitor` with stage progress bars. Extend with:
- **Timeline view**: Gantt-style chart showing parallel agent execution, gate evaluations, and fallback events
- **Cost dashboard**: Per-harness and per-run cost tracking with budget alerts
- **Capability heatmap**: Which harnesses are being used most, fallback frequency, failure rates
- **Drill-down**: Click any stage → see agent logs, artifacts, token usage, and gate verdicts

---

## 7. Security Architecture

### 7.1 Threat Model

When mixing cloud APIs, local models, and CLI tools with varying trust levels:

| Threat | Risk | Mitigation |
|--------|------|------------|
| **Prompt injection via untrusted files** | HIGH — agent reads malicious README that hijacks behavior | Sandbox filesystem access per agent. Content scanning before ingestion |
| **Agent privilege escalation** | HIGH — coding agents run with user permissions | Per-harness security profiles. Restrict file/network/git access per task |
| **Credential leakage between harnesses** | MEDIUM — API keys for one service passed to another | Isolated env vars per harness spawn. Never pass credentials in task instructions |
| **Malicious code generation** | MEDIUM — LLMs generate code with vulnerabilities | Quality gates with security-focused evaluators. Static analysis as post-gate |
| **Multi-agent peer manipulation** | MEDIUM — one agent tricks another into destructive actions | Task isolation: agents communicate only through the orchestrator, never directly |
| **Ollama local model data exfiltration** | LOW (if no network) — but local models can be poisoned | Network isolation for Ollama. Model integrity verification via checksums |
| **Slopsquatting** | MEDIUM — agents install hallucinated packages | Package install allowlist. Lock file verification gate |
| **MCP/sandbox escape** | LOW-MEDIUM — symlink or path traversal attacks | No symlinks in work directories. Chroot or gVisor for untrusted agents |

### 7.2 Security Profiles (Extended)

```typescript
type SecurityProfile = "minimal" | "standard" | "guarded" | "admin" | "airgapped";

interface SecurityConstraints {
  profile: SecurityProfile;

  // Filesystem
  filesystemAccess: "full" | "read-only" | "restricted" | "none";
  allowedPaths?: string[];        // For restricted mode
  deniedPaths?: string[];         // Always blocked (e.g., ~/.ssh, ~/.aws)

  // Network
  networkAccess: "full" | "restricted" | "none";
  allowedHosts?: string[];        // For restricted mode

  // Git
  gitAccess: "full" | "read-only" | "none";
  allowPush: boolean;
  allowForce: boolean;

  // Process
  maxExecutionMs: number;
  maxCostUsd?: number;            // Cost ceiling (for paid APIs)
  maxTurns?: number;

  // Tool restrictions
  blockedTools?: string[];        // e.g., ["rm -rf", "curl | bash"]
  blockedCommands?: RegExp[];

  // Credential isolation
  inheritEnv: boolean;            // false = clean env, only pass whitelisted vars
  allowedEnvVars?: string[];      // Whitelist for the harness process
}
```

### 7.3 Harness-Specific Security Considerations

| Harness | Trust Level | Key Concerns | Recommended Profile |
|---------|-------------|--------------|---------------------|
| Claude Code | High | Anthropic API key exposure, `--dangerously-skip-permissions` | `standard` — already has governance via ToolGuardian |
| Qwen Code | Medium | `--yolo` auto-approves all tools. Qwen OAuth tokens. Data sent to Alibaba Cloud | `guarded` — restrict `--yolo` to sandboxed tasks only |
| Mistral Vibe | Medium | API key. `--enabled-tools` is the mitigation lever | `standard` — use `--enabled-tools` to whitelist |
| Copilot CLI | Medium-High | GitHub token grants repo access. `--allow-all-tools` is broad | `guarded` — never pass full GitHub PAT, use scoped tokens |
| Cursor CLI | Medium | `CURSOR_API_KEY`. TTY wrapper adds attack surface | `guarded` — tmux sessions need cleanup, don't persist credentials in pane |
| Ollama | High (local) | No data exfiltration risk. Model poisoning possible | `admin` or `airgapped` — full local trust, verify model checksums |
| OpenCode | High (open-source) | Transparent, auditable | `standard` |
| Gemini CLI | Medium | Google Cloud credentials. `--yolo` skips approval | `standard` — use scoped API keys |

### 7.4 Credential Management

```
.vault/_config/credentials/
  ├─ claude-code.env.enc     # Encrypted with vault master key
  ├─ qwen-code.env.enc
  ├─ mistral-vibe.env.enc
  ├─ copilot-cli.env.enc
  └─ ollama.env.enc          # May be empty (local, no creds needed)

Each harness adapter:
1. Decrypts its .env.enc at spawn time
2. Passes only its own credentials to the child process
3. Never exposes credentials in task instructions or logs
4. Credentials are memory-only, never written to disk unencrypted
```

### 7.5 Inter-Agent Isolation

Agents in a team workflow **never communicate directly**. All data flows through the orchestrator:

```
Agent A ──result──▶ Orchestrator ──instruction──▶ Agent B
                        │
                   ┌────▼────┐
                   │ Sanitize │  ← Strip any prompt injection attempts
                   │ Validate │  ← Check result format matches expected output
                   │ Truncate │  ← Limit context passed to next agent
                   └─────────┘
```

This prevents the "multi-agent peer manipulation" attack where Agent A embeds instructions in its output to hijack Agent B.

---

## 8. Implementation Phases

### Phase 1: Foundation (Weeks 1-3)

**Goal**: Expand harness types, add Qwen Code and Mistral Vibe, upgrade type system.

1. **Extend `HarnessType` union** in `agentDefinition.ts` with new types
2. **Create `HarnessAdapter` interface** in `packages/relay-adapter-core/src/`
3. **Refactor `LocalHarness`** into adapter pattern — extract Claude/OpenCode/Gemini/Codex into individual adapters
4. **Implement `QwenCodeAdapter`**:
   - Spawn `qwen -p "..." --output-format stream-json --include-partial-messages`
   - Parse NDJSON events, map to `HarnessEvent` stream
   - Session resume via `--continue <session-id>`
   - Auth: Qwen OAuth or API key from encrypted config
5. **Implement `MistralVibeAdapter`**:
   - Spawn `vibe --prompt "..." --output streaming --max-turns N --max-price X`
   - Parse NDJSON, map to events
   - Session resume via `--resume <id>`
   - Cost control via `--max-price`
6. **Update `CapabilityResolver`** for new harness types
7. **Update `harnesses.yaml` config** model
8. **Add new agent definitions** in `packages/hq-tools/agents/` that prefer the new harnesses

**Deliverables**:
- [ ] `HarnessAdapter` interface and base class
- [ ] Claude, OpenCode, Gemini, Codex adapters (refactored from LocalHarness)
- [ ] Qwen Code adapter
- [ ] Mistral Vibe adapter
- [ ] Updated type system
- [ ] Harness config model
- [ ] 2-3 new agent definitions using qwen-code and mistral-vibe

### Phase 2: SMART Traceability + A2A Data Model (Weeks 3-5)

**Goal**: Full trace system, A2A-compatible task model, PWA visualization.

1. **Implement `SmartTrace` type** and trace storage in `.vault/_traces/`
2. **Extend `DelegatedTask`** with A2A-inspired lifecycle states and `Part[]` results
3. **Add `TaskArtifact` model** for rich outputs
4. **Update `WorkflowEngine`** to emit `TimelineEvent`s and compute SMART metrics
5. **Build `TraceWriter`** — append-only JSONL timeline, markdown summary generation
6. **Update PWA**:
   - Timeline/Gantt view for trace visualization
   - Cost dashboard
   - Capability heatmap
   - Agent drill-down with logs and artifacts
7. **Install `@a2a-js/sdk`** types package for schema alignment (types only, not server)

**Deliverables**:
- [ ] SmartTrace type system
- [ ] TraceWriter with JSONL + markdown output
- [ ] WorkflowEngine timeline event emission
- [ ] Extended DelegatedTask with A2A states
- [ ] TaskArtifact model
- [ ] PWA trace visualization components
- [ ] Cost tracking per harness

### Phase 3: Copilot CLI + Ollama + Native Orchestration (Weeks 5-8)

**Goal**: Add Copilot CLI and Ollama harnesses. Implement native orchestration delegation.

1. **Implement `CopilotCliAdapter`**:
   - Spawn `copilot -p "..." --allow-all-tools -s`
   - Parse JSONL output
   - Investigate Fleet mode programmatic control via JSON-RPC SDK
   - Scoped GitHub token management
2. **Implement `OllamaAdapter`**:
   - Ensure `ollama serve` is running (spawn if needed)
   - Path A: Configure existing harnesses to use ollama as model backend
   - Path B: Lightweight agent loop using ollama npm package (for simple tasks)
   - Model health checking and auto-pull
3. **Build `NativeOrchestrationDetector`**:
   - Analyze task complexity + harness capabilities
   - Decision: delegate to harness's native orchestration or decompose manually
   - Wire into `HarnessOrchestrator`
4. **Implement `HarnessOrchestrator`** as the layer between `WorkflowEngine` and adapters
5. **Add harness health monitoring** — periodic liveness checks, rate limit tracking
6. **Cursor CLI investigation**: If TTY issue is resolved upstream, implement adapter. Otherwise, prototype tmux wrapper

**Deliverables**:
- [ ] Copilot CLI adapter
- [ ] Ollama adapter (both paths)
- [ ] NativeOrchestrationDetector
- [ ] HarnessOrchestrator
- [ ] Harness health monitoring
- [ ] Cursor CLI prototype (if feasible)

### Phase 4: Security Hardening + A2A Gateway (Weeks 8-10)

**Goal**: Production-grade security, credential management, optional A2A HTTP gateway.

1. **Implement encrypted credential store** in `.vault/_config/credentials/`
2. **Per-harness environment isolation** — clean env with only whitelisted vars
3. **Inter-agent result sanitization** — strip potential prompt injections between stages
4. **Implement `airgapped` security profile** for Ollama-only workflows
5. **Static analysis gate** — add a quality gate type that runs semgrep/eslint on generated code
6. **Build optional A2A HTTP gateway**:
   - Expose local agents as A2A servers (Agent Cards, Task endpoints)
   - Consume external A2A agents as additional harness backends
   - Auth layer (API key or mTLS for external access)
7. **Package install allowlist** — prevent slopsquatting
8. **Audit logging** — append-only security audit trail for all harness spawns and file modifications

**Deliverables**:
- [ ] Encrypted credential store
- [ ] Environment isolation per harness
- [ ] Result sanitization pipeline
- [ ] Static analysis quality gate
- [ ] A2A HTTP gateway (optional)
- [ ] Package allowlist system
- [ ] Audit logging

### Phase 5: Optimization + Team Templates (Weeks 10-12)

**Goal**: Leverage performance data to auto-optimize team compositions across all harnesses.

1. **Extend `TeamOptimizer`** to consider harness-specific performance:
   - Recommend harness switches when one outperforms another for a task type
   - Factor in cost (Ollama = free, Copilot = expensive per request)
   - Factor in rate limits (Qwen's 2000/day vs Copilot's 50-300/month)
2. **Build pre-built team templates** leveraging multi-harness diversity:
   - `research-deep-dive.md` — Qwen Code (breadth, high rate limit) → Claude Code (synthesis)
   - `security-audit.md` — Copilot (code scanning) + Claude Code (security review) + Mistral Vibe (documentation)
   - `local-only-sprint.md` — Ollama-backed agents only (air-gapped, zero cost)
   - `cost-optimized-feature.md` — Qwen Code (planning, free) → Mistral Vibe (implementation, cheap) → Claude Code (review, quality)
3. **Smart harness selection** — ML-free heuristic routing based on:
   - Task keywords → agent vertical → preferred harness
   - Historical performance data → harness scores per task type
   - Current availability → rate limit headroom, harness health
   - Cost budget → prefer cheaper harnesses when budget is tight
4. **Team composition builder** in PWA — drag-and-drop agents with harness preferences, auto-wire stages

**Deliverables**:
- [ ] Extended TeamOptimizer with harness awareness
- [ ] 4+ multi-harness team templates
- [ ] Smart harness selection heuristic
- [ ] PWA team composition builder

---

## 9. Open Questions & Risks

### Open Questions

1. **Copilot CLI Fleet mode programmatic API**: Can Fleet mode be triggered and monitored via JSON-RPC SDK, or is it interactive-only? This determines whether we can leverage Copilot's native parallelism
2. **Cursor TTY fix timeline**: Is Cursor working on a proper headless mode? The tmux wrapper is fragile for production use
3. **Qwen Code ACP stability**: Is the `--acp` JSON-RPC protocol stable enough for production, or should we stick with `--output-format stream-json`?
4. **Ollama model quality threshold**: At what task complexity should we stop using local models and escalate to cloud? Need benchmarking data
5. **A2A v1.0 stability**: The protocol had breaking changes from v0.3 to v1.0. Is it stable enough to build against, or should we pin to a specific version?
6. **LogiCoal evolution**: Will they publish a headless API? Worth monitoring

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Free tier rate limits exhausted | HIGH | Tasks stall | Fallback chains. Cost monitoring. Warn user before hitting limits |
| CLI tool breaking changes | MEDIUM | Adapters break | Pin CLI versions. Version detection at spawn time. Integration tests per adapter |
| Security incident (prompt injection) | MEDIUM | Data exfiltration, malicious code | Sanitization pipeline. Security profiles. Audit logging |
| Vendor lock-in to specific harness | LOW | Reduced flexibility | Adapter pattern isolates each harness. Fallback chains ensure no single point of failure |
| Performance overhead from heterogeneous harnesses | MEDIUM | Slow workflows | Benchmark each adapter. Cache harness selection decisions. Native orchestration delegation |
| A2A protocol changes | LOW-MEDIUM | Schema migration needed | Use types-only dependency. Pin SDK version. Adapter layer isolates protocol details |

---

## Appendix A: Harness Spawn Commands Quick Reference

```bash
# Claude Code (existing)
claude --dangerously-skip-permissions --output-format stream-json --verbose --max-turns 100 --model opus -p "task"

# OpenCode (existing)
opencode run -m anthropic/claude-sonnet-4-6 -p "task"

# Gemini CLI (existing)
gemini --yolo -p "task"

# Codex CLI (existing)
codex exec --json --dangerously-bypass-approvals-and-sandbox - <<< "task"

# Qwen Code (new)
qwen -p "task" --output-format stream-json --include-partial-messages --yolo
# Or ACP mode: qwen --acp  (bidirectional JSON-RPC over stdio)

# Mistral Vibe (new)
vibe --prompt "task" --output streaming --max-turns 30 --max-price 0.50

# GitHub Copilot CLI (new)
copilot -p "task" --allow-all-tools --model claude-sonnet-4-6 -s

# Cursor CLI (deferred — TTY issues)
# tmux new-session -d -s cursor-task && tmux send-keys -t cursor-task "agent chat -p 'task'" Enter

# Ollama (as backend for other harnesses)
OLLAMA_HOST=localhost:11434 qwen -p "task" --provider ollama --model qwen2.5-coder:32b
```

## Appendix B: A2A Data Model Alignment

```
A2A Concept          → Agent-HQ Equivalent
─────────────────────────────────────────────
AgentCard            → AgentDefinition + AgentSkill[]
AgentCard.skills[]   → AgentSkill[] (new)
Task                 → DelegatedTask (extended with A2A states)
Task.status.state    → TaskState enum (expanded)
Message              → TaskInstruction / TaskResult
Part                 → TaskPart (text, file, json, diff, error)
Artifact             → TaskArtifact (new)
Session              → SmartTrace.traceId (groups related tasks)
Agent discovery      → agentLoader.ts (local file scan, no HTTP)
Transport            → Direct function calls / IPC (not HTTP)
Auth                 → Not needed locally; optional for A2A gateway
```

## Appendix C: Cost Estimation Per Workflow Run

Assuming a typical `engineering-sprint` team (3 stages, 2-3 agents, ~45 min):

| Harness Mix | Estimated Cost | Rate Limit Impact |
|-------------|---------------|-------------------|
| All Claude Code (current) | $2-8 per run (Opus) | Anthropic API limits |
| Qwen Code planning + Claude Code impl | $0.50-3 per run | 1 of 2000 daily Qwen requests |
| Mistral Vibe impl + Claude Code review | $0.30-2 per run | Devstral 2 currently free |
| All Ollama (local) | $0 (electricity only) | None — local compute |
| Copilot Fleet + Claude review | $1-5 per run | 3-10 premium requests consumed |
| Optimal mix: Qwen plan → Vibe impl → Claude review | $0.20-1.50 per run | Minimal rate limit pressure |
