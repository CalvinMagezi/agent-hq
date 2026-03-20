/**
 * VaultClient — Job Queue methods.
 *
 * Backed by AtomicQueue (pure filesystem, no external binary).
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { VaultClient } from "./core";
import type {
  Job,
  JobStatus,
  JobType,
  SecurityProfile,
  ThinkingLevel,
  JobStats,
  ConversationMessage,
} from "./types";

declare module "./core" {
  interface VaultClient {
    getPendingJob(workerId: string): Promise<Job | null>;
    claimJob(jobId: string, workerId: string): Promise<boolean>;
    updateJobStatus(
      jobId: string,
      status: JobStatus,
      data?: Partial<{
        result: string;
        streamingText: string;
        stats: JobStats;
        steeringMessage: string;
        conversationHistory: ConversationMessage[];
      }>,
    ): Promise<void>;
    getJob(jobId: string): Promise<Job | null>;
    addJobLog(
      jobId: string,
      type: string,
      content: string,
      metadata?: Record<string, any>,
    ): Promise<void>;
    createJob(options: {
      instruction: string;
      type?: JobType;
      priority?: number;
      securityProfile?: SecurityProfile;
      modelOverride?: string | null;
      thinkingLevel?: ThinkingLevel | null;
      threadId?: string | null;
    }): Promise<string>;
    workerHeartbeat(
      workerId: string,
      metadata?: {
        status?: "online" | "offline" | "busy";
        currentJobId?: string | null;
        modelConfig?: { provider: string; model: string };
      },
    ): Promise<void>;
  }
}

VaultClient.prototype.getPendingJob = async function (workerId) {
  const item = this.jobQueue.dequeue("pending", "running");
  if (!item) return null;

  try {
    const { data, content } = this.readMdFile(item.path);
    const job = this.parseJob(item.path, data, content);
    this.claimedJobs.set(job.jobId, item.path);
    return job;
  } catch {
    // If we can't read the file, move it to failed
    this.jobQueue.transition(item.name, "running", "failed");
    return null;
  }
};

VaultClient.prototype.claimJob = async function (jobId, workerId) {
  const claimedPath = this.claimedJobs.get(jobId);
  if (!claimedPath) return false;

  try {
    this.updateFrontmatter(claimedPath, {
      status: "running",
      workerId,
      updatedAt: this.nowISO(),
    });
    return true;
  } catch {
    return false;
  }
};

VaultClient.prototype.updateJobStatus = async function (jobId, status, data) {
  const claimedPath = this.claimedJobs.get(jobId);
  if (!claimedPath) {
    throw new Error(`Job not found or not claimed by this process: ${jobId}`);
  }

  const updates: Record<string, any> = {
    status,
    updatedAt: this.nowISO(),
  };
  if (data?.result) updates.result = data.result;
  if (data?.stats) updates.stats = data.stats;
  if (data?.steeringMessage) updates.steeringMessage = data.steeringMessage;
  if (data?.streamingText) updates.streamingText = data.streamingText;
  if (data?.conversationHistory && data.conversationHistory.length > 0) {
    updates.conversationHistory = data.conversationHistory;
  }

  this.updateFrontmatter(claimedPath, updates);

  if (status === "done" || status === "failed" || status === "cancelled") {
    const filename = path.basename(claimedPath);
    const targetStage = status === "done" ? "done" : "failed";
    this.jobQueue.transition(filename, "running", targetStage);
    this.claimedJobs.delete(jobId);
  }
};

VaultClient.prototype.getJob = async function (jobId) {
  for (const stage of ["running", "done", "failed"]) {
    const items = this.jobQueue.list(stage);
    for (const item of items) {
      try {
        const { data, content } = this.readMdFile(item.path);
        if (data.jobId === jobId) {
          return this.parseJob(item.path, data, content);
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return null;
};

VaultClient.prototype.addJobLog = async function (jobId, type, content, metadata) {
  const today = new Date().toISOString().split("T")[0];
  const logDir = this.resolve("_logs", today);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, `job-${jobId}.md`);
  const timestamp = this.nowISO();
  const metaStr = metadata ? `\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`` : "";
  const entry = `\n## ${type} (${timestamp})${metaStr}\n${content}\n`;

  if (!fs.existsSync(logFile)) {
    const header = `---\njobId: "${jobId}"\ndate: "${today}"\n---\n# Job Log: ${jobId}\n`;
    fs.writeFileSync(logFile, header + entry, "utf-8");
  } else {
    fs.appendFileSync(logFile, entry, "utf-8");
  }
};

VaultClient.prototype.createJob = async function (options) {
  const jobId = `job-${this.generateId()}`;
  const filename = `${jobId}.md`;
  const content = `# Instruction\n\n${options.instruction}`;

  this.writeMdFile(
    path.join(this.vaultPath, "_jobs", "pending", filename),
    {
      jobId,
      type: options.type ?? "background",
      status: "pending",
      priority: options.priority ?? 50,
      securityProfile: options.securityProfile ?? "standard",
      modelOverride: options.modelOverride ?? null,
      thinkingLevel: options.thinkingLevel ?? null,
      workerId: null,
      threadId: options.threadId ?? null,
      createdAt: this.nowISO(),
    },
    content,
    { isCreate: true },
  );

  return jobId;
};

VaultClient.prototype.workerHeartbeat = async function (workerId, metadata) {
  const filePath = this.resolve("_agent-sessions", `worker-${workerId}.md`);

  if (!fs.existsSync(filePath)) {
    this.writeMdFile(
      filePath,
      {
        workerId,
        userId: "local-user",
        status: metadata?.status ?? "online",
        lastHeartbeat: this.nowISO(),
        currentJobId: metadata?.currentJobId ?? null,
        modelConfig: metadata?.modelConfig ?? null,
      },
      `# Worker: ${workerId}`,
    );
  } else {
    this.updateFrontmatter(filePath, {
      lastHeartbeat: this.nowISO(),
      ...(metadata?.status && { status: metadata.status }),
      ...(metadata?.currentJobId !== undefined && {
        currentJobId: metadata.currentJobId,
      }),
      ...(metadata?.modelConfig && { modelConfig: metadata.modelConfig }),
    });
  }
};
