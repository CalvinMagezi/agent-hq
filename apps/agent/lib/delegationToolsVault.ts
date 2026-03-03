/**
 * Delegation tools for the HQ Agent orchestrator — Vault-based version.
 *
 * Replaces HTTP-based delegation with direct VaultClient filesystem operations.
 * API surface is identical to delegationTools.ts for drop-in replacement.
 *
 * Now includes distributed tracing (TraceDB), cancellation (signal files),
 * security constraints, and result overflow support.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { VaultClient } from "@repo/vault-client";
import type { DelegatedTask } from "@repo/vault-client";
import { TraceDB } from "@repo/vault-client/trace";
import * as fs from "fs";
import * as path from "path";
import type { AgentRole } from "./agentRoles.js";
import { getRoleConfig, detectRole } from "./agentRoles.js";
import type { ExecutionMode } from "./executionModes.js";
import { getModeConfig } from "./executionModes.js";
import { getFallbackChain, serializeFallbackChain } from "./modelFallback.js";

// Module-level config set at init time
let _vault: VaultClient | null = null;
let _vaultPath: string = "";
let _currentJobId: string | null = null;
let _currentUserId: string | null = null;
let _traceDb: TraceDB | null = null;
let _currentTraceId: string | null = null;
let _currentJobSpanId: string | null = null;

// Execution mode — set per-job via setCurrentExecutionMode()
let _currentExecutionMode: ExecutionMode = "standard";

// Notifiers — set at agent startup via setDelegationNotifiers()
let _discordBot: { sendProgressMessage: (content: string, embed?: any) => Promise<void> } | null = null;
let _wsServer: { broadcast: (msg: any) => void } | null = null;

/**
 * Set Discord bot and WebSocket server references for autonomous monitoring.
 * Called once from index.ts after both are initialized. Both may be null.
 */
export function setDelegationNotifiers(
    discordBot: { sendProgressMessage: (content: string, embed?: any) => Promise<void> } | null,
    wsServer: { broadcast: (msg: any) => void } | null,
): void {
    _discordBot = discordBot;
    _wsServer = wsServer;
}

/** Initialize delegation tools with vault path */
export function initDelegationTools(vaultPath: string, _apiKey?: string) {
    _vault = new VaultClient(vaultPath);
    _vaultPath = vaultPath;
    _traceDb = new TraceDB(vaultPath);
}

/** Set the current job context for delegation (called per-job) */
export function setCurrentJob(
    jobId: string | null,
    userId: string | null,
    traceId?: string | null,
    jobSpanId?: string | null,
) {
    _currentJobId = jobId;
    _currentUserId = userId;
    _currentTraceId = traceId ?? null;
    _currentJobSpanId = jobSpanId ?? null;
}

/** Set the execution mode for the current job (affects parallelism, timeouts, etc.) */
export function setCurrentExecutionMode(mode: ExecutionMode): void {
    _currentExecutionMode = mode;
}

// ── delegate_to_relay ──────────────────────────────────────────

const SecurityConstraintsSchema = Type.Object({
    noGit: Type.Optional(Type.Boolean({ description: "Block all git commands" })),
    noNetwork: Type.Optional(Type.Boolean({ description: "Block network access" })),
    filesystemAccess: Type.Optional(Type.Union([
        Type.Literal("full"),
        Type.Literal("read-only"),
        Type.Literal("restricted"),
    ], { description: "Filesystem access level" })),
    allowedDirectories: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths when restricted" })),
    blockedCommands: Type.Optional(Type.Array(Type.String(), { description: "Regex patterns for blocked commands" })),
    maxExecutionMs: Type.Optional(Type.Number({ description: "Max execution time in ms" })),
});

const AgentRoleSchema = Type.Optional(Type.Union([
    Type.Literal("coder"),
    Type.Literal("researcher"),
    Type.Literal("reviewer"),
    Type.Literal("planner"),
    Type.Literal("devops"),
    Type.Literal("workspace"),
], { description: "Agent role — affects system prompt, model hint, and turn limits. Auto-detected if omitted." }));

const DelegateToRelaySchema = Type.Object({
    tasks: Type.Array(
        Type.Object({
            taskId: Type.String({ description: "Unique task identifier within this job (e.g., 'research-1', 'code-fix-2')" }),
            instruction: Type.String({ description: "The full prompt/instruction for the relay bot to execute" }),
            targetHarnessType: Type.Union([
                Type.Literal("claude-code"),
                Type.Literal("opencode"),
                Type.Literal("gemini-cli"),
                Type.Literal("any"),
            ], { description: "Which relay bot type to target" }),
            role: AgentRoleSchema,
            modelOverride: Type.Optional(Type.String({ description: "Optional model override" })),
            dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
            priority: Type.Optional(Type.Number({ description: "Priority (higher = processed first, default 50)" })),
            securityConstraints: Type.Optional(SecurityConstraintsSchema),
        }),
    ),
    discordChannelId: Type.Optional(Type.String({ description: "Discord channel to post results to" })),
});

export const DelegateToRelayTool: AgentTool<typeof DelegateToRelaySchema> = {
    name: "delegate_to_relay",
    description: `Delegate tasks to Discord relay bots for execution. Each task is sent to a specific relay bot type:
- claude-code: Best for code editing, git operations, debugging, complex refactoring
- opencode: Multi-model flexibility, quick code generation, model comparison
- gemini-cli: Google Workspace (Docs, Sheets, Drive, Gmail, Calendar, Keep), research, analysis, summarization. NOT for coding tasks.
- any: Auto-select the healthiest available relay

AGENT ROLES (optional — auto-detected if omitted):
- coder: Writes, modifies, debugs code. Reads before editing, verifies after.
- researcher: Investigates questions, explores codebases. Read-only — does NOT modify files.
- reviewer: Validates code changes for correctness and security. Read-only — only reports findings.
- planner: Analyzes requirements, creates implementation plans. Does NOT implement.
- devops: Handles deployment, CI/CD, infrastructure. Validates before applying.
- workspace: Google Workspace operations (Calendar, Gmail, Drive, Docs).

ROUTING GUIDELINES:
- Google Docs/Sheets/Drive/Gmail/Calendar/Keep tasks → gemini-cli + workspace role
- Code editing, debugging, git operations → claude-code + coder role
- Code review, security audit → claude-code + reviewer role
- Research, investigation → claude-code + researcher role

Tasks can have dependencies (dependsOn) to create execution chains. Always check relay health first with check_relay_health.
Use securityConstraints per task to restrict what the relay can do (e.g., noGit: true, filesystemAccess: "read-only").`,
    parameters: DelegateToRelaySchema,
    label: "Delegate to Relay",
    execute: async (_toolCallId, args) => {
        if (!_currentJobId || !_vault) {
            return {
                content: [{ type: "text", text: "Error: No active job context or vault not initialized." }],
                details: {},
            };
        }

        // Check execution mode limits
        const modeConfig = getModeConfig(_currentExecutionMode);
        if (args.tasks.length > modeConfig.maxParallelTasks) {
            const independent = args.tasks.filter(t => !t.dependsOn || t.dependsOn.length === 0);
            if (independent.length > modeConfig.maxParallelTasks) {
                return {
                    content: [{
                        type: "text",
                        text: `⚠️ Execution mode "${_currentExecutionMode}" allows max ${modeConfig.maxParallelTasks} parallel tasks, but ${independent.length} independent tasks were submitted. Reduce the number of parallel tasks or switch to a higher mode (e.g., [THOROUGH] prefix in instruction).`,
                    }],
                    details: { mode: _currentExecutionMode, maxParallel: modeConfig.maxParallelTasks },
                };
            }
        }

        try {
            // Create spans for each task and attach trace context
            const tasksWithTrace = args.tasks.map((t) => {
                // Resolve role: explicit > auto-detected from instruction
                const role: AgentRole = (t.role as AgentRole | undefined) ?? detectRole(t.instruction);
                const roleConfig = getRoleConfig(role);

                // If role specifies a preferred harness and task uses "any", use role's preference
                let effectiveHarness = t.targetHarnessType;
                if (effectiveHarness === "any" && roleConfig?.preferredHarness && roleConfig.preferredHarness !== "any") {
                    effectiveHarness = roleConfig.preferredHarness;
                }

                // Build model override: explicit > role hint > mode preference > none
                const effectiveModel = t.modelOverride
                    ?? roleConfig?.modelHint
                    ?? (modeConfig.preferredModel || undefined);

                // Build fallback chain for this task's model
                const fallbackChain = effectiveModel ? getFallbackChain(effectiveModel) : undefined;

                let spanId: string | undefined;
                if (_traceDb && _currentTraceId) {
                    spanId = _traceDb.createSpan({
                        traceId: _currentTraceId,
                        parentSpanId: _currentJobSpanId ?? undefined,
                        taskId: t.taskId,
                        type: "delegation",
                        name: `${effectiveHarness}${role ? `/${role}` : ""}: ${t.taskId}`,
                    });
                    _traceDb.addSpanEvent(spanId, _currentTraceId, "started",
                        `Delegated to ${effectiveHarness}${role ? ` (role: ${role})` : ""}: ${t.instruction.substring(0, 80)}`);
                    _traceDb.updateTraceCounts(_currentTraceId, { total: 1 });
                }

                return {
                    taskId: t.taskId,
                    instruction: t.instruction,
                    targetHarnessType: effectiveHarness as any,
                    modelOverride: effectiveModel,
                    dependsOn: t.dependsOn || [],
                    priority: t.priority,
                    traceId: _currentTraceId ?? undefined,
                    spanId,
                    parentSpanId: _currentJobSpanId ?? undefined,
                    securityConstraints: t.securityConstraints as any,
                    // Extended metadata for role + fallback (stored in frontmatter)
                    metadata: {
                        role,
                        ...(fallbackChain && fallbackChain.fallbacks.length > 0 && {
                            fallbackModels: serializeFallbackChain(fallbackChain),
                        }),
                        executionMode: _currentExecutionMode,
                    },
                };
            });

            await _vault.createDelegatedTasks(_currentJobId, tasksWithTrace);

            const taskList = args.tasks
                .map((t) => {
                    const detectedRole = (t.role as AgentRole | undefined) ?? detectRole(t.instruction);
                    const roleTag = ` [${detectedRole}]`;
                    return `  - ${t.taskId}${roleTag} → ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}${t.instruction.length > 80 ? "..." : ""}`;
                })
                .join("\n");

            const traceInfo = _currentTraceId
                ? `\nTrace ID: ${_currentTraceId} (use get_trace_status for real-time progress)`
                : "";

            const modeInfo = `\nExecution mode: ${_currentExecutionMode} (max ${modeConfig.maxParallelTasks} parallel, ${Math.round(modeConfig.delegationTimeoutMs / 60000)}min timeout)`;

            return {
                content: [{
                    type: "text",
                    text: `Delegated ${args.tasks.length} task(s) to vault queue:\n${taskList}\n${traceInfo}${modeInfo}\nUse check_delegation_status to monitor progress.`,
                }],
                details: { taskIds: args.tasks.map((t) => t.taskId) },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Delegation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── check_relay_health ─────────────────────────────────────────

const CheckRelayHealthSchema = Type.Object({
    relayId: Type.Optional(Type.String({ description: "Specific relay ID to check. Omit for all relays." })),
});

export const CheckRelayHealthTool: AgentTool<typeof CheckRelayHealthSchema> = {
    name: "check_relay_health",
    description: "Check the health status of Discord relay bots.",
    parameters: CheckRelayHealthSchema,
    label: "Check Relay Health",
    execute: async (_toolCallId, args) => {
        if (!_vault) {
            return { content: [{ type: "text", text: "Vault not initialized." }], details: {} };
        }

        try {
            let relays = await _vault.getRelayHealthAll();

            if (args.relayId) {
                relays = relays.filter((r) => r.relayId === args.relayId);
            }

            if (relays.length === 0) {
                return {
                    content: [{ type: "text", text: "No relay bots found. Ensure the discord-relay process is running." }],
                    details: {},
                };
            }

            const report = relays.map((r) => {
                const age = r.lastHeartbeat ? Date.now() - new Date(r.lastHeartbeat).getTime() : Infinity;
                const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60000)}m ago`;
                return [
                    `**${r.displayName}** (${r.relayId})`,
                    `  Status: ${r.status}`,
                    `  Harness: ${r.harnessType}`,
                    `  Last heartbeat: ${r.lastHeartbeat ? ageStr : "never"}`,
                    `  Tasks: ${r.tasksCompleted} completed, ${r.tasksFailed} failed`,
                    r.avgResponseTimeMs ? `  Avg response: ${Math.round(r.avgResponseTimeMs / 1000)}s` : "",
                    r.capabilities?.length ? `  Capabilities: ${r.capabilities.join(", ")}` : "",
                ].filter(Boolean).join("\n");
            }).join("\n\n");

            return {
                content: [{ type: "text", text: `# Relay Health Report\n\n${report}` }],
                details: { relays },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Health check error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── check_delegation_status ────────────────────────────────────

const CheckDelegationStatusSchema = Type.Object({
    jobId: Type.Optional(Type.String({ description: "Job ID to check. Defaults to current job." })),
});

export const CheckDelegationStatusTool: AgentTool<typeof CheckDelegationStatusSchema> = {
    name: "check_delegation_status",
    description: "Check the status of delegated tasks, including real-time progress and timing.",
    parameters: CheckDelegationStatusSchema,
    label: "Check Delegation Status",
    execute: async (_toolCallId, args) => {
        const jobId = args.jobId || _currentJobId;
        if (!jobId || !_vault) {
            return { content: [{ type: "text", text: "Error: No job ID or vault not initialized." }], details: {} };
        }

        try {
            const tasks = await _vault.getTasksForJob(jobId);

            if (tasks.length === 0) {
                return { content: [{ type: "text", text: "No delegated tasks found for this job." }], details: {} };
            }

            const statusCounts: Record<string, number> = {};
            for (const t of tasks) {
                statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
            }

            const summary = Object.entries(statusCounts)
                .map(([status, count]) => `${status}: ${count}`)
                .join(", ");

            // Enrich with trace span timing if available
            const traceId = _currentTraceId;
            const taskLines = tasks.map((t) => {
                let line = `  [${t.status.toUpperCase()}] ${t.taskId} → ${t.targetHarnessType}`;
                if (t.claimedBy) line += ` (claimed by ${t.claimedBy})`;

                // Add timing from TraceDB
                if (_traceDb && t.spanId) {
                    const span = _traceDb.getSpan(t.spanId);
                    if (span) {
                        const elapsed = span.completedAt
                            ? Math.round((span.completedAt - span.startedAt) / 1000)
                            : Math.round((Date.now() - span.startedAt) / 1000);
                        const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m${elapsed % 60}s`;
                        line += ` [${elapsedStr}]`;
                    }
                }

                if (t.result) line += `\n    Result: ${t.result.substring(0, 200)}${t.result.length > 200 ? "..." : ""}`;
                if (t.error) line += `\n    Error: ${t.error}`;
                return line;
            }).join("\n");

            const completedCount = tasks.filter(t => ["completed", "failed", "cancelled", "timeout"].includes(t.status)).length;
            const progress = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

            const allDone = tasks.every((t) =>
                ["completed", "failed", "cancelled", "timeout"].includes(t.status),
            );

            let progressLine = `\nProgress: ${completedCount}/${tasks.length} tasks complete (${progress}%)`;
            if (traceId) progressLine += ` | Trace: ${traceId}`;

            return {
                content: [{
                    type: "text",
                    text: `# Delegation Status (${summary})${progressLine}\n\n${taskLines}${allDone ? "\n\nAll tasks have finished. Use aggregate_results to compile the final report." : ""}`,
                }],
                details: { tasks, allDone, progress },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Status check error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── aggregate_results ──────────────────────────────────────────

const AggregateResultsSchema = Type.Object({
    jobId: Type.Optional(Type.String({ description: "Job ID to aggregate. Defaults to current job." })),
});

export const AggregateResultsTool: AgentTool<typeof AggregateResultsSchema> = {
    name: "aggregate_results",
    description: "Aggregate and compile results from all completed delegated tasks for a job. Automatically reads full result files if results were too large to store inline.",
    parameters: AggregateResultsSchema,
    label: "Aggregate Results",
    execute: async (_toolCallId, args) => {
        const jobId = args.jobId || _currentJobId;
        if (!jobId || !_vault) {
            return { content: [{ type: "text", text: "Error: No job ID or vault not initialized." }], details: {} };
        }

        try {
            const tasks = await _vault.getTasksForJob(jobId);

            if (tasks.length === 0) {
                return { content: [{ type: "text", text: "No delegated tasks found for this job." }], details: {} };
            }

            const completed = tasks.filter((t) => t.status === "completed");
            const failed = tasks.filter((t) => t.status === "failed" || t.status === "timeout");
            const cancelled = tasks.filter((t) => t.status === "cancelled");
            const pending = tasks.filter((t) => !["completed", "failed", "timeout", "cancelled"].includes(t.status));

            let report = `# Aggregated Results\n\n`;
            report += `Tasks: ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled, ${pending.length} still in progress\n\n`;

            if (completed.length > 0) {
                report += `## Completed Tasks\n\n`;
                for (const t of completed) {
                    report += `### ${t.taskId} (${t.targetHarnessType}${t.claimedBy ? `, executed by ${t.claimedBy}` : ""})\n`;

                    // Check for full result pointer
                    let result = t.result || "(no result text)";
                    const fullResultMatch = result.match(/\[Full result: ([^\]]+)\]/);
                    if (fullResultMatch) {
                        const fullResult = _vault.readFullResult(t.taskId);
                        if (fullResult) {
                            result = fullResult;
                        }
                    }

                    report += result;
                    report += "\n\n";
                }
            }

            if (failed.length > 0) {
                report += `## Failed Tasks\n\n`;
                for (const t of failed) {
                    report += `### ${t.taskId} (${t.status})\n`;
                    report += t.error || "(no error details)";
                    report += "\n\n";
                }
            }

            if (cancelled.length > 0) {
                report += `## Cancelled Tasks\n\n`;
                for (const t of cancelled) {
                    report += `- ${t.taskId}: ${t.error || "Cancelled"}\n`;
                }
                report += "\n";
            }

            if (pending.length > 0) {
                report += `## Still In Progress\n\n`;
                for (const t of pending) {
                    report += `- ${t.taskId}: ${t.status}\n`;
                }
            }

            // Close the trace if all terminal
            if (pending.length === 0 && _traceDb && _currentTraceId) {
                const finalStatus = failed.length > 0 && completed.length === 0 ? "failed" : "completed";
                _traceDb.completeTrace(_currentTraceId, finalStatus);

                // Close any still-active spans
                const spans = _traceDb.getSpansForTrace(_currentTraceId);
                for (const span of spans) {
                    if (span.status === "active") {
                        _traceDb.completeSpan(span.spanId, "completed");
                    }
                }
            }

            return {
                content: [{ type: "text", text: report }],
                details: { completed: completed.length, failed: failed.length, cancelled: cancelled.length, pending: pending.length },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Aggregation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── cancel_delegation ──────────────────────────────────────────

const CancelDelegationSchema = Type.Object({
    taskIds: Type.Array(Type.String(), { description: "Task IDs to cancel" }),
    reason: Type.Optional(Type.String({ description: "Reason for cancellation" })),
});

export const CancelDelegationTool: AgentTool<typeof CancelDelegationSchema> = {
    name: "cancel_delegation",
    description: "Cancel one or more delegated tasks. The relay bot will abort execution after its current operation finishes (within ~2s). Partial results are preserved.",
    parameters: CancelDelegationSchema,
    label: "Cancel Delegation",
    execute: async (_toolCallId, args) => {
        if (!_vault) {
            return { content: [{ type: "text", text: "Vault not initialized." }], details: {} };
        }

        const results: string[] = [];
        const signalsDir = path.join(_vaultPath, "_delegation/signals");

        try {
            if (!fs.existsSync(signalsDir)) {
                fs.mkdirSync(signalsDir, { recursive: true });
            }

            for (const taskId of args.taskIds) {
                try {
                    // Write signal file (relay polls for this every 2s)
                    const signalPath = path.join(signalsDir, `cancel-${taskId}.md`);
                    fs.writeFileSync(signalPath, `---\ncancelledAt: ${new Date().toISOString()}\nreason: ${args.reason ?? "Cancelled by HQ"}\n---\n`, "utf-8");

                    // Update task status in vault
                    await _vault.updateTaskStatus(taskId, "cancelled", undefined, args.reason ?? "Cancelled by HQ");

                    // Update trace span
                    if (_traceDb && _currentTraceId) {
                        const span = _traceDb.getSpanByTaskId(taskId);
                        if (span) {
                            _traceDb.addSpanEvent(span.spanId, _currentTraceId, "cancelled", args.reason ?? "Cancelled by HQ");
                            _traceDb.completeSpan(span.spanId, "cancelled");
                        }
                    }

                    results.push(`✓ ${taskId}: cancellation signal sent`);
                } catch (err: any) {
                    results.push(`✗ ${taskId}: ${err.message}`);
                }
            }

            return {
                content: [{ type: "text", text: `Cancellation results:\n${results.join("\n")}\n\nRelay bots will stop within ~2s of receiving the signal.` }],
                details: { results },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Cancellation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── wait_for_delegation ─────────────────────────────────────────

const TERMINAL_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);

function formatElapsed(ms: number): string {
    return ms < 60_000
        ? `${Math.round(ms / 1000)}s`
        : `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const WaitForDelegationSchema = Type.Object({
    taskIds: Type.Array(Type.String(), {
        description: "The task IDs dispatched via delegate_to_relay. Must exactly match taskId fields from that call.",
    }),
    instructionSummary: Type.String({
        description: "Short human-readable title for Discord messages, e.g. 'Building QA Dashboard' (under 60 chars).",
    }),
    timeoutMinutes: Type.Optional(Type.Number({
        description: "Max wait time in minutes before returning partial results. Default: 30.",
    })),
});

export const WaitForDelegationTool: AgentTool<typeof WaitForDelegationSchema> = {
    name: "wait_for_delegation",
    description: `Wait for all delegated tasks to complete, sending proactive Discord notifications as each task finishes.

Call this ONCE immediately after delegate_to_relay. Pass the exact taskIds from that call.
Polling happens internally every 15 seconds — does NOT consume tool call budget.
Returns a structured summary when all tasks are terminal (completed/failed/cancelled) or timeout is reached.

Replaces the manual check_delegation_status loop + aggregate_results pattern for normal delegation flows.`,
    parameters: WaitForDelegationSchema,
    label: "Wait for Delegation",
    execute: async (_toolCallId, args) => {
        if (!_currentJobId || !_vault) {
            return {
                content: [{ type: "text", text: "Error: No active job context or vault not initialized." }],
                details: {},
            };
        }

        const monitoredTaskIds = new Set(args.taskIds);
        const summary = args.instructionSummary;
        // Use explicit timeout if provided, otherwise derive from execution mode
        const modeConfig = getModeConfig(_currentExecutionMode);
        const timeoutMs = args.timeoutMinutes
            ? args.timeoutMinutes * 60 * 1000
            : modeConfig.delegationTimeoutMs;
        const pollIntervalMs = 15_000;
        const startTime = Date.now();
        const announcedTerminal = new Set<string>();
        const jobId = _currentJobId;

        console.log(`\n⏳ [wait_for_delegation] Monitoring ${monitoredTaskIds.size} tasks for: "${summary}"`);

        // Initial Discord notification
        try {
            await _discordBot?.sendProgressMessage(
                `⏳ **${summary}** — Monitoring ${monitoredTaskIds.size} task${monitoredTaskIds.size !== 1 ? "s" : ""}... I'll update you as each one completes.`,
            );
        } catch { /* non-fatal */ }

        // Polling loop — all inside this single tool call
        while (true) {
            const elapsed = Date.now() - startTime;

            // Timeout check
            if (elapsed >= timeoutMs) {
                console.log(`\n⏰ [wait_for_delegation] Timeout after ${args.timeoutMinutes ?? 30}m`);
                try {
                    await _discordBot?.sendProgressMessage(
                        `⚠️ **${summary}** — Timed out after ${formatElapsed(elapsed)}. Some tasks may still be running. Use \`get_trace_status\` for details.`,
                    );
                } catch { /* non-fatal */ }
                break;
            }

            // Fetch current task states
            let tasks: DelegatedTask[] = [];
            try {
                const allTasks = await _vault.getTasksForJob(jobId);
                tasks = allTasks.filter(t => monitoredTaskIds.has(t.taskId));
            } catch (err: any) {
                console.warn(`[wait_for_delegation] Vault read error: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                continue;
            }

            // Detect newly-terminal tasks
            const newlyTerminal = tasks.filter(
                t => TERMINAL_STATUSES.has(t.status) && !announcedTerminal.has(t.taskId)
            );
            for (const t of newlyTerminal) announcedTerminal.add(t.taskId);

            // Send progress Discord message when any task completes
            if (newlyTerminal.length > 0) {
                const completedCount = tasks.filter(t => TERMINAL_STATUSES.has(t.status)).length;
                const statusLines = tasks.map(t => {
                    if (t.status === "completed") return `✅ ${t.taskId}`;
                    if (t.status === "failed")    return `❌ ${t.taskId}: ${(t.error ?? "failed").substring(0, 60)}`;
                    if (t.status === "cancelled") return `🚫 ${t.taskId}: cancelled`;
                    if (t.status === "claimed")   return `🔄 ${t.taskId}: running (${t.claimedBy ?? "relay"})`;
                    return `⏳ ${t.taskId}: ${t.status}`;
                }).join("\n");

                try {
                    await _discordBot?.sendProgressMessage(
                        `⏳ **${summary}** — Progress: ${completedCount}/${tasks.length} tasks done\n${statusLines}`
                    );
                } catch { /* non-fatal */ }

                _wsServer?.broadcast({
                    type: "event",
                    event: "delegation.progress",
                    payload: {
                        jobId,
                        summary,
                        completedCount,
                        totalCount: tasks.length,
                        newlyTerminal: newlyTerminal.map(t => ({ taskId: t.taskId, status: t.status })),
                        timestamp: new Date().toISOString(),
                    },
                });

                console.log(`\n📊 [wait_for_delegation] ${completedCount}/${tasks.length} tasks terminal`);
            }

            // All done?
            if (tasks.length > 0 && tasks.every(t => TERMINAL_STATUSES.has(t.status))) {
                console.log(`\n✅ [wait_for_delegation] All ${tasks.length} tasks complete`);
                break;
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // Build final result
        let finalTasks: DelegatedTask[] = [];
        try {
            const allTasks = await _vault.getTasksForJob(jobId);
            finalTasks = allTasks.filter(t => monitoredTaskIds.has(t.taskId));
        } catch { /* best-effort */ }

        const completedTasks = finalTasks.filter(t => t.status === "completed");
        const failedTasks    = finalTasks.filter(t => t.status === "failed");
        const cancelledTasks = finalTasks.filter(t => t.status === "cancelled");
        const stillPending   = finalTasks.filter(t => !TERMINAL_STATUSES.has(t.status));
        const timedOut = Date.now() - startTime >= timeoutMs;
        const elapsedStr = formatElapsed(Date.now() - startTime);

        // Read full results for completed tasks (handles overflow files)
        const completedWithResults = completedTasks.map(t => {
            let result = t.result ?? "";
            if (result.startsWith("[Full result:")) {
                result = _vault!.readFullResult(t.taskId) ?? result;
            }
            return { taskId: t.taskId, result: result.substring(0, 2000) };
        });

        // Send final Discord embed
        const allClean = failedTasks.length === 0 && cancelledTasks.length === 0 && stillPending.length === 0;
        try {
            if (allClean) {
                await _discordBot?.sendProgressMessage("", {
                    title: `✅ ${summary} — All ${completedTasks.length} tasks complete`,
                    description: `Finished in ${elapsedStr}\n\n${completedTasks.map(t => `**${t.taskId}**: ${(t.result ?? "").substring(0, 100)}`).join("\n")}`,
                    color: 0x22c55e,
                });
            } else {
                const parts = [
                    completedTasks.length > 0  && `${completedTasks.length} completed`,
                    failedTasks.length > 0     && `${failedTasks.length} failed`,
                    cancelledTasks.length > 0  && `${cancelledTasks.length} cancelled`,
                    stillPending.length > 0    && `${stillPending.length} still running`,
                ].filter(Boolean).join(", ");

                const descLines = [
                    ...completedTasks.map(t => `✅ **${t.taskId}**: ${(t.result ?? "").substring(0, 80)}`),
                    ...failedTasks.map(t    => `❌ **${t.taskId}**: ${(t.error ?? "failed").substring(0, 80)}`),
                    ...cancelledTasks.map(t => `🚫 **${t.taskId}**: cancelled`),
                    ...stillPending.map(t   => `⏳ **${t.taskId}**: ${t.status}`),
                ].join("\n");

                await _discordBot?.sendProgressMessage("", {
                    title: `${timedOut ? "⏰" : "⚠️"} ${summary} — ${parts}`,
                    description: `Elapsed: ${elapsedStr}${timedOut ? " (timeout)" : ""}\n\n${descLines}`,
                    color: timedOut ? 0xfbbf24 : 0xef4444,
                });
            }
        } catch { /* non-fatal */ }

        // Build LLM-readable summary
        let llmSummary = `# Delegation Results: ${summary}\n\n`;
        llmSummary += `**Duration**: ${elapsedStr} | **Status**: ${allClean ? "All complete" : timedOut ? "Timed out" : "Partial"}\n`;
        llmSummary += `**Tasks**: ${completedTasks.length} completed, ${failedTasks.length} failed, ${cancelledTasks.length} cancelled, ${stillPending.length} still running\n\n`;
        if (completedTasks.length > 0) {
            llmSummary += `## Completed Results\n\n`;
            for (const t of completedWithResults) {
                llmSummary += `### ${t.taskId}\n${t.result || "(no result)"}\n\n`;
            }
        }
        if (failedTasks.length > 0) {
            llmSummary += `## Failed Tasks\n\n${failedTasks.map(t => `- **${t.taskId}**: ${t.error ?? "no details"}`).join("\n")}\n\n`;
        }

        return {
            content: [{ type: "text", text: llmSummary }],
            details: {
                allComplete: stillPending.length === 0,
                timedOut,
                completedTasks: completedWithResults,
                failedTasks: failedTasks.map(t => ({ taskId: t.taskId, error: t.error ?? "unknown" })),
                cancelledTasks: cancelledTasks.map(t => t.taskId),
                stillPending: stillPending.map(t => ({ taskId: t.taskId, status: t.status })),
            },
        };
    },
};

// ── get_trace_status ───────────────────────────────────────────

const GetTraceStatusSchema = Type.Object({
    traceId: Type.Optional(Type.String({ description: "Trace ID to query. Defaults to current orchestration trace." })),
});

export const GetTraceStatusTool: AgentTool<typeof GetTraceStatusSchema> = {
    name: "get_trace_status",
    description: "Get the full orchestration trace tree — all delegated task spans with their status, timing, and events. Use this for a quick overview of the current orchestration.",
    parameters: GetTraceStatusSchema,
    label: "Get Trace Status",
    execute: async (_toolCallId, args) => {
        if (!_traceDb) {
            return { content: [{ type: "text", text: "TraceDB not initialized." }], details: {} };
        }

        const traceId = args.traceId || _currentTraceId;
        if (!traceId) {
            // Return all active traces
            const active = _traceDb.getActiveTraces();
            if (active.length === 0) {
                return { content: [{ type: "text", text: "No active orchestration traces." }], details: {} };
            }
            const lines = active.map(t =>
                `- ${t.traceId} (job: ${t.jobId}) — ${t.completedTasks}/${t.totalTasks} tasks`
            ).join("\n");
            return { content: [{ type: "text", text: `Active traces:\n${lines}` }], details: { traces: active } };
        }

        const tree = _traceDb.getTraceTree(traceId);
        if (!tree) {
            return { content: [{ type: "text", text: `Trace not found: ${traceId}` }], details: {} };
        }

        const elapsedMs = tree.completedAt ? tree.completedAt - tree.startedAt : Date.now() - tree.startedAt;
        const elapsedStr = elapsedMs < 60000 ? `${Math.round(elapsedMs / 1000)}s` : `${Math.round(elapsedMs / 60000)}m${Math.round((elapsedMs % 60000) / 1000)}s`;

        let report = `# Orchestration Trace: ${traceId}\n\n`;
        report += `**Status**: ${tree.status} | **Progress**: ${tree.completedTasks}/${tree.totalTasks} tasks (${tree.failedTasks} failed) | **Elapsed**: ${elapsedStr}\n\n`;

        if (tree.spans.length > 0) {
            report += `## Spans\n\n`;
            for (const span of tree.spans) {
                const spanElapsed = span.completedAt
                    ? Math.round((span.completedAt - span.startedAt) / 1000)
                    : Math.round((Date.now() - span.startedAt) / 1000);
                const dur = spanElapsed < 60 ? `${spanElapsed}s` : `${Math.round(spanElapsed / 60)}m${spanElapsed % 60}s`;
                const claimedBy = span.claimedBy ? ` → ${span.claimedBy}` : "";
                report += `- **${span.taskId || span.name}** [${span.status.toUpperCase()}] ${dur}${claimedBy}\n`;

                // Show last event
                const lastEvent = span.events[span.events.length - 1];
                if (lastEvent) {
                    report += `  Last: ${lastEvent.eventType}${lastEvent.message ? ` — ${lastEvent.message.substring(0, 80)}` : ""}\n`;
                }
            }
        }

        return {
            content: [{ type: "text", text: report }],
            details: { tree },
        };
    },
};

// ── get_live_task_output ────────────────────────────────────────

const GetLiveTaskOutputSchema = Type.Object({
    taskId: Type.Optional(Type.String({
        description: "Specific task ID to inspect. Omit to auto-detect the most recently active running task.",
    })),
    maxChars: Type.Optional(Type.Number({
        description: "Max characters of output to return (default: 3000).",
    })),
});

export const GetLiveTaskOutputTool: AgentTool<typeof GetLiveTaskOutputSchema> = {
    name: "get_live_task_output",
    description: `Read the live stdout output from a currently-running relay harness task.

Use this when you have delegated tasks running and want to see what Claude Code / OpenCode / Gemini CLI is currently outputting mid-task — without waiting for it to complete.

If no taskId is given, returns the most recently active live task.

Returns:
- Which relay is running it and how long it has been running
- Total bytes of output written so far
- The last N chars of raw harness stdout (default 3000 chars)
- A stall warning if no new output has arrived in >60s`,
    parameters: GetLiveTaskOutputSchema,
    label: "Get Live Task Output",
    execute: async (_toolCallId, args) => {
        if (!_vault) {
            return { content: [{ type: "text", text: "Vault not initialized." }], details: {} };
        }

        try {
            const maxChars = args.maxChars ?? 3000;
            const liveOutput = args.taskId
                ? _vault.readLiveOutput(args.taskId)
                : _vault.listLiveTasks()[0] ?? null;

            if (!liveOutput) {
                const msg = args.taskId
                    ? `No live output file found for task: ${args.taskId}. The task may not have started yet, or it already completed (live files are deleted at completion).`
                    : "No tasks currently have live output. Tasks must be actively running in a relay harness for live output to be available.";
                return { content: [{ type: "text", text: msg }], details: {} };
            }

            const startedMs = new Date(liveOutput.startedAt).getTime();
            const lastChunkMs = new Date(liveOutput.lastChunkAt).getTime();
            const nowMs = Date.now();
            const elapsedSec = Math.round((nowMs - startedMs) / 1000);
            const elapsedStr = elapsedSec < 60
                ? `${elapsedSec}s`
                : `${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s`;
            const staleSec = Math.round((nowMs - lastChunkMs) / 1000);
            const isStalled = staleSec > 60;
            const stallStr = isStalled
                ? `\n\n> WARNING: No output in ${staleSec}s — task may be stalled. Consider using cancel_delegation.`
                : `\n(Last chunk: ${staleSec}s ago)`;

            const tail = liveOutput.output.length > maxChars
                ? `[...trimmed, showing last ${maxChars} chars]\n` + liveOutput.output.slice(-maxChars)
                : liveOutput.output;

            const report = [
                `# Live Task Output: ${liveOutput.taskId}`,
                ``,
                `**Relay**: ${liveOutput.claimedBy}`,
                `**Running for**: ${elapsedStr}`,
                `**Bytes written**: ${liveOutput.byteCount.toLocaleString()}`,
                stallStr,
                ``,
                `## Current Output`,
                ``,
                "```",
                tail || "(no output yet)",
                "```",
            ].join("\n");

            return {
                content: [{ type: "text", text: report }],
                details: {
                    taskId: liveOutput.taskId,
                    claimedBy: liveOutput.claimedBy,
                    elapsedSec,
                    byteCount: liveOutput.byteCount,
                    isStalled,
                    lastChunkSec: staleSec,
                },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Live output error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};
