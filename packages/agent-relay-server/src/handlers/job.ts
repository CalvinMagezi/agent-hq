/**
 * Job handler — manages job submission and status tracking.
 */

import type { ServerWebSocket } from "bun";
import type { ClientData } from "../clientRegistry";
import type { ClientRegistry } from "../clientRegistry";
import type { VaultBridge } from "../bridges/vaultBridge";
import type {
  JobSubmitMessage,
  JobCancelMessage,
} from "@repo/agent-relay-protocol";

export class JobHandler {
  private registry: ClientRegistry;
  private bridge: VaultBridge;
  private debug: boolean;
  /** Track which client is watching which job */
  private jobWatchers = new Map<string, Set<string>>();

  constructor(registry: ClientRegistry, bridge: VaultBridge, debug = false) {
    this.registry = registry;
    this.bridge = bridge;
    this.debug = debug;
  }

  /**
   * Initialize event-driven job status broadcasting.
   */
  start(): void {
    // Listen for job status changes and broadcast to interested clients
    this.bridge.on("job:completed", (data: any) => {
      if (data?.jobId) this.broadcastJobStatus(data.jobId);
    });
    this.bridge.on("job:failed", (data: any) => {
      if (data?.jobId) this.broadcastJobStatus(data.jobId);
    });
    this.bridge.on("job:claimed", (data: any) => {
      if (data?.jobId) this.broadcastJobStatus(data.jobId);
    });
  }

  async handleSubmit(
    ws: ServerWebSocket<ClientData>,
    msg: JobSubmitMessage,
  ): Promise<void> {
    try {
      const jobId = await this.bridge.createJob({
        instruction: msg.instruction,
        type: msg.jobType,
        priority: msg.priority,
        securityProfile: msg.securityProfile,
        modelOverride: msg.modelOverride,
        threadId: msg.threadId,
      });

      if (this.debug) {
        console.log(`[job-handler] Submitted job ${jobId}`);
      }

      // Track this client as watching this job
      if (!this.jobWatchers.has(jobId)) {
        this.jobWatchers.set(jobId, new Set());
      }
      this.jobWatchers.get(jobId)!.add(ws.data.sessionToken);

      ws.send(
        JSON.stringify({
          type: "job:submitted",
          jobId,
          requestId: msg.requestId,
          status: "pending",
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "JOB_SUBMIT_FAILED",
          message: err instanceof Error ? err.message : "Failed to submit job",
          requestId: msg.requestId,
        }),
      );
    }
  }

  async handleCancel(
    ws: ServerWebSocket<ClientData>,
    msg: JobCancelMessage,
  ): Promise<void> {
    // Cancel is a best-effort signal — the agent may or may not honor it
    // We update job status to failed with a cancellation reason
    try {
      await this.bridge.client.updateJobStatus(msg.jobId, "failed" as any, {
        result: "Cancelled by client",
      });

      ws.send(
        JSON.stringify({
          type: "job:complete",
          jobId: msg.jobId,
          status: "failed",
          error: "Cancelled by client",
          completedAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "JOB_CANCEL_FAILED",
          message: err instanceof Error ? err.message : "Failed to cancel job",
        }),
      );
    }
  }

  private async broadcastJobStatus(jobId: string): Promise<void> {
    const watchers = this.jobWatchers.get(jobId);
    if (!watchers?.size) return;

    try {
      const job = await this.bridge.getJob(jobId);
      if (!job) return;

      const isDone = job.status === "done" || job.status === "failed";
      const msgType = isDone ? "job:complete" : "job:status";

      const msg = isDone
        ? {
            type: "job:complete",
            jobId,
            status: job.status,
            result: (job as any).result,
            error: (job as any).error,
            completedAt: new Date().toISOString(),
          }
        : {
            type: "job:status",
            jobId,
            status: job.status,
            streamingText: (job as any).streamingText,
            updatedAt: new Date().toISOString(),
          };

      for (const sessionToken of watchers) {
        this.registry.sendTo(sessionToken, msg);
      }

      // Clean up watchers when job is done
      if (isDone) {
        this.jobWatchers.delete(jobId);
      }
    } catch {
      // Ignore errors during status broadcast
    }
  }
}
