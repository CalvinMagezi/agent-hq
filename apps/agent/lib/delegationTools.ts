/**
 * Delegation tools for the HQ Agent orchestrator.
 * These tools enable the HQ agent to delegate tasks to relay bots,
 * monitor their health, and aggregate results.
 *
 * Uses HTTP endpoints on the Convex site URL (same pattern as discord relay).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

// Module-level config set at init time
let _siteUrl = "";
let _apiKey = "";
let _currentJobId: string | null = null;
let _currentUserId: string | null = null;

/** Initialize delegation tools with Convex connection info */
export function initDelegationTools(siteUrl: string, apiKey: string) {
    _siteUrl = siteUrl;
    _apiKey = apiKey;
}

/** Set the current job context for delegation (called per-job) */
export function setCurrentJob(jobId: string | null, userId: string | null) {
    _currentJobId = jobId;
    _currentUserId = userId;
}

async function post(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${_siteUrl}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": _apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Delegation API ${path} failed (${res.status}): ${text}`);
    }

    return res.json();
}

// ── delegate_to_relay ──────────────────────────────────────────────

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
            ], { description: "Which relay bot type to target. 'claude-code' for coding, 'opencode' for multi-model, 'gemini-cli' for research, 'any' for auto-select" }),
            modelOverride: Type.Optional(Type.String({ description: "Optional model override (e.g., 'opus', 'sonnet')" })),
            dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete before this task starts" })),
            priority: Type.Optional(Type.Number({ description: "Priority (higher = processed first, default 50)" })),
        }),
    ),
    discordChannelId: Type.Optional(Type.String({ description: "Discord channel to post results to" })),
});

export const DelegateToRelayTool: AgentTool<typeof DelegateToRelaySchema> = {
    name: "delegate_to_relay",
    description: `Delegate tasks to Discord relay bots for execution. Each task is sent to a specific relay bot type:
- claude-code: Best for code editing, git operations, debugging, complex refactoring
- opencode: Multi-model flexibility, quick code generation, model comparison
- gemini-cli: Research, analysis, summarization, large context processing
- any: Auto-select the healthiest available relay

Tasks can have dependencies (dependsOn) to create execution chains. Always check relay health first with check_relay_health.`,
    parameters: DelegateToRelaySchema,
    label: "Delegate to Relay",
    execute: async (_toolCallId, args) => {
        if (!_currentJobId) {
            return {
                content: [{ type: "text", text: "Error: No active job context. Cannot delegate without a parent job." }],
                details: {},
            };
        }

        try {
            const tasksPayload = args.tasks.map((t) => ({
                taskId: t.taskId,
                instruction: t.instruction,
                targetHarnessType: t.targetHarnessType,
                modelOverride: t.modelOverride,
                dependsOn: t.dependsOn || [],
                priority: t.priority,
                discordChannelId: args.discordChannelId,
            }));

            const data = await post("/api/relay/tasks/create", {
                jobId: _currentJobId,
                tasks: tasksPayload,
            });

            const taskList = args.tasks
                .map((t) => `  - ${t.taskId} → ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}${t.instruction.length > 80 ? "..." : ""}`)
                .join("\n");

            return {
                content: [{
                    type: "text",
                    text: `Delegated ${args.tasks.length} task(s) successfully:\n${taskList}\n\nUse check_delegation_status to monitor progress.`,
                }],
                details: { taskIds: data.taskIds },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Delegation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── check_relay_health ─────────────────────────────────────────────

const CheckRelayHealthSchema = Type.Object({
    relayId: Type.Optional(Type.String({ description: "Specific relay ID to check. Omit for all relays." })),
});

export const CheckRelayHealthTool: AgentTool<typeof CheckRelayHealthSchema> = {
    name: "check_relay_health",
    description: "Check the health status of Discord relay bots. Returns status (healthy/degraded/offline), last heartbeat, tasks completed/failed, average response time, and capabilities for each relay.",
    parameters: CheckRelayHealthSchema,
    label: "Check Relay Health",
    execute: async (_toolCallId, args) => {
        try {
            const data = await post("/api/relay/health/all", {});
            let relays = data.relays || [];

            if (args.relayId) {
                relays = relays.filter((r: any) => r.relayId === args.relayId);
            }

            if (relays.length === 0) {
                return {
                    content: [{ type: "text", text: "No relay bots found. They may not have sent a heartbeat yet. Ensure the discord-relay process is running." }],
                    details: {},
                };
            }

            const report = relays.map((r: any) => {
                const age = Date.now() - r.lastHeartbeat;
                const ageStr = age < 60000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60000)}m ago`;
                return [
                    `**${r.displayName}** (${r.relayId})`,
                    `  Status: ${r.status}`,
                    `  Harness: ${r.harnessType}`,
                    `  Last heartbeat: ${ageStr}`,
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

// ── check_delegation_status ────────────────────────────────────────

const CheckDelegationStatusSchema = Type.Object({
    jobId: Type.Optional(Type.String({ description: "Job ID to check. Defaults to current job." })),
});

export const CheckDelegationStatusTool: AgentTool<typeof CheckDelegationStatusSchema> = {
    name: "check_delegation_status",
    description: "Check the status of delegated tasks. Shows which tasks are pending, claimed, running, completed, or failed. Use this to monitor delegation progress after calling delegate_to_relay.",
    parameters: CheckDelegationStatusSchema,
    label: "Check Delegation Status",
    execute: async (_toolCallId, args) => {
        const jobId = args.jobId || _currentJobId;
        if (!jobId) {
            return {
                content: [{ type: "text", text: "Error: No job ID provided and no active job." }],
                details: {},
            };
        }

        try {
            const data = await post("/api/relay/tasks/for-job", { jobId });
            const tasks = data.tasks || [];

            if (tasks.length === 0) {
                return {
                    content: [{ type: "text", text: "No delegated tasks found for this job." }],
                    details: {},
                };
            }

            const statusCounts: Record<string, number> = {};
            for (const t of tasks) {
                statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
            }

            const summary = Object.entries(statusCounts)
                .map(([status, count]) => `${status}: ${count}`)
                .join(", ");

            const taskLines = tasks.map((t: any) => {
                let line = `  [${t.status.toUpperCase()}] ${t.taskId} → ${t.targetHarnessType}`;
                if (t.claimedBy) line += ` (claimed by ${t.claimedBy})`;
                if (t.result) line += `\n    Result: ${t.result.substring(0, 200)}${t.result.length > 200 ? "..." : ""}`;
                if (t.error) line += `\n    Error: ${t.error}`;
                return line;
            }).join("\n");

            const allDone = tasks.every((t: any) =>
                ["completed", "failed", "cancelled", "timeout"].includes(t.status),
            );

            return {
                content: [{
                    type: "text",
                    text: `# Delegation Status (${summary})\n\n${taskLines}${allDone ? "\n\nAll tasks have finished. Use aggregate_results to compile the final report." : ""}`,
                }],
                details: { tasks, allDone },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Status check error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};

// ── aggregate_results ──────────────────────────────────────────────

const AggregateResultsSchema = Type.Object({
    jobId: Type.Optional(Type.String({ description: "Job ID to aggregate. Defaults to current job." })),
});

export const AggregateResultsTool: AgentTool<typeof AggregateResultsSchema> = {
    name: "aggregate_results",
    description: "Aggregate and compile results from all completed delegated tasks for a job. Returns a combined report of all task outcomes. Use this after all delegated tasks have finished to synthesize a final response for the user.",
    parameters: AggregateResultsSchema,
    label: "Aggregate Results",
    execute: async (_toolCallId, args) => {
        const jobId = args.jobId || _currentJobId;
        if (!jobId) {
            return {
                content: [{ type: "text", text: "Error: No job ID provided and no active job." }],
                details: {},
            };
        }

        try {
            const data = await post("/api/relay/tasks/for-job", { jobId });
            const tasks = data.tasks || [];

            if (tasks.length === 0) {
                return {
                    content: [{ type: "text", text: "No delegated tasks found for this job." }],
                    details: {},
                };
            }

            const completed = tasks.filter((t: any) => t.status === "completed");
            const failed = tasks.filter((t: any) => t.status === "failed" || t.status === "timeout");
            const pending = tasks.filter((t: any) => !["completed", "failed", "timeout", "cancelled"].includes(t.status));

            let report = `# Aggregated Results\n\n`;
            report += `Tasks: ${completed.length} completed, ${failed.length} failed, ${pending.length} still in progress\n\n`;

            if (completed.length > 0) {
                report += `## Completed Tasks\n\n`;
                for (const t of completed) {
                    report += `### ${t.taskId} (${t.targetHarnessType}${t.claimedBy ? `, executed by ${t.claimedBy}` : ""})\n`;
                    report += t.result || "(no result text)";
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

            if (pending.length > 0) {
                report += `## Still In Progress\n\n`;
                for (const t of pending) {
                    report += `- ${t.taskId}: ${t.status}\n`;
                }
            }

            return {
                content: [{ type: "text", text: report }],
                details: { completed: completed.length, failed: failed.length, pending: pending.length },
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `Aggregation error: ${error.message}` }],
                details: { error: error.message },
            };
        }
    },
};
