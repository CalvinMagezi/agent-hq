/**
 * TeamOrchestrator — SMART task routing for Agent-HQ delegation.
 *
 * Sits between delegate_to_relay and vault.createDelegatedTasks().
 * Replaces fire-and-forget FCFS routing with capability-aware assignment.
 *
 * NOT a new service — runs in-process in the agent worker.
 * NOT ML — simple heuristic scoring based on relay health + agent capabilities.
 */

import * as fs from "fs";
import * as path from "path";
import { getAllAgents, parseAgentFile, listAgentNames } from "./agentLoader.js";
import { resolveCapability, getCapabilityChain } from "./capabilityResolver.js";
import type { AgentDefinition, AgentRole, HarnessType } from "./types/agentDefinition.js";
// Inline relay health type (RelayHealthInfo removed from @repo/vault-types)
interface RelayHealthInfo {
  relayId: string;
  harnessType: string;
  displayName: string;
  status: "healthy" | "degraded" | "offline" | "unknown";
  lastHeartbeat: string | null;
  tasksCompleted: number;
  tasksFailed: number;
  avgResponseTimeMs: number;
  capabilities: string[];
  discordChannelId: string | null;
  _filePath: string;
}
import type { SmartTraceWriter } from "./smartTrace.js";
import type { AgentMessage } from "./commsWatcher.js";

// ─── Types ────────────────────────────────────────────────────────

export interface TaskAssignment {
  taskId: string;
  assignedAgent: string;
  assignedHarness: HarnessType;
  reason: string;
}

export type PermissionVerdict = "approve" | "deny" | "escalate";

export interface PermissionRequest {
  taskId: string;
  operation: string;
  detail: string;
}

export interface OrchestratorDecision {
  type: PermissionVerdict;
  reason: string;
}

export interface OrchestratorContext {
  relayHealthDir: string;
  runningTasks?: Map<string, string>;
  trace?: SmartTraceWriter;
  /** Callback to escalate to human (Telegram/Discord/CLI). */
  onEscalate?: (msg: string) => void;
}

export type MessageAction = "answered" | "forwarded" | "acknowledged" | "escalated";

export interface MessageResponse {
  action: MessageAction;
  reply?: string;
}

export interface WorkflowContext {
  instruction: string;
  teamName: string;
  runId: string;
  /** Results from completed tasks so far. */
  priorResults: Record<string, string>;
  /** Active task IDs and their assigned agents. */
  activeTasks: Map<string, string>;
}

// ─── Permission Rules ─────────────────────────────────────────────

const ESCALATE_PATTERNS = [
  /git\s+(push|force-push)\s+.*\b(main|master)\b/i,
  /git\s+(push\s+)?--force/i,
  /rm\s+-rf?\s+\//i,
  /\b(delete|remove)\b.*\b(outside|root|home)\b/i,
  /curl\s+.*\|\s*(sh|bash)/i,
  /\bsecret|credential|password|token|api.?key\b.*\b(access|read|export|send)\b/i,
  /\b(modify|edit|change)\b.*\b(ci|cd|pipeline|workflow)\b.*\b(config|yml|yaml)\b/i,
];

const DENY_PATTERNS = [
  /rm\s+-rf\s+\/\s*$/,
  /:\(\)\{\s*:\|:\s*&\s*\};:/,       // fork bomb
  /mkfs\b/,
  /dd\s+if=.*of=\/dev\//,
];

const AUTO_APPROVE_OPERATIONS = new Set([
  "file-read",
  "file-write-project",
  "test-run",
  "git-commit",
  "git-push-feature",
  "lint",
  "build",
  "search",
]);

// ─── TeamOrchestrator ─────────────────────────────────────────────

export class TeamOrchestrator {
  private ctx: OrchestratorContext;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
  }

  /**
   * Route a batch of tasks to the best available agents.
   * Every task gets a specific harness — never returns "any".
   */
  assignTasks(
    tasks: Array<{
      taskId: string;
      instruction: string;
      targetHarnessType: string;
      role?: AgentRole;
      agentName?: string;
    }>,
  ): TaskAssignment[] {
    const healthMap = this.loadRelayHealthInfo();
    const availableHarnesses = this.getAvailableHarnesses(healthMap);

    return tasks.map((task) => {
      const emit = (assignment: TaskAssignment) => {
        this.ctx.trace?.appendEvent({
          type: "task_assigned",
          taskId: assignment.taskId,
          agent: assignment.assignedAgent,
          harness: assignment.assignedHarness,
          reason: assignment.reason,
        });
        return assignment;
      };

      // Priority 1: Explicit agent name
      if (task.agentName) {
        const resolution = resolveCapability(task.agentName, availableHarnesses);
        if (resolution) {
          return emit({
            taskId: task.taskId,
            assignedAgent: task.agentName,
            assignedHarness: resolution.harness,
            reason: resolution.isFallback
              ? `explicit agent "${task.agentName}", fallback from ${resolution.preferredHarness} to ${resolution.harness}`
              : `explicit agent "${task.agentName}", preferred harness available`,
          });
        }
        // Agent specified but no harness available — fall through to role matching
      }

      // Priority 2: Explicit harness (not "any")
      if (task.targetHarnessType && task.targetHarnessType !== "any") {
        const harness = task.targetHarnessType as HarnessType;
        if (availableHarnesses.includes(harness)) {
          return emit({
            taskId: task.taskId,
            assignedAgent: task.agentName ?? "default",
            assignedHarness: harness,
            reason: `explicit harness "${harness}", online`,
          });
        }
        // Harness specified but offline — try to find an alternative
        const fallback = this.findBestAlternative(task.role, availableHarnesses, healthMap);
        if (fallback) {
          return emit({
            taskId: task.taskId,
            assignedAgent: task.agentName ?? "default",
            assignedHarness: fallback.harness,
            reason: `requested "${harness}" offline, fallback to "${fallback.harness}" (${fallback.reason})`,
          });
        }
      }

      // Priority 3: Role-based matching
      const role = task.role ?? "coder";
      const candidates = this.getAgentsForRole(role);

      // Score candidates by availability and performance
      const scored = candidates
        .map((agent) => {
          const chain = getCapabilityChain(agent.name);
          const harness = chain.find((h) => availableHarnesses.includes(h));
          if (!harness) return null;

          const health = healthMap.get(harness);
          const score = this.scoreCandidate(agent, harness, health);
          return { agent, harness: harness as HarnessType, score };
        })
        .filter(Boolean) as Array<{ agent: AgentDefinition; harness: HarnessType; score: number }>;

      scored.sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const best = scored[0];
        return emit({
          taskId: task.taskId,
          assignedAgent: best.agent.name,
          assignedHarness: best.harness,
          reason: `role "${role}", best candidate "${best.agent.name}" (score: ${best.score.toFixed(1)})`,
        });
      }

      // Priority 4: Fallback — pick any available harness
      if (availableHarnesses.length > 0) {
        const bestHarness = this.pickHealthiest(availableHarnesses, healthMap);
        return emit({
          taskId: task.taskId,
          assignedAgent: task.agentName ?? "default",
          assignedHarness: bestHarness,
          reason: `no role match, fallback to healthiest harness "${bestHarness}"`,
        });
      }

      // Nothing available — return original (will likely queue for later)
      return emit({
        taskId: task.taskId,
        assignedAgent: task.agentName ?? "default",
        assignedHarness: (task.targetHarnessType as HarnessType) || "hq",
        reason: "no relays available, queued for original target",
      });
    });
  }

  /**
   * Handle a permission request from a child agent.
   * Auto-approve routine ops. Escalate dangerous ones to human.
   */
  evaluatePermission(request: PermissionRequest): OrchestratorDecision {
    const combined = `${request.operation} ${request.detail}`;
    let decision: OrchestratorDecision;

    // Check deny patterns first (always block)
    for (const pattern of DENY_PATTERNS) {
      if (pattern.test(combined)) {
        decision = { type: "deny", reason: `Blocked: matches destructive pattern` };
        this.ctx.trace?.appendEvent({ type: "permission_request", taskId: request.taskId, operation: request.operation, decision: decision.type, reason: decision.reason });
        return decision;
      }
    }

    // Check escalation patterns (needs human)
    for (const pattern of ESCALATE_PATTERNS) {
      if (pattern.test(combined)) {
        decision = { type: "escalate", reason: `Dangerous operation requires human approval: ${request.operation}` };
        this.ctx.trace?.appendEvent({ type: "permission_request", taskId: request.taskId, operation: request.operation, decision: decision.type, reason: decision.reason });
        return decision;
      }
    }

    // Check auto-approve list
    if (AUTO_APPROVE_OPERATIONS.has(request.operation)) {
      decision = { type: "approve", reason: `Auto-approved: ${request.operation}` };
    } else {
      // Default: approve non-dangerous operations
      decision = { type: "approve", reason: "No dangerous patterns detected" };
    }

    this.ctx.trace?.appendEvent({ type: "permission_request", taskId: request.taskId, operation: request.operation, decision: decision.type, reason: decision.reason });
    return decision;
  }

  /**
   * Check if a budget threshold would be exceeded.
   * Returns "escalate" if cost exceeds ceiling.
   */
  checkBudget(estimatedCostUsd: number, ceilingUsd: number): OrchestratorDecision {
    if (estimatedCostUsd > ceilingUsd) {
      return {
        type: "escalate",
        reason: `Estimated cost $${estimatedCostUsd.toFixed(2)} exceeds budget ceiling $${ceilingUsd.toFixed(2)}`,
      };
    }
    return { type: "approve", reason: `Within budget ($${estimatedCostUsd.toFixed(2)} / $${ceilingUsd.toFixed(2)})` };
  }

  /**
   * Handle an incoming message from a child agent during a workflow run.
   * Routes by message type: answer questions, log findings, resolve blockers, track status.
   */
  handleAgentMessage(msg: AgentMessage, context: WorkflowContext): MessageResponse {
    switch (msg.type) {
      case "question":
        return this.answerOrEscalate(msg, context);

      case "finding":
        // Log to trace, acknowledge
        this.ctx.trace?.appendEvent({
          type: "permission_request", // reuse existing event type for agent comms
          taskId: msg.taskId,
          operation: "agent_finding",
          decision: "acknowledge",
          reason: msg.body.substring(0, 200),
        });
        return { action: "acknowledged" };

      case "blocker":
        return this.resolveOrEscalate(msg, context);

      case "status":
        this.ctx.trace?.appendEvent({
          type: "permission_request",
          taskId: msg.taskId,
          operation: "agent_status",
          decision: "acknowledge",
          reason: msg.body.substring(0, 200),
        });
        return { action: "acknowledged" };

      default:
        return { action: "acknowledged" };
    }
  }

  /**
   * Try to answer an agent's question from workflow context.
   * If we can't determine the answer, escalate to human.
   */
  private answerOrEscalate(msg: AgentMessage, context: WorkflowContext): MessageResponse {
    // Check if another agent in the team already produced relevant context
    const relevantFindings = this.findRelevantContext(msg.body, context.priorResults);

    if (relevantFindings) {
      this.ctx.trace?.appendEvent({
        type: "permission_request",
        taskId: msg.taskId,
        operation: "agent_question",
        decision: "approve",
        reason: `Answered from prior results`,
      });
      return {
        action: "answered",
        reply: `Based on prior findings from this workflow:\n\n${relevantFindings}`,
      };
    }

    // Can't answer — escalate
    this.ctx.onEscalate?.(`Agent question (${msg.taskId}): ${msg.body.substring(0, 300)}`);
    this.ctx.trace?.appendEvent({
      type: "permission_request",
      taskId: msg.taskId,
      operation: "agent_question",
      decision: "escalate",
      reason: "No relevant context found, escalating to human",
    });
    return { action: "escalated" };
  }

  /**
   * Try to resolve a blocker. If it's a permission issue, evaluate it.
   * Otherwise escalate to human.
   */
  private resolveOrEscalate(msg: AgentMessage, context: WorkflowContext): MessageResponse {
    // Check if it's a permission-style blocker
    const permissionKeywords = ["access", "permission", "need access", "can't access", "blocked by", "credentials"];
    const isPermission = permissionKeywords.some((kw) => msg.body.toLowerCase().includes(kw));

    if (isPermission) {
      const decision = this.evaluatePermission({
        taskId: msg.taskId,
        operation: "blocker-resolution",
        detail: msg.body,
      });

      if (decision.type === "approve") {
        return {
          action: "answered",
          reply: `Approved: ${decision.reason}. Proceed with the operation.`,
        };
      }
      if (decision.type === "deny") {
        return {
          action: "answered",
          reply: `Denied: ${decision.reason}. Find an alternative approach.`,
        };
      }
    }

    // Can't resolve — escalate
    this.ctx.onEscalate?.(`Blocker (${msg.taskId}): ${msg.body.substring(0, 300)}`);
    this.ctx.trace?.appendEvent({
      type: "permission_request",
      taskId: msg.taskId,
      operation: "agent_blocker",
      decision: "escalate",
      reason: "Cannot auto-resolve, escalating to human",
    });
    return { action: "escalated" };
  }

  /**
   * Search prior results for context relevant to a question.
   * Simple keyword matching — not LLM-based.
   */
  private findRelevantContext(question: string, priorResults: Record<string, string>): string | null {
    const keywords = question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    if (keywords.length === 0) return null;

    let bestMatch: { key: string; text: string; score: number } | null = null;

    for (const [key, text] of Object.entries(priorResults)) {
      const lower = text.toLowerCase();
      const score = keywords.filter((kw) => lower.includes(kw)).length;
      if (score >= 2 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { key, text: text.substring(0, 500), score };
      }
    }

    if (bestMatch) {
      return `From **${bestMatch.key}**:\n\n${bestMatch.text}`;
    }
    return null;
  }

  // ─── Private helpers ──────────────────────────────────────────────

  private loadRelayHealthInfo(): Map<string, RelayHealthInfo> {
    const map = new Map<string, RelayHealthInfo>();
    try {
      if (!fs.existsSync(this.ctx.relayHealthDir)) return map;
      const files = fs.readdirSync(this.ctx.relayHealthDir).filter((f: string) => f.endsWith(".md"));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(this.ctx.relayHealthDir, f), "utf-8");
          const health = this.parseRelayHealthInfoFrontmatter(content);
          if (health) {
            map.set(health.harnessType, health);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir doesn't exist yet */ }
    return map;
  }

  private parseRelayHealthInfoFrontmatter(content: string): RelayHealthInfo | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1];
    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
    };
    const getNum = (key: string): number => {
      const v = get(key);
      return v ? Number(v) : 0;
    };

    const relayId = get("relayId");
    if (!relayId) return null;

    return {
      relayId,
      harnessType: get("harnessType"),
      displayName: get("displayName"),
      status: (get("status") as RelayHealthInfo["status"]) || "offline",
      lastHeartbeat: get("lastHeartbeat") || null,
      tasksCompleted: getNum("tasksCompleted"),
      tasksFailed: getNum("tasksFailed"),
      avgResponseTimeMs: getNum("avgResponseTimeMs"),
      capabilities: [],
      discordChannelId: null,
      _filePath: "",
    };
  }

  private getAvailableHarnesses(healthMap: Map<string, RelayHealthInfo>): string[] {
    const available: string[] = [];
    for (const [harness, health] of healthMap) {
      if (health.status === "healthy" || health.status === "degraded") {
        available.push(harness);
      }
    }
    return available;
  }

  private getAgentsForRole(role: AgentRole): AgentDefinition[] {
    try {
      return getAllAgents().filter((a) => a.baseRole === role);
    } catch {
      return [];
    }
  }

  private scoreCandidate(
    agent: AgentDefinition,
    harness: HarnessType,
    health: RelayHealthInfo | undefined,
  ): number {
    let score = 50; // base

    // Prefer agents whose preferredHarness matches (no fallback penalty)
    if (agent.preferredHarness === harness) score += 20;

    // Health score: healthy > degraded
    if (health) {
      if (health.status === "healthy") score += 15;
      else if (health.status === "degraded") score += 5;

      // Success rate bonus
      const total = health.tasksCompleted + health.tasksFailed;
      if (total > 0) {
        const successRate = health.tasksCompleted / total;
        score += successRate * 10;
      }

      // Response time penalty (>60s starts costing points)
      if (health.avgResponseTimeMs > 60_000) {
        score -= Math.min(15, (health.avgResponseTimeMs - 60_000) / 10_000);
      }
    }

    // Performance profile bonus
    if (agent.performanceProfile?.targetSuccessRate) {
      score += agent.performanceProfile.targetSuccessRate * 5;
    }

    return score;
  }

  private findBestAlternative(
    role: AgentRole | undefined,
    availableHarnesses: string[],
    healthMap: Map<string, RelayHealthInfo>,
  ): { harness: HarnessType; reason: string } | null {
    if (availableHarnesses.length === 0) return null;

    // For coding roles, prefer code-capable harnesses
    const codingHarnesses = ["claude-code", "qwen-code", "mistral-vibe", "opencode", "codex-cli"];
    const workspaceHarnesses = ["gemini-cli"];

    let preferred: string[];
    if (role === "workspace") {
      preferred = workspaceHarnesses;
    } else {
      preferred = codingHarnesses;
    }

    // Try preferred category first
    for (const h of preferred) {
      if (availableHarnesses.includes(h)) {
        return { harness: h as HarnessType, reason: `role-compatible alternative` };
      }
    }

    // Fall back to healthiest available
    return {
      harness: this.pickHealthiest(availableHarnesses, healthMap),
      reason: "healthiest available",
    };
  }

  private pickHealthiest(
    harnesses: string[],
    healthMap: Map<string, RelayHealthInfo>,
  ): HarnessType {
    let best = harnesses[0] as HarnessType;
    let bestScore = -1;

    for (const h of harnesses) {
      const health = healthMap.get(h);
      let score = 0;
      if (health) {
        if (health.status === "healthy") score += 10;
        else if (health.status === "degraded") score += 5;
        const total = health.tasksCompleted + health.tasksFailed;
        if (total > 0) score += (health.tasksCompleted / total) * 5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = h as HarnessType;
      }
    }

    return best;
  }
}
