/**
 * WaitForDelegation tool — waits for all delegated tasks to complete,
 * sending proactive Discord notifications as each task finishes.
 *
 * Replaces the manual check_delegation_status + aggregate_results loop.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { DelegatedTask } from "@repo/vault-client";
import { getModeConfig } from "../executionModes.js";
import {
    _vault, _currentJobId, _currentExecutionMode,
    _discordBot, _wsServer,
} from "./state.js";

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
        const modeConfig = getModeConfig(_currentExecutionMode);
        const timeoutMs = args.timeoutMinutes
            ? args.timeoutMinutes * 60 * 1000
            : modeConfig.delegationTimeoutMs;
        const pollIntervalMs = 15_000;
        const startTime = Date.now();
        const announcedTerminal = new Set<string>();
        const jobId = _currentJobId;

        console.log(`\n⏳ [wait_for_delegation] Monitoring ${monitoredTaskIds.size} tasks for: "${summary}"`);

        try {
            await _discordBot?.sendProgressMessage(
                `⏳ **${summary}** — Monitoring ${monitoredTaskIds.size} task${monitoredTaskIds.size !== 1 ? "s" : ""}... I'll update you as each one completes.`,
            );
        } catch { /* non-fatal */ }

        while (true) {
            const elapsed = Date.now() - startTime;

            if (elapsed >= timeoutMs) {
                console.log(`\n⏰ [wait_for_delegation] Timeout after ${args.timeoutMinutes ?? 30}m`);
                try {
                    await _discordBot?.sendProgressMessage(
                        `⚠️ **${summary}** — Timed out after ${formatElapsed(elapsed)}. Some tasks may still be running. Use \`get_trace_status\` for details.`,
                    );
                } catch { /* non-fatal */ }
                break;
            }

            let tasks: DelegatedTask[] = [];
            try {
                const allTasks = await _vault.getTasksForJob(jobId);
                tasks = allTasks.filter(t => monitoredTaskIds.has(t.taskId));
            } catch (err: any) {
                console.warn(`[wait_for_delegation] Vault read error: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                continue;
            }

            const newlyTerminal = tasks.filter(
                t => TERMINAL_STATUSES.has(t.status) && !announcedTerminal.has(t.taskId)
            );
            for (const t of newlyTerminal) announcedTerminal.add(t.taskId);

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

        const completedWithResults = completedTasks.map(t => {
            let result = t.result ?? "";
            if (result.startsWith("[Full result:")) {
                result = _vault!.readFullResult(t.taskId) ?? result;
            }
            return { taskId: t.taskId, result: result.substring(0, 2000) };
        });

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
