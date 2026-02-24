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
import { TraceDB } from "@repo/vault-client/trace";
import * as fs from "fs";
import * as path from "path";

// Module-level config set at init time
let _vault: VaultClient | null = null;
let _vaultPath: string = "";
let _currentJobId: string | null = null;
let _currentUserId: string | null = null;
let _traceDb: TraceDB | null = null;
let _currentTraceId: string | null = null;
let _currentJobSpanId: string | null = null;

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

ROUTING GUIDELINES:
- Google Docs/Sheets/Drive/Gmail/Calendar/Keep tasks → gemini-cli
- Code editing, debugging, git operations → claude-code
- Multi-model comparison, quick generation → opencode

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

        try {
            // Create spans for each task and attach trace context
            const tasksWithTrace = args.tasks.map((t) => {
                let spanId: string | undefined;
                if (_traceDb && _currentTraceId) {
                    spanId = _traceDb.createSpan({
                        traceId: _currentTraceId,
                        parentSpanId: _currentJobSpanId ?? undefined,
                        taskId: t.taskId,
                        type: "delegation",
                        name: `${t.targetHarnessType}: ${t.taskId}`,
                    });
                    _traceDb.addSpanEvent(spanId, _currentTraceId, "started",
                        `Delegated to ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}`);
                    _traceDb.updateTraceCounts(_currentTraceId, { total: 1 });
                }
                return {
                    taskId: t.taskId,
                    instruction: t.instruction,
                    targetHarnessType: t.targetHarnessType as any,
                    modelOverride: t.modelOverride,
                    dependsOn: t.dependsOn || [],
                    priority: t.priority,
                    traceId: _currentTraceId ?? undefined,
                    spanId,
                    parentSpanId: _currentJobSpanId ?? undefined,
                    securityConstraints: t.securityConstraints as any,
                };
            });

            await _vault.createDelegatedTasks(_currentJobId, tasksWithTrace);

            const taskList = args.tasks
                .map((t) => `  - ${t.taskId} → ${t.targetHarnessType}: ${t.instruction.substring(0, 80)}${t.instruction.length > 80 ? "..." : ""}`)
                .join("\n");

            const traceInfo = _currentTraceId
                ? `\nTrace ID: ${_currentTraceId} (use get_trace_status for real-time progress)`
                : "";

            return {
                content: [{
                    type: "text",
                    text: `Delegated ${args.tasks.length} task(s) to vault queue:\n${taskList}\n${traceInfo}\nUse check_delegation_status to monitor progress.`,
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
