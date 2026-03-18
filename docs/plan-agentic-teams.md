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

## 4. Inter-Agent Communication

Today agents are isolated — they can't ask questions or share findings mid-task. The orchestrator should facilitate structured communication.

### Communication Protocol

Agents communicate through the vault, mediated by the orchestrator. No direct agent-to-agent messaging.

```
Agent A (working on task)
  → writes message to .vault/_comms/{runId}/{taskId}-msg-{seq}.md
  → orchestrator sees new file (via fs.watch or poll)
  → orchestrator decides: forward to another agent, answer itself, or escalate

Message types:
  - question: "I found two approaches, which should I use?"
  - finding: "The existing auth middleware already handles rate limiting"
  - blocker: "I need access to the database schema"
  - status: "50% done, moving to tests"
```

### Orchestrator Responses

```typescript
// The orchestrator handles messages based on type:

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

### Implementation

This is a lightweight file-based protocol. No WebSocket, no new server. Just markdown files in the vault that the daemon polls.

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
- New: `packages/hq-tools/src/agentComms.ts` — message read/write helpers (~80 lines)
- Edit: `scripts/agent-hq-daemon.ts` — add comms poll task (check for new messages every 10s)
- Edit: `packages/hq-tools/src/teamOrchestrator.ts` — add `handleAgentMessage()`

---

## 5. Implementation Phases

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

### Phase 2: SMART trace + orchestrator routing (1-2 weeks)

What to do:
- [ ] Create `SmartTraceWriter` — writes trace.md and events.jsonl
- [ ] Create `TeamOrchestrator.assignTasks()` — replaces "any" queue with explicit routing
- [ ] Wire orchestrator into `delegate_to_relay` — tasks get assigned before queuing
- [ ] Update `WorkflowEngine.run()` to create trace and emit events
- [ ] Move retro note logic into trace summary
- [ ] Add permission rule table for auto-approve/escalate

What NOT to do:
- Don't add PWA visualization yet
- Don't add cost tracking (do that when we have real multi-harness data)
- Don't build the comms system yet

### Phase 3: Inter-agent communication (1 week)

What to do:
- [ ] Create `agentComms.ts` — file-based message protocol
- [ ] Add daemon poll task for new messages
- [ ] Wire `TeamOrchestrator.handleAgentMessage()` to respond to agent questions
- [ ] Add message-aware instructions to agent prompts (tell agents they CAN ask questions)
- [ ] Test: run a team workflow where one agent asks a question mid-task

What NOT to do:
- Don't build a real-time WebSocket comms layer
- Don't add agent-to-agent direct messaging (always through orchestrator)

---

## Key Design Decisions

### Why not an adapter pattern for harnesses?

The current `LocalHarness` class with a switch statement is simple and works. Each harness method is ~30-50 lines. An adapter interface + factory + per-harness classes would triple the code for zero benefit. We have 6 harnesses, not 60. If we ever get to 10+, we can refactor then.

### Why not A2A protocol types?

A2A is designed for networked agent communication across organizations. Our agents are local child processes under one user. Using A2A's data model would mean importing a dependency, aligning to someone else's type system, and dealing with protocol version changes — all for an interop story we don't need today. Our trace format captures the same information in a simpler way.

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
3. **Comms polling interval**: 10s for the daemon to check for new agent messages — is this fast enough? Could also use `fs.watch` for near-instant response.
4. **Multi-relay orchestration**: If multiple relays are online for the same harness type, how does the orchestrator pick one? Simplest: round-robin. Better: least-loaded.
