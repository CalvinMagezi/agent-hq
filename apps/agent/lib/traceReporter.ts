/**
 * TraceReporter — Watches active orchestration traces and pushes progress
 * through three channels:
 *
 *   1. Agent WebSocket (port 5678) → AgentBridge → relay clients (real-time)
 *   2. _system/ORCHESTRATION-STATUS.md → Obsidian dashboard
 *   3. _logs/YYYY-MM-DD/ → Persistent job log entry
 *
 * Progress is throttled to at most once per 5 seconds, and only emitted
 * when status actually changes (to avoid noisy writes).
 */

import { TraceDB } from "@repo/vault-client/trace";
import type { AgentWsServer } from "./wsServer.js";
import type { AgentAdapter } from "@repo/vault-client/agent-adapter";
import * as fs from "fs";
import * as path from "path";

export interface TraceReporterOpts {
    vaultPath: string;
    adapter: AgentAdapter;
    wsServer?: AgentWsServer;
}

export class TraceReporter {
    private interval: ReturnType<typeof setInterval> | null = null;

    /**
     * Start watching a trace and emit progress updates every 5 seconds.
     * Returns a cleanup function to stop watching.
     */
    watchTrace(traceId: string, jobId: string, opts: TraceReporterOpts): () => void {
        let lastStatus = "";

        const traceDb = new TraceDB(opts.vaultPath);

        this.interval = setInterval(async () => {
            try {
                const trace = traceDb.getTrace(traceId);
                if (!trace) return;

                const status = `${trace.completedTasks}/${trace.totalTasks} complete, ${trace.failedTasks} failed`;
                if (status === lastStatus) return;
                lastStatus = status;

                // 1. Log entry (viewable in Obsidian at _logs/)
                try {
                    await opts.adapter.addJobLog({
                        jobId,
                        type: "progress",
                        content: `Orchestration: ${status}`,
                        metadata: {
                            traceId,
                            completedTasks: trace.completedTasks,
                            totalTasks: trace.totalTasks,
                            failedTasks: trace.failedTasks,
                        },
                    });
                } catch {
                    // Non-fatal
                }

                // Get latest span event for context
                const spans = traceDb.getSpansForTrace(traceId);
                let latestEvent: { spanId: string; taskId: string | null; eventType: string; message: string | null } | undefined;
                for (const span of spans) {
                    const events = traceDb.getSpanEvents(span.spanId);
                    const last = events[events.length - 1];
                    if (last) {
                        latestEvent = {
                            spanId: span.spanId,
                            taskId: span.taskId,
                            eventType: last.eventType,
                            message: last.message,
                        };
                    }
                }

                // 2. Agent WS broadcast → AgentBridge picks up → relay server pushes to clients
                opts.wsServer?.broadcast({
                    type: "event",
                    event: "trace.progress",
                    payload: {
                        traceId,
                        jobId,
                        completedTasks: trace.completedTasks,
                        totalTasks: trace.totalTasks,
                        failedTasks: trace.failedTasks,
                        summary: status,
                        latestEvent,
                        timestamp: new Date().toISOString(),
                    },
                });

                // 3. Write ORCHESTRATION-STATUS.md (Obsidian readable)
                this.writeStatusFile(opts.vaultPath, traceDb);

            } catch {
                // Non-fatal — trace reporter is best-effort
            }
        }, 5_000);

        return () => {
            if (this.interval) {
                clearInterval(this.interval);
                this.interval = null;
            }
            // Write final status on stop
            try {
                this.writeStatusFile(opts.vaultPath, traceDb);
            } catch { /* ignore */ }
            traceDb.close();
        };
    }

    /** Write the ORCHESTRATION-STATUS.md dashboard file. */
    private writeStatusFile(vaultPath: string, traceDb: TraceDB): void {
        const systemDir = path.join(vaultPath, "_system");
        if (!fs.existsSync(systemDir)) return;

        const activeTraces = traceDb.getActiveTraces();
        const recentTraces = traceDb.getRecentTraces(5);
        const completedRecent = recentTraces.filter(t => t.status !== "active");

        let content = `---\nnoteType: system-file\nlastUpdated: ${new Date().toISOString()}\nactiveTraces: ${activeTraces.length}\n---\n# Orchestration Status\n\n`;

        if (activeTraces.length === 0) {
            content += "_No active orchestrations._\n\n";
        } else {
            for (const trace of activeTraces) {
                const elapsed = Date.now() - trace.startedAt;
                const elapsedStr = elapsed < 60000
                    ? `${Math.round(elapsed / 1000)}s`
                    : `${Math.round(elapsed / 60000)}m${Math.round((elapsed % 60000) / 1000)}s`;

                const pct = trace.totalTasks > 0
                    ? Math.round((trace.completedTasks / trace.totalTasks) * 100)
                    : 0;

                const instruction = trace.rootInstruction ?? trace.jobId;

                content += `## Active: ${trace.traceId.substring(0, 20)}...\n`;
                content += `**Job**: ${instruction}\n`;
                content += `**Progress**: ${trace.completedTasks}/${trace.totalTasks} tasks (${pct}%)`;
                if (trace.failedTasks > 0) content += ` | ${trace.failedTasks} failed`;
                content += ` | Started: ${new Date(trace.startedAt).toLocaleTimeString()} | Elapsed: ${elapsedStr}\n\n`;

                const spans = traceDb.getSpansForTrace(trace.traceId);
                const delegationSpans = spans.filter(s => s.type === "delegation" || s.type === "relay_exec");

                if (delegationSpans.length > 0) {
                    content += `| Task | Target/Type | Status | Relay | Time |\n`;
                    content += `|------|-------------|--------|-------|------|\n`;

                    for (const span of delegationSpans) {
                        if (span.type !== "delegation") continue;
                        const spanElapsed = span.completedAt
                            ? Math.round((span.completedAt - span.startedAt) / 1000)
                            : Math.round((Date.now() - span.startedAt) / 1000);
                        const dur = spanElapsed < 60 ? `${spanElapsed}s` : `${Math.round(spanElapsed / 60)}m${spanElapsed % 60}s`;
                        const relay = span.claimedBy ?? "—";
                        const status = span.status === "active" && spanElapsed > 30 ? `running (${dur}...)` : span.status;
                        content += `| ${span.taskId ?? span.name} | ${span.name.split(":")[0]} | ${status} | ${relay} | ${dur} |\n`;
                    }
                    content += "\n";
                }
            }
        }

        if (completedRecent.length > 0) {
            content += `## Recent (last ${completedRecent.length})\n`;
            for (const t of completedRecent) {
                const elapsed = t.completedAt ? t.completedAt - t.startedAt : 0;
                const dur = elapsed < 60000 ? `${Math.round(elapsed / 1000)}s` : `${Math.round(elapsed / 60000)}m`;
                const time = new Date(t.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const instruction = (t.rootInstruction ?? t.jobId).substring(0, 60);
                content += `- ${time} — "${instruction}" — ${t.status} in ${dur} (${t.completedTasks} tasks)\n`;
            }
        }

        const statusPath = path.join(systemDir, "ORCHESTRATION-STATUS.md");
        fs.writeFileSync(statusPath, content, "utf-8");
    }
}
