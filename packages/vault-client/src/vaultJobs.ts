/**
 * VaultClient — Job Queue methods.
 */

import * as fs from "fs";
import * as path from "path";
import { FbmqCli, jobCodec } from "@repo/queue-transport";
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
  const job = await this.jobQueue.dequeue();
  if (job) {
    this.claimedJobs.set(job.jobId, job._filePath);
  }
  return job;
};

VaultClient.prototype.claimJob = async function (jobId, workerId) {
  const claimedPath = this.claimedJobs.get(jobId);
  if (!claimedPath) return false;

  try {
    const headers = await this.jobQueue["cli"].inspect(claimedPath);
    const rawBody = await this.jobQueue["cli"].cat(claimedPath);
    const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
    headers.custom = { ...headers.custom, ...custom };
    const job = jobCodec.deserialize(claimedPath, cleanBody, headers);

    job.status = "running";
    job.workerId = workerId;
    job.updatedAt = this.nowISO();

    this.writeRFC822(claimedPath, job, jobCodec);
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

  const headers = await this.jobQueue["cli"].inspect(claimedPath);
  const rawBodyStr = await this.jobQueue["cli"].cat(claimedPath);
  const { custom: jobCustom, cleanBody: jobCleanBody } = FbmqCli.parseBodyCustom(rawBodyStr);
  headers.custom = { ...jobCustom, ...headers.custom };
  const job = jobCodec.deserialize(claimedPath, jobCleanBody, headers);
  if (job.jobId === "unknown" || !job.jobId) job.jobId = jobId;

  job.status = status;
  job.updatedAt = this.nowISO();

  if (data?.result) job.result = data.result;
  if (data?.stats) job.stats = data.stats;
  if (data?.steeringMessage) job.steeringMessage = data.steeringMessage;
  if (data?.streamingText) job.streamingText = data.streamingText;
  if (data?.conversationHistory && data.conversationHistory.length > 0) {
    job.conversationHistory = data.conversationHistory;
  }

  this.writeRFC822(claimedPath, job, jobCodec);

  if (status === "done" || status === "failed" || status === "cancelled") {
    await this.jobQueue.complete(claimedPath);
    this.claimedJobs.delete(jobId);
  }
};

VaultClient.prototype.getJob = async function (jobId) {
  const queueRoot = this.resolve("_fbmq", "jobs");
  const searchDirs = ["processing", "done", "failed"];
  for (const dir of searchDirs) {
    const dirPath = path.join(queueRoot, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file);
      try {
        const headers = await this.jobQueue["cli"].inspect(filePath);
        if (headers.custom?.jobId === jobId) {
          const rawBody = await this.jobQueue["cli"].cat(filePath);
          const { custom, cleanBody } = FbmqCli.parseBodyCustom(rawBody);
          headers.custom = { ...custom, ...headers.custom };
          const job = jobCodec.deserialize(filePath, cleanBody, headers);
          if (job.jobId === "unknown" || !job.jobId) job.jobId = jobId;
          return job;
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
  const job: Job = {
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
    instruction: options.instruction,
    _filePath: "",
  };

  await this.jobQueue.enqueue(job);
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
