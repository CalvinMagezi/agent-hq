/**
 * Trace handler — orchestration trace queries and task cancellation.
 *
 * Handles:
 *   - trace:status  → Query active/recent traces from TraceDB
 *   - trace:cancel-task → Write cancellation signal files for relay bots
 */

import type { ServerWebSocket } from "bun";
import type { ClientData } from "../clientRegistry";
import type { TraceStatusMessage, TraceCancelTaskMessage } from "@repo/agent-relay-protocol";
import type { VaultBridge } from "../bridges/vaultBridge";
import { TraceDB } from "@repo/vault-client/trace";
import * as fs from "fs";
import * as path from "path";

export class TraceHandler {
  private bridge: VaultBridge;
  private debug: boolean;

  constructor(bridge: VaultBridge, debug = false) {
    this.bridge = bridge;
    this.debug = debug;
  }

  async handleStatus(
    ws: ServerWebSocket<ClientData>,
    msg: TraceStatusMessage,
  ): Promise<void> {
    try {
      const traceDb = new TraceDB(this.bridge.vaultDir);

      let traces: any[] = [];
      if (msg.traceId) {
        const tree = traceDb.getTraceTree(msg.traceId);
        traces = tree ? [tree] : [];
      } else if (msg.jobId) {
        const trace = traceDb.getTraceByJob(msg.jobId);
        if (trace) {
          const tree = traceDb.getTraceTree(trace.traceId);
          traces = tree ? [tree] : [];
        } else {
          traces = [];
        }
      } else {
        // Return all active traces
        const activeTraces = traceDb.getActiveTraces();
        traces = activeTraces.map(t => {
          const tree = traceDb.getTraceTree(t.traceId);
          return tree ?? { ...t, spans: [] };
        });
      }

      traceDb.close();

      const now = Date.now();
      ws.send(
        JSON.stringify({
          type: "trace:status-response",
          traces: traces.map((t) => ({
            traceId: t.traceId,
            jobId: t.jobId,
            instruction: t.rootInstruction,
            status: t.status,
            totalTasks: t.totalTasks,
            completedTasks: t.completedTasks,
            failedTasks: t.failedTasks,
            startedAt: new Date(t.startedAt).toISOString(),
            completedAt: t.completedAt ? new Date(t.completedAt).toISOString() : null,
            spans: ("spans" in t ? t.spans : []).map((s: any) => ({
              spanId: s.spanId,
              taskId: s.taskId,
              type: s.type,
              name: s.name,
              status: s.status,
              claimedBy: s.claimedBy,
              durationMs: s.completedAt
                ? s.completedAt - s.startedAt
                : s.status === "active" ? now - s.startedAt : null,
            })),
          })),
        }),
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "TRACE_STATUS_FAILED",
          message: err instanceof Error ? err.message : "Failed to query traces",
        }),
      );
    }
  }

  async handleCancelTask(
    ws: ServerWebSocket<ClientData>,
    msg: TraceCancelTaskMessage,
  ): Promise<void> {
    const signalsDir = path.join(this.bridge.vaultDir, "_delegation/signals");

    try {
      if (!fs.existsSync(signalsDir)) {
        fs.mkdirSync(signalsDir, { recursive: true });
      }

      for (const taskId of msg.taskIds) {
        try {
          // Write signal file — relay bots poll for this every 2s
          const signalPath = path.join(signalsDir, `cancel-${taskId}.md`);
          fs.writeFileSync(
            signalPath,
            `---\ncancelledAt: ${new Date().toISOString()}\nreason: ${msg.reason ?? "Cancelled by relay client"}\n---\n`,
            "utf-8",
          );

          // Update task status in vault
          await this.bridge.client.updateTaskStatus(taskId, "cancelled", undefined, msg.reason ?? "Cancelled by client");

          // Update TraceDB span
          try {
            const traceDb = new TraceDB(this.bridge.vaultDir);
            const span = traceDb.getSpanByTaskId(taskId);
            if (span) {
              traceDb.addSpanEvent(span.spanId, span.traceId, "cancelled", msg.reason ?? "Cancelled by relay client");
              traceDb.completeSpan(span.spanId, "cancelled");
            }
            traceDb.close();
          } catch {
            // Non-fatal — TraceDB update best-effort
          }

          ws.send(
            JSON.stringify({
              type: "trace:cancel-task-result",
              taskId,
              success: true,
            }),
          );

          if (this.debug) {
            console.log(`[trace-handler] Cancellation signal sent for task ${taskId}`);
          }
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "trace:cancel-task-result",
              taskId,
              success: false,
              error: err instanceof Error ? err.message : "Failed to cancel task",
            }),
          );
        }
      }
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "TASK_CANCEL_FAILED",
          message: err instanceof Error ? err.message : "Failed to send cancellation",
        }),
      );
    }
  }
}
