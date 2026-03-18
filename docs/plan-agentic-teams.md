# Agentic Teams: Controlled Delegation Plan

> **Status**: RFC / Planning
> **Date**: 2026-03-18
> **Principle**: Simplicity. Don't over-engineer. Solve the real problems.

---

## The Problem

Today, delegation is **fire-and-forget into a FCFS queue**. The `delegate_to_relay` tool pushes tasks into FBMQ queues, and whichever relay happens to poll first claims it. There's no intelligence in routing — `targetHarnessType: "any"` means "whoever grabs it first wins."

This creates three concrete problems:

1. **Wrong agent gets the task.** A code review task might land on a relay that's better suited for research. There's no capability matching beyond the harness type string.
2. **No guided flow.** The `WorkflowEngine` has stages and gates, but once a task is delegated, it has no control over execution. There's no orchestrator managing the team — just a queue.
3. **Human bottleneck.** Every permission, every decision, every task approval requires the user. An orchestrator agent should handle routine approvals, only escalating dangerous operations to the human.

## What We're NOT Changing

- Existing harnesses (claude-code, opencode, gemini-cli, codex-cli) stay exactly as they are
- `LocalHarness` class stays — we're adding to it, not replacing it
- FBMQ queue infrastructure stays — it works fine for the transport layer
- `WorkflowEngine` stages/gates/retro system stays
- Relay adapter architecture stays
- Discord relay stays
- All existing tools, agents, and configs remain untouched

---

## 1. Add Qwen Code + Mistral Vibe (Easy Wins)

These two CLIs have clean headless APIs that map directly to the existing `LocalHarness.run()` pattern. No new abstractions needed.

### Qwen Code

```bash
# Install
npm install -g @qwen-code/qwen-code

# Headless (same pattern as claude -p)
qwen -p "task" --output-format stream-json --include-partial-messages --yolo

# Session resume
qwen -p "continue" --continue <session-id>
```

- 2,000 requests/day free (Qwen OAuth)
- NDJSON streaming identical to Claude Code's `stream-json` format
- `--yolo` auto-approves tools (like `--dangerously-skip-permissions`)

### Mistral Vibe

```bash
# Install
pip install mistral-vibe

# Headless
vibe --prompt "task" --output streaming --max-turns 30 --max-price 0.50

# Session resume
vibe --resume <session-id>
```

- Devstral 2 currently free, CLI is Apache 2.0
- `--max-price` gives us built-in cost control
- `--output streaming` gives NDJSON events

### Implementation

Add two methods to `LocalHarness` and extend the type union. Same pattern as `runOpenCode`/`runGemini`:

```typescript
// In localHarness.ts — extend the type
type LocalHarnessType = "claude-code" | "opencode" | "gemini-cli" | "codex-cli"
  | "qwen-code" | "mistral-vibe";

// In the run() switch statement, add:
case "qwen-code": result = await this.runQwen(prompt, onToken); break;
case "mistral-vibe": result = await this.runVibe(prompt, onToken); break;
```

`runQwen()` follows the `runClaude()` pattern (NDJSON streaming, session tracking).
`runVibe()` follows the `runOpenCode()` pattern (simpler exec, parse output).

Also update:
- `HarnessType` in `packages/vault-types/` to include `"qwen-code" | "mistral-vibe"`
- `DelegateToRelaySchema` to add the new harness options
- `DelegationQueue` will auto-create per-type queues (already does this dynamically)

**Files to touch:**
- `packages/relay-adapter-core/src/localHarness.ts` — add `runQwen()`, `runVibe()`
- `packages/vault-types/` — extend `HarnessType` union
- `apps/agent/lib/delegation/delegateToRelay.ts` — add to schema enum

---

## 2. SMART Orchestrator: The Core Change

Replace the "dump into queue and hope" pattern with an **orchestrator agent** that actively manages delegation.

### How Delegation Works Today

```
Agent calls delegate_to_relay(tasks)
  → tasks pushed to FBMQ queues (per harness type or "any")
  → relays independently poll their queue
  → first relay to pop() wins
  → no coordination, no routing intelligence
```

### How Delegation Should Work

```
Agent calls delegate_to_relay(tasks)
  → Orchestrator receives the task batch
  → For each task:
    1. Match task to best available agent (capability + load + history)
    2. Route to that agent's specific queue (never "any")
    3. Track assignment in SMART trace
  → Orchestrator monitors progress
  → If agent asks permission → Orchestrator decides (unless dangerous → escalate to human)
  → If agent finishes → Orchestrator validates and routes result to next stage
```

### The Orchestrator Is NOT a New Service

It's a **function layer** between `delegate_to_relay` and `vault.createDelegatedTasks()`. It runs in-process in the agent worker. No new daemon, no new server.

```typescript
// packages/hq-tools/src/teamOrchestrator.ts

interface TaskAssignment {
  taskId: string;
  assignedAgent: string;         // named agent from library
  assignedHarness: HarnessType;  // resolved, never "any"
  reason: string;                // why this agent was chosen
}

interface OrchestratorDecision {
  type: "approve" | "deny" | "escalate";
  reason: string;
}

class TeamOrchestrator {
  /**
   * Route a batch of tasks to the right agents.
   * Replaces the current "push to queue" pattern.
   */
  async assignTasks(tasks: DelegatedTask[], context: WorkflowContext): TaskAssignment[] {
    return tasks.map(task => {
      // 1. If task has an explicit agentName → use that agent's preferred harness
      // 2. If task has a role → match to best available agent for that role
      // 3. Look at relay health → pick a harness that's online and not overloaded
      // 4. Never return "any" — always resolve to a specific harness
      return this.matchTaskToAgent(task, context);
    });
  }

  /**
   * Handle permission requests from child agents.
   * Auto-approve routine operations. Escalate dangerous ones to human.
   */
  async handlePermissionRequest(request: PermissionRequest): OrchestratorDecision {
    if (this.isDangerous(request)) {
      return { type: "escalate", reason: "Dangerous operation requires human approval" };
    }
    // Auto-approve: file reads, file writes within project, git commits, test runs
    // Auto-deny: rm -rf, force push, credential access outside scope
    return this.evaluatePermission(request);
  }
}
```

### Task-to-Agent Matching (Simple Heuristic, No ML)

```typescript
matchTaskToAgent(task, context): TaskAssignment {
  // Priority 1: Explicit agent name in task
  if (task.agentName) {
    const agent = loadAgent(task.agentName);
    return { harness: agent.preferredHarness, agent: task.agentName, reason: "explicit" };
  }

  // Priority 2: Role-based matching
  const role = task.metadata?.role ?? detectRole(task.instruction);
  const candidates = getAgentsForRole(role);

  // Priority 3: Pick the best available candidate
  // - Is the harness online? (check relay health)
  // - Is the harness idle? (check running tasks)
  // - Has this harness performed well on similar tasks? (check performance history)
  const best = candidates
    .filter(c => isHarnessAvailable(c.preferredHarness))
    .sort((a, b) => scoreCandidate(b, task) - scoreCandidate(a, task))[0];

  return {
    taskId: task.taskId,
    assignedAgent: best.name,
    assignedHarness: best.preferredHarness,
    reason: `Role ${role}, harness available, score ${scoreCandidate(best, task)}`,
  };
}
```

### What "Dangerous" Means (Permission Escalation)

The orchestrator auto-approves most things. Only these escalate to the human:

| Operation | Auto-Decision |
|-----------|--------------|
| Read files in project | Approve |
| Write files in project | Approve |
| Run tests | Approve |
| Git commit | Approve |
| Git push to feature branch | Approve |
| Install a dependency | Approve (with allowlist check) |
| Git push to main/master | **Escalate** |
| Git force push | **Escalate** |
| Delete files outside project | **Escalate** |
| Run shell commands with pipes to external URLs | **Escalate** |
| Access credentials/secrets | **Escalate** |
| Modify CI/CD config | **Escalate** |
| Cost exceeds budget ceiling | **Escalate** |

This is implemented as a simple rule table, not an AI decision. Predictable, auditable, fast.

---

## 3. SMART Traceability

Every team run gets a trace. The trace captures what happened, how long it took, what it cost, and whether the output matched the intent.

### Trace Structure

Keep it simple — a single markdown file with YAML frontmatter plus an append-only JSONL event log.

```
.vault/_traces/
  └─ {runId}/
      ├─ trace.md         # Summary with YAML frontmatter
      └─ events.jsonl     # Append-only event log
```

### trace.md

```yaml
---
runId: "1710756000-abc123"
teamName: engineering-sprint
status: completed
startedAt: "2026-03-18T10:00:00Z"
completedAt: "2026-03-18T10:25:00Z"
durationMs: 1500000
# SMART dimensions
specific:
  instruction: "Add rate limiting to the /api/upload endpoint"
  stagesCompleted: 3
  totalStages: 3
measurable:
  filesModified: ["src/api/upload.ts", "src/middleware/rateLimit.ts"]
  linesAdded: 45
  linesRemoved: 3
  testsRun: 12
  testsPassed: 12
  costUsd: 0.85
achievable:
  assignments:
    - agent: feature-coder
      harness: qwen-code
      reason: "coder role, high rate limit budget"
      status: completed
    - agent: reality-checker
      harness: claude-code
      reason: "reviewer role, best quality"
      status: completed
relevant:
  gateResults:
    quality-gate: PASS
timeBound:
  deadlineMs: 1800000
  deadlineMet: true
---

# Workflow Trace: engineering-sprint — 1710756000-abc123

...human-readable summary...
```

### events.jsonl

One JSON object per line, appended as events happen:

```jsonl
{"ts":"2026-03-18T10:00:00Z","type":"run_start","runId":"...","instruction":"..."}
{"ts":"2026-03-18T10:00:01Z","type":"task_assigned","taskId":"code-1","agent":"feature-coder","harness":"qwen-code","reason":"coder role"}
{"ts":"2026-03-18T10:05:00Z","type":"task_started","taskId":"code-1","harness":"qwen-code"}
{"ts":"2026-03-18T10:15:00Z","type":"permission_request","taskId":"code-1","operation":"git commit","decision":"approve"}
{"ts":"2026-03-18T10:18:00Z","type":"task_completed","taskId":"code-1","durationMs":780000}
{"ts":"2026-03-18T10:18:01Z","type":"task_assigned","taskId":"review-1","agent":"reality-checker","harness":"claude-code"}
{"ts":"2026-03-18T10:25:00Z","type":"gate_evaluated","gateId":"quality-gate","outcome":"PASS"}
{"ts":"2026-03-18T10:25:00Z","type":"run_complete","status":"completed","durationMs":1500000,"costUsd":0.85}
```

### Implementation

```typescript
// packages/hq-tools/src/smartTrace.ts

class SmartTraceWriter {
  private runDir: string;
  private eventsFile: string;

  constructor(vaultPath: string, runId: string) {
    this.runDir = path.join(vaultPath, "_traces", runId);
    fs.mkdirSync(this.runDir, { recursive: true });
    this.eventsFile = path.join(this.runDir, "events.jsonl");
  }

  appendEvent(event: TraceEvent): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    fs.appendFileSync(this.eventsFile, line);
  }

  writeSummary(summary: SmartTraceSummary): void {
    // Write trace.md with YAML frontmatter
    const content = matter.stringify(summary.body, summary.frontmatter);
    fs.writeFileSync(path.join(this.runDir, "trace.md"), content);
  }
}
```

The `WorkflowEngine` gets a `SmartTraceWriter` injected and calls `appendEvent()` at each lifecycle point. The existing retro note logic moves into `writeSummary()`.

**Files to touch:**
- New: `packages/hq-tools/src/smartTrace.ts` — trace writer (small, ~100 lines)
- Edit: `packages/hq-tools/src/workflowEngine.ts` — inject trace writer, emit events
- Edit: existing retro note logic → redirect to trace summary

---

## 4. Inter-Agent Communication (fs.watch, Not Polling)

Today agents are isolated — they can't ask questions or share findings mid-task. The orchestrator should facilitate structured communication with **near-instant response times**.

### Why fs.watch, Not Polling

The codebase already has a proven `fs.watch` pattern in `packages/vault-sync/src/watcher.ts` — recursive mode with per-path debounce. Polling at 10s intervals is too slow: a Mistral Vibe task might finish in 30s total, meaning a 10s poll delay is a 33% overhead. An `fs.watch` on `_comms/{runId}/` reacts in milliseconds.

Different harnesses have very different response times:
- **Mistral Vibe**: Fast — typically 15-60s per task (Devstral 2 is quick, low turn counts)
- **Qwen Code**: Medium — 30s-5min depending on complexity
- **Claude Code**: Slow — 1-15min for complex tasks (deep reasoning, 100 turn limit)
- **OpenCode/Gemini**: Medium — 30s-3min

A polling interval that works for Claude (30s check) would be painfully slow for Vibe. `fs.watch` adapts naturally — it fires when the file appears, regardless of harness speed.

### Communication Watcher

```typescript
// packages/hq-tools/src/commsWatcher.ts

import { watch, type FSWatcher } from "fs";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

class CommsWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processedFiles = new Set<string>();  // prevent double-processing
  private debounceMs = 200;  // fast — comms should be responsive

  constructor(
    private commsDir: string,  // .vault/_comms/{runId}
    private onMessage: (msg: AgentMessage) => void,
  ) {}

  start(): () => void {
    fs.mkdirSync(this.commsDir, { recursive: true });

    this.watcher = watch(this.commsDir, { recursive: false }, (_event, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      if (filename.includes("-reply-")) return;  // ignore our own replies
      if (this.processedFiles.has(filename)) return;

      // Debounce: wait for write to finish (agents may write frontmatter + body in stages)
      const existing = this.debounceTimers.get(filename);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(filename, setTimeout(() => {
        this.debounceTimers.delete(filename);
        this.processFile(filename);
      }, this.debounceMs));
    });

    return () => this.stop();
  }

  private processFile(filename: string): void {
    try {
      const filePath = path.join(this.commsDir, filename);
      const raw = fs.readFileSync(filePath, "utf-8");
      const { data, content } = matter(raw);

      this.processedFiles.add(filename);
      this.onMessage({
        id: filename.replace(".md", ""),
        from: data.from,
        taskId: data.taskId,
        type: data.type,
        timestamp: data.timestamp,
        body: content.trim(),
      });
    } catch { /* file may be mid-write — debounce will retry */ }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }
}
```

The `CommsWatcher` is created per team run by the `HarnessPool` (see section 5) and lives for the duration of the run. It's not a daemon task — it's scoped to the active workflow.

### Communication Protocol

Agents communicate through the vault, mediated by the orchestrator. No direct agent-to-agent messaging.

```
Agent A (working on task)
  → writes message to .vault/_comms/{runId}/{taskId}-msg-{seq}.md
  → CommsWatcher fires (fs.watch, ~200ms debounce)
  → orchestrator decides: forward to another agent, answer itself, or escalate
  → writes reply to .vault/_comms/{runId}/{taskId}-reply-{seq}.md
  → agent's own fs.watch (or poll of reply dir) picks up the response

Message types:
  - question: "I found two approaches, which should I use?"
  - finding: "The existing auth middleware already handles rate limiting"
  - blocker: "I need access to the database schema"
  - status: "50% done, moving to tests"
```

### Orchestrator Responses

```typescript
async handleAgentMessage(msg: AgentMessage, context: WorkflowContext): MessageResponse {
  switch (msg.type) {
    case "question":
      // If another agent in the team has relevant context, forward
      // Otherwise, make a decision based on the workflow goals
      return this.answerOrForward(msg, context);

    case "finding":
      // Log to trace, forward to relevant downstream agents
      this.trace.appendEvent({ type: "agent_finding", ...msg });
      return { action: "acknowledged" };

    case "blocker":
      // Try to resolve. If can't, escalate to human.
      return this.resolveOrEscalate(msg, context);

    case "status":
      // Log to trace, update progress
      this.trace.appendEvent({ type: "agent_status", ...msg });
      return { action: "acknowledged" };
  }
}
```

### File Layout

```
.vault/_comms/
  └─ {runId}/
      ├─ code-1-msg-001.md    # Agent question
      ├─ code-1-reply-001.md  # Orchestrator response
      └─ review-1-msg-001.md  # Agent finding
```

Each message file has YAML frontmatter:

```yaml
---
from: feature-coder
taskId: code-1
type: question
timestamp: "2026-03-18T10:10:00Z"
---

I found two approaches to rate limiting:
1. Express middleware with express-rate-limit
2. Custom middleware using Redis

The project doesn't use Redis. Should I go with option 1?
```

Orchestrator reply:

```yaml
---
from: orchestrator
inReplyTo: code-1-msg-001
decision: approved
timestamp: "2026-03-18T10:10:02Z"
---

Use option 1 (express-rate-limit). The project doesn't have Redis infrastructure and we shouldn't add it for this task.
```

**Files to touch:**
- New: `packages/hq-tools/src/commsWatcher.ts` — fs.watch based message listener (~100 lines)
- New: `packages/hq-tools/src/agentComms.ts` — message read/write helpers (~60 lines)
- Edit: `packages/hq-tools/src/teamOrchestrator.ts` — add `handleAgentMessage()`

---

## 5. Harness Pool: Team-Scoped Process Lifecycle

When a team workflow kicks off, we need all the required harnesses ready to go. Today, harnesses are spawned on-demand per task — there's no concept of "the set of processes powering this team run." This makes it impossible to monitor the team as a unit or kill everything if something goes wrong.

### The Idea

When a `WorkflowEngine.run()` starts, read the team manifest to determine which harnesses are needed, then spin up a **HarnessPool** — a scoped group of `LocalHarness` instances, one per required harness type. The pool:

1. **Pre-validates** that each required CLI is installed and accessible
2. **Tracks all child PIDs** under a single run ID
3. **Provides a team-level kill switch** — one call tears down every spawned process
4. **Hosts the CommsWatcher** for this run
5. **Reports aggregate health** — which harnesses are idle/running/errored

The pool does NOT pre-spawn idle processes. Harnesses are still spawned on-demand when a task arrives (same as today). The pool is a **management wrapper** that groups them and provides lifecycle control.

### HarnessPool

```typescript
// packages/hq-tools/src/harnessPool.ts

import { LocalHarness, type LocalHarnessType } from "@repo/relay-adapter-core";
import { CommsWatcher } from "./commsWatcher.js";
import { SmartTraceWriter } from "./smartTrace.js";

interface PoolConfig {
  runId: string;
  teamName: string;
  requiredHarnesses: LocalHarnessType[];  // derived from team manifest
  vaultPath: string;
  onEscalate: (msg: string) => void;      // callback to notify human
}

interface HarnessStatus {
  type: LocalHarnessType;
  installed: boolean;
  running: boolean;
  currentTask?: string;
  pid?: number;
}

class HarnessPool {
  private harnesses = new Map<LocalHarnessType, LocalHarness>();
  private commsWatcher: CommsWatcher;
  private trace: SmartTraceWriter;
  private alive = true;

  constructor(private config: PoolConfig) {
    this.trace = new SmartTraceWriter(config.vaultPath, config.runId);
    this.commsWatcher = new CommsWatcher(
      path.join(config.vaultPath, "_comms", config.runId),
      (msg) => this.handleMessage(msg),
    );
  }

  /**
   * Initialize the pool: validate all required CLIs exist,
   * create LocalHarness instances, start the comms watcher.
   */
  async init(): Promise<{ ready: boolean; missing: LocalHarnessType[] }> {
    const missing: LocalHarnessType[] = [];

    for (const type of this.config.requiredHarnesses) {
      const installed = await this.checkInstalled(type);
      if (!installed) {
        missing.push(type);
        continue;
      }

      // Each harness gets its own state file scoped to this run
      const stateFile = path.join(
        this.config.vaultPath, "_traces", this.config.runId, `harness-${type}.json`
      );
      this.harnesses.set(type, new LocalHarness(stateFile));
    }

    if (missing.length > 0) {
      this.trace.appendEvent({
        type: "pool_init_warning",
        missing,
        message: `Harnesses not installed: ${missing.join(", ")}`,
      });
    }

    this.commsWatcher.start();
    this.trace.appendEvent({
      type: "pool_started",
      harnesses: this.config.requiredHarnesses,
      ready: missing.length === 0,
    });

    return { ready: missing.length === 0, missing };
  }

  /**
   * Run a task on a specific harness within the pool.
   * Returns the result. Throws if harness not in pool or pool is killed.
   */
  async runTask(
    harnessType: LocalHarnessType,
    prompt: string,
    onToken?: (token: string) => void,
  ): Promise<string> {
    if (!this.alive) throw new Error("Pool has been killed");

    const harness = this.harnesses.get(harnessType);
    if (!harness) throw new Error(`Harness ${harnessType} not in pool`);

    return harness.run(harnessType, prompt, onToken);
  }

  /**
   * Get status of all harnesses in the pool.
   */
  status(): HarnessStatus[] {
    return this.config.requiredHarnesses.map(type => {
      const harness = this.harnesses.get(type);
      return {
        type,
        installed: !!harness,
        running: harness?.isRunning(type) ?? false,
      };
    });
  }

  /**
   * Kill the entire pool — all running harness processes, comms watcher, everything.
   * This is the team-level kill switch.
   */
  kill(reason: string): void {
    this.alive = false;
    this.trace.appendEvent({ type: "pool_killed", reason });

    // Kill every harness's active processes
    for (const [type, harness] of this.harnesses) {
      if (harness.isRunning(type)) {
        harness.kill(type);
        this.trace.appendEvent({ type: "harness_killed", harnessType: type, reason });
      }
    }

    // Stop watching for comms
    this.commsWatcher.stop();

    // Dispose all harnesses (cleanup orphans, PID files)
    for (const harness of this.harnesses.values()) {
      harness.dispose();
    }
  }

  private async checkInstalled(type: LocalHarnessType): Promise<boolean> {
    const commands: Record<LocalHarnessType, string> = {
      "claude-code": "claude",
      "opencode": "opencode",
      "gemini-cli": "gemini",
      "codex-cli": "codex",
      "qwen-code": "qwen",
      "mistral-vibe": "vibe",
    };
    try {
      execSync(`which ${commands[type]}`, { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(msg: AgentMessage): void {
    // Delegate to orchestrator — covered in section 4
  }
}
```

### How the Pool Fits Into the Flow

```
User triggers team workflow
  │
  ▼
WorkflowEngine.run(team, instruction)
  │
  ├─ 1. Read team manifest → extract required harness types
  │     e.g. ["qwen-code", "claude-code"] from agent definitions
  │
  ├─ 2. Create HarnessPool({ requiredHarnesses, runId, ... })
  │     → pool.init() validates CLIs, starts CommsWatcher
  │     → if missing harnesses: warn user, use fallback chain
  │
  ├─ 3. For each stage:
  │     ├─ Orchestrator assigns tasks to specific harnesses
  │     ├─ pool.runTask(harnessType, prompt) — executes via LocalHarness
  │     ├─ CommsWatcher handles any mid-task messages
  │     └─ Results flow back, gates evaluate
  │
  ├─ 4. On completion: pool.kill("workflow complete") — clean shutdown
  │
  └─ 5. On danger/abort: pool.kill("user abort") — immediate teardown
```

### Team-Level Kill: When and How

The pool can be killed from three places:

**1. User abort** — user types `!kill-team` or equivalent in CLI/PWA:
```typescript
// The daemon or CLI calls:
activePool?.kill("user abort");
```

**2. Orchestrator escalation timeout** — if a dangerous operation is escalated to the human and they don't respond within a configurable window (default 5 min), kill the pool:
```typescript
// In orchestrator permission handling:
const response = await waitForHumanResponse(escalation, ESCALATION_TIMEOUT_MS);
if (!response) {
  pool.kill("escalation timeout — no human response");
}
```

**3. Budget/cost ceiling** — if cumulative cost across all harnesses exceeds the budget:
```typescript
// After each task completion, check cumulative cost:
if (trace.totalCostUsd > budgetCeiling) {
  pool.kill(`budget exceeded: $${trace.totalCostUsd} > $${budgetCeiling}`);
}
```

**4. Runaway detection** — if a single harness has been running for longer than its timeout without producing output, kill just that harness (not the whole pool) and fail its task:
```typescript
// LocalHarness already has TIMEOUT_MS (1 hour). The pool adds a softer
// "no output" timeout — if onToken hasn't fired in 10 minutes, something's wrong.
```

### Pool State File

The pool writes a lightweight state file so the PWA/CLI can display team status:

```
.vault/_traces/{runId}/pool-state.json
```

```json
{
  "runId": "1710756000-abc123",
  "teamName": "engineering-sprint",
  "alive": true,
  "startedAt": "2026-03-18T10:00:00Z",
  "harnesses": [
    { "type": "qwen-code", "installed": true, "running": true, "currentTask": "code-1", "pid": 12345 },
    { "type": "claude-code", "installed": true, "running": false }
  ]
}
```

Updated on every state change (task start/end, kill, etc.). This is what a monitoring UI or the daemon reads to show team progress.

### What the Pool Does NOT Do

- **Pre-spawn idle processes.** Harnesses start when a task arrives, not before. No wasted resources.
- **Replace LocalHarness.** The pool wraps `LocalHarness`, it doesn't reimplement it. Existing harness methods are untouched.
- **Manage queues.** The pool doesn't touch FBMQ. Tasks still flow through the existing queue infrastructure — the pool just ensures the right harness instance is ready to pick them up.
- **Persist across runs.** Each pool is created for one workflow run and destroyed when it ends. No long-lived harness pools.

**Files to touch:**
- New: `packages/hq-tools/src/harnessPool.ts` — pool lifecycle management (~200 lines)
- Edit: `packages/hq-tools/src/workflowEngine.ts` — create pool at run start, pass to stages
- Edit: `packages/hq-tools/src/teamOrchestrator.ts` — use pool for task execution

---

## 6. Implementation Phases

### Phase 1: Add Qwen + Mistral harnesses (1 week)

What to do:
- [ ] Add `runQwen()` and `runVibe()` to `LocalHarness`
- [ ] Extend `LocalHarnessType` and `HarnessType` unions
- [ ] Update `DelegateToRelaySchema` with new harness options
- [ ] Add harness config entries
- [ ] Test: delegate a task to each new harness, verify output
- [ ] Add 1-2 agent definitions that prefer qwen-code / mistral-vibe

What NOT to do:
- Don't refactor LocalHarness into an adapter pattern (unnecessary abstraction)
- Don't add A2A types
- Don't touch existing harness methods

### Phase 2: SMART trace + orchestrator routing + harness pool (2 weeks)

What to do:
- [ ] Create `SmartTraceWriter` — writes trace.md and events.jsonl
- [ ] Create `TeamOrchestrator.assignTasks()` — replaces "any" queue with explicit routing
- [ ] Create `HarnessPool` — team-scoped process lifecycle with kill switch
- [ ] Wire orchestrator into `delegate_to_relay` — tasks get assigned before queuing
- [ ] Wire pool into `WorkflowEngine.run()` — create at start, destroy at end
- [ ] Update `WorkflowEngine` to emit trace events at each lifecycle point
- [ ] Move retro note logic into trace summary
- [ ] Add permission rule table for auto-approve/escalate
- [ ] Add pool state file writing for monitoring
- [ ] Test: run a team workflow, verify pool creates/destroys cleanly, trace written

What NOT to do:
- Don't add PWA visualization yet
- Don't add cost tracking (do that when we have real multi-harness data)
- Don't build the comms system yet

### Phase 3: Inter-agent comms with fs.watch (1 week)

What to do:
- [ ] Create `CommsWatcher` — fs.watch on `_comms/{runId}/` with 200ms debounce
- [ ] Create `agentComms.ts` — message read/write helpers
- [ ] Wire `CommsWatcher` into `HarnessPool` — starts/stops with the pool
- [ ] Wire `TeamOrchestrator.handleAgentMessage()` to respond to agent messages
- [ ] Add reply writing — orchestrator writes reply files that agents can watch for
- [ ] Add message-aware instructions to agent prompts (tell agents they CAN ask questions)
- [ ] Test: run a team workflow where one agent asks a question mid-task

What NOT to do:
- Don't build a real-time WebSocket comms layer
- Don't add agent-to-agent direct messaging (always through orchestrator)
- Don't add comms to the daemon — the CommsWatcher lives in the pool, not the daemon

---

## Key Design Decisions

### Why not an adapter pattern for harnesses?

The current `LocalHarness` class with a switch statement is simple and works. Each harness method is ~30-50 lines. An adapter interface + factory + per-harness classes would triple the code for zero benefit. We have 6 harnesses, not 60. If we ever get to 10+, we can refactor then.

### Why not A2A protocol types?

A2A is designed for networked agent communication across organizations. Our agents are local child processes under one user. Using A2A's data model would mean importing a dependency, aligning to someone else's type system, and dealing with protocol version changes — all for an interop story we don't need today. Our trace format captures the same information in a simpler way.

### Why fs.watch instead of polling for comms?

Different harnesses have wildly different response times. Mistral Vibe can finish a task in 15-30s; Claude Code might take 15 minutes. A fixed polling interval is either too slow for fast harnesses or too frequent for slow ones. `fs.watch` reacts in milliseconds regardless of harness speed. The codebase already uses this exact pattern in `packages/vault-sync/src/watcher.ts` with debounce — we're reusing a proven approach.

### Why a harness pool instead of on-demand spawning?

On-demand spawning works for individual tasks, but team workflows need coordinated lifecycle management. Without a pool:
- There's no way to kill all processes when a workflow goes wrong
- There's no single place to check "what's running for this team?"
- The CommsWatcher has nowhere to live (it needs to outlive individual tasks)
- Cleanup on crash is per-harness, not per-workflow

The pool is a thin wrapper (~200 lines) around existing `LocalHarness` instances. It doesn't change how harnesses work — it just groups them and provides a kill switch.

### Why file-based comms instead of IPC?

The vault is our single source of truth. File-based comms means:
- Messages survive crashes (persistent)
- Any process can read them (daemon, PWA, CLI)
- They're human-readable (debugging)
- They integrate with existing vault sync
- No new transport infrastructure

### Why a rule table instead of an AI-based permission system?

Predictability. A rule table always gives the same answer for the same input. An AI-based system might approve `rm -rf node_modules` one time and deny it the next. The human should know exactly what the orchestrator will and won't auto-approve.

### Why "never any" routing?

The `"any"` harness target is the root cause of the random-agent problem. If every task is resolved to a specific harness before hitting the queue, we eliminate FCFS races entirely. The orchestrator always picks a specific agent and harness. The "any" queue still exists as a fallback but should never be used in team workflows.

---

## Open Questions

1. **Qwen `--acp` mode**: Is the JSON-RPC over stdio mode stable enough for production, or should we stick with `-p` + `--output-format stream-json`? Start with the simpler `-p` approach.
2. **Orchestrator as agent vs function**: Should the orchestrator be an LLM agent (can reason about complex routing) or pure code (faster, deterministic)? Start with pure code, add LLM reasoning later if heuristics aren't enough.
3. **fs.watch reliability on Linux**: `fs.watch` recursive mode works on macOS (FSEvents) and Linux (inotify). On Linux, recursive watch may hit inotify limits for deep directory trees. Since `_comms/{runId}/` is flat (no subdirectories), this shouldn't be an issue, but worth confirming `fs.inotify.max_user_watches` is sufficient.
4. **Multi-relay orchestration**: If multiple relays are online for the same harness type, how does the orchestrator pick one? Simplest: round-robin. Better: least-loaded.
5. **Pool vs existing relay spawning**: The pool manages `LocalHarness` instances directly. How does this interact with the existing relay adapter pattern where relays poll for tasks? The pool should be an alternative execution path for team workflows — solo delegations still use the relay/queue path.
6. **Agent reply watching**: How does the agent (child process) know a reply has been written? Options: (a) agent polls for reply file, (b) orchestrator writes reply inline into the agent's task instruction via session resume, (c) agent uses its own fs.watch. Option (b) is simplest — session resume naturally injects new context.
