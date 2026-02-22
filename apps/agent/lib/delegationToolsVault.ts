/**
 * Delegation tools for the HQ Agent orchestrator — Vault-based version.
 *
 * Replaces HTTP-based delegation with direct VaultClient filesystem operations.
 * API surface is identical to delegationTools.ts for drop-in replacement.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { VaultClient } from "@repo/vault-client";

// Module-level config set at init time
let _vault: VaultClient | null = null;
let _currentJobId: string | null = null;
let _currentUserId: string | null = null;

/** Initialize delegation tools with vault path */
export function initDelegationTools(vaultPath: string, _apiKey?: string) {
    _vault = new VaultClient(vaultPath);
}

/** Set the current job context for delegation (called per-job) */
export function setCurrentJob(jobId: string | null, userId: string | null) {
    _currentJobId = jobId;
    _currentUserId = userId;
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
            ], { description: "Which relay bot type to target" }),
            modelOverride: Type.Optional(Type.String({ description: "Optional model override" })),
            dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that must complete first" })),
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
- gemini-cli: Google Workspace (Docs, Sheets, Drive, Gmail, Calendar, Keep), research, analysis, summarization. NOT for coding tasks.
- any: Auto-select the healthiest available relay

ROUTING GUIDELINES:
- Google Docs/Sheets/Drive/Gmail/Calendar/Keep tasks → gemini-cli
- Code editing, debugging, git operations → claude-code
- Multi-model comparison, quick generation → opencode

Tasks can have dependencies (dependsOn) to create execution chains. Always check relay health first with check_relay_health.`,
    parameters: DelegateToRelaySchema,
    label: "Delegate to Relay",
    execute: async (_toolCallId, args) => {
        if (!_currentJobId || !_vault) {
            return {
                content: [{ type: "text", text: "Error: No active job context or vault not initialized." }],
                details: {},
            };
        }

        try {
            await _vault.createDelegatedTasks(
                _currentJobId,
                args.tasks.map((t) => ({
                    taskId: t.taskId,
                    instruction: t.instruction,
                    targetHarnessType: t.targetHarnessType as any,
                    modelOverride: t.modelOverride,
                    dependsOn: t.dependsOn || [],
                    priority: t.priority,
                })),
            );

            const taskList = args.tasks
                .map((t) => `  - ${t.taskId} → ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}${t.instruction.length > 80 ? "..." : ""}`)
                .join("\n");

            return {
                content: [{
                    type: "text",
                    text: `Delegated ${args.tasks.length} task(s) to vault queue:\n${taskList}\n\nUse check_delegation_status to monitor progress.`,
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

// ── check_relay_health ─────────────────────────────────────────────

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

// ── check_delegation_status ────────────────────────────────────────

const CheckDelegationStatusSchema = Type.Object({
    jobId: Type.Optional(Type.String({ description: "Job ID to check. Defaults to current job." })),
});

export const CheckDelegationStatusTool: AgentTool<typeof CheckDelegationStatusSchema> = {
    name: "check_delegation_status",
    description: "Check the status of delegated tasks.",
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

            const taskLines = tasks.map((t) => {
                let line = `  [${t.status.toUpperCase()}] ${t.taskId} → ${t.targetHarnessType}`;
                if (t.claimedBy) line += ` (claimed by ${t.claimedBy})`;
                if (t.result) line += `\n    Result: ${t.result.substring(0, 200)}${t.result.length > 200 ? "..." : ""}`;
                if (t.error) line += `\n    Error: ${t.error}`;
                return line;
            }).join("\n");

            const allDone = tasks.every((t) =>
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
    description: "Aggregate and compile results from all completed delegated tasks for a job.",
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
            const pending = tasks.filter((t) => !["completed", "failed", "timeout", "cancelled"].includes(t.status));

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
