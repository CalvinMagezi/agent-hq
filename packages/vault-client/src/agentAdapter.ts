/**
 * AgentAdapter — Drop-in replacement for ConvexClient in the HQ agent.
 *
 * Wraps VaultClient to provide a compatible API surface with
 * the existing agent code's `client.query()` and `client.mutation()` patterns.
 * This minimizes changes to apps/agent/index.ts during migration.
 */

import { VaultClient } from "./index";
import type { Job, JobStatus, ConversationMessage, JobStats } from "./types";
import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

export class AgentAdapter {
  private vault: VaultClient;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    this.vault = new VaultClient(vaultPath);
  }

  get client(): VaultClient {
    return this.vault;
  }

  // ─── Job Queue (replaces api.agent.*) ──────────────────────────────

  async getPendingJob(args: {
    workerId: string;
    workerSecret: string;
  }): Promise<any | null> {
    const job = await this.vault.getPendingJob(args.workerId);
    if (!job) return null;

    // Return in Convex-compatible shape
    return {
      _id: job.jobId,
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      instruction: job.instruction,
      priority: job.priority,
      securityProfile: job.securityProfile,
      modelOverride: job.modelOverride,
      thinkingLevel: job.thinkingLevel,
      threadId: job.threadId,
      conversationHistory: job.conversationHistory ?? [],
      steeringMessage: job.steeringMessage,
      orchestrationType: "single",
      taskPlan: null,
      _creationTime: new Date(job.createdAt).getTime(),
    };
  }

  async getJob(args: { jobId: string }): Promise<any | null> {
    // Search all status directories for the job
    for (const dir of ["pending", "running", "done", "failed"]) {
      const files = fs
        .readdirSync(path.join(this.vaultPath, `_jobs/${dir}`))
        .filter((f) => f.endsWith(".md"));

      for (const file of files) {
        try {
          const filePath = path.join(this.vaultPath, `_jobs/${dir}`, file);
          const raw = fs.readFileSync(filePath, "utf-8");
          const { data, content } = matter(raw);
          if (data.jobId === args.jobId) {
            const instrMatch = content.match(
              /^#\s+Instruction\s*\n([\s\S]*?)(?=\n##|$)/m,
            );
            return {
              _id: data.jobId,
              ...data,
              instruction: instrMatch?.[1]?.trim() ?? content,
            };
          }
        } catch {
          // Skip
        }
      }
    }
    return null;
  }

  async updateJobStatus(args: {
    jobId: string;
    status: JobStatus;
    apiKey?: string;
    result?: string;
    streamingText?: string;
    stats?: JobStats;
    conversationHistory?: ConversationMessage[];
  }): Promise<void> {
    await this.vault.updateJobStatus(args.jobId, args.status, {
      result: args.result,
      streamingText: args.streamingText,
      stats: args.stats,
      conversationHistory: args.conversationHistory,
    });
  }

  async updateJobStreamingText(args: {
    jobId: string;
    streamingText: string;
    apiKey?: string;
  }): Promise<void> {
    await this.vault.updateJobStatus(args.jobId, "running" as JobStatus, {
      streamingText: args.streamingText,
    });
  }

  async commitStreamingText(args: {
    jobId: string;
    apiKey?: string;
  }): Promise<void> {
    // No-op for file-based system — streaming text is already written
  }

  async addJobLog(args: {
    jobId: string;
    type: string;
    content: string;
    apiKey?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await this.vault.addJobLog(args.jobId, args.type, args.content, args.metadata);
  }

  async workerHeartbeat(args: {
    workerId: string;
    status: string;
    apiKey?: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await this.vault.workerHeartbeat(args.workerId, {
      status: args.status as "online" | "offline" | "busy",
    });
  }

  async syncSkills(args: {
    workerId: string;
    skills: Array<{ name: string; description?: string }>;
    apiKey?: string;
  }): Promise<void> {
    // Write skills list to a worker file
    const filePath = path.join(
      this.vaultPath,
      "_agent-sessions",
      `skills-${args.workerId}.md`,
    );
    const content = args.skills
      .map((s) => `- **${s.name}**: ${s.description ?? "No description"}`)
      .join("\n");
    const frontmatter = {
      workerId: args.workerId,
      skillCount: args.skills.length,
      updatedAt: new Date().toISOString(),
    };
    const matterStr = matter.stringify("\n# Skills\n\n" + content + "\n", frontmatter);
    fs.writeFileSync(filePath, matterStr, "utf-8");
  }

  async clearSteeringMessage(args: {
    jobId: string;
    apiKey?: string;
  }): Promise<void> {
    // Update the job file to clear steering message
    const job = await this.getJob({ jobId: args.jobId });
    if (job?._filePath) {
      const filePath = job._filePath;
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      delete parsed.data.steeringMessage;
      fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
    }
  }

  async updateTaskPlan(args: {
    jobId: string;
    taskPlan: any;
    apiKey?: string;
  }): Promise<void> {
    // Store task plan in job frontmatter
    for (const dir of ["running"]) {
      const files = fs
        .readdirSync(path.join(this.vaultPath, `_jobs/${dir}`))
        .filter((f) => f.endsWith(".md"));

      for (const file of files) {
        try {
          const filePath = path.join(this.vaultPath, `_jobs/${dir}`, file);
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = matter(raw);
          if (parsed.data.jobId === args.jobId) {
            parsed.data.taskPlan = args.taskPlan;
            fs.writeFileSync(filePath, matter.stringify(parsed.content, parsed.data), "utf-8");
            return;
          }
        } catch {
          // Skip
        }
      }
    }
  }

  async createFollowUpJob(args: {
    instruction: string;
    parentJobId: string;
    apiKey?: string;
  }): Promise<string> {
    return await this.vault.createJob({
      instruction: `[Follow-up from ${args.parentJobId}] ${args.instruction}`,
      type: "background",
      priority: 60,
    });
  }

  async updateTerminalStatus(args: {
    sessionId: string;
    status: string;
    exitCode?: number;
    apiKey?: string;
  }): Promise<void> {
    // Terminal sessions are local-only, write a status file
    const filePath = path.join(
      this.vaultPath,
      "_agent-sessions",
      `terminal-${args.sessionId}.md`,
    );
    const frontmatter = {
      sessionId: args.sessionId,
      status: args.status,
      exitCode: args.exitCode ?? null,
      updatedAt: new Date().toISOString(),
    };
    const matterStr = matter.stringify("\n# Terminal Session\n", frontmatter);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, matterStr, "utf-8");
  }

  // ─── System Functions (replaces api.functions.system.*) ────────────

  async getAgentContext(): Promise<Array<{ title: string; content: string }>> {
    const ctx = await this.vault.getAgentContext();
    const notes: Array<{ title: string; content: string }> = [];

    if (ctx.soul) notes.push({ title: "SOUL", content: ctx.soul });
    if (ctx.memory) notes.push({ title: "Memory", content: ctx.memory });
    if (ctx.heartbeat) notes.push({ title: "Heartbeat", content: ctx.heartbeat });
    if (ctx.preferences) notes.push({ title: "Preferences", content: ctx.preferences });

    for (const note of ctx.pinnedNotes) {
      notes.push({ title: note.title, content: note.content });
    }

    return notes;
  }

  async ensureSystemIdentity(): Promise<void> {
    // System files are already created during vault setup — no-op
  }

  async updateSystemNote(args: {
    title: string;
    content: string;
  }): Promise<void> {
    const filename = args.title.toUpperCase().replace(/\s+/g, "-");
    const filePath = path.join(this.vaultPath, "_system", `${filename}.md`);

    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      fs.writeFileSync(
        filePath,
        matter.stringify("\n" + args.content + "\n", parsed.data),
        "utf-8",
      );
    } else {
      const matterStr = matter.stringify(
        "\n" + args.content + "\n",
        { noteType: "system-file", fileName: args.title.toLowerCase(), version: 1 },
      );
      fs.writeFileSync(filePath, matterStr, "utf-8");
    }
  }

  async appendToSystemNote(args: {
    title: string;
    content: string;
  }): Promise<void> {
    const filename = args.title.toUpperCase().replace(/\s+/g, "-");
    const filePath = path.join(this.vaultPath, "_system", `${filename}.md`);

    if (args.title === "Memory" && fs.existsSync(filePath)) {
      let raw = fs.readFileSync(filePath, "utf-8");
      // Cap the auto-memory work log to 20 entries
      const rawLines = raw.split("\n");
      const workLogIndices = rawLines.map((line, idx) => line.startsWith("- [") && line.includes("] Task:") ? idx : -1).filter(idx => idx !== -1);

      if (workLogIndices.length >= 20) {
        // Remove the oldest task log line
        rawLines.splice(workLogIndices[0], 1);
        raw = rawLines.join("\n");
        fs.writeFileSync(filePath, raw, "utf-8");
      }
    }

    if (fs.existsSync(filePath)) {
      fs.appendFileSync(filePath, "\n" + args.content, "utf-8");
    } else {
      await this.updateSystemNote(args);
    }
  }

  // ─── Sync Engine Integration ──────────────────────────────────────

  private syncClient: any = null;

  /**
   * Initialize the sync engine for event-driven job detection.
   * Call this before onUpdate() for faster job pickup.
   */
  async initSync(): Promise<void> {
    try {
      const { SyncedVaultClient } = await import("@repo/vault-sync");
      const syncedVault = new SyncedVaultClient(this.vaultPath);
      await syncedVault.startSync();
      this.syncClient = syncedVault;
      this.vault = syncedVault; // Upgrade vault to synced version
      console.log("[agent-adapter] Vault sync engine initialized");
    } catch (err) {
      console.warn("[agent-adapter] Sync engine not available, using polling:", err);
    }
  }

  /**
   * Stop the sync engine on shutdown.
   */
  async stopSync(): Promise<void> {
    if (this.syncClient?.stopSync) {
      await this.syncClient.stopSync();
    }
  }

  // ─── Convex Subscription Compatibility ─────────────────────────────

  /**
   * Event-driven job detection with polling fallback.
   *
   * If sync engine is initialized (via initSync), fires callback immediately
   * when a job file appears in _jobs/pending/ via fs events. Falls back to
   * 30s polling as a safety net.
   *
   * Without sync engine, polls every 5 seconds (legacy behavior).
   */
  onUpdate(
    _queryRef: any,
    _args: any,
    callback: (result: any) => void,
  ): () => void {
    const cleanups: (() => void)[] = [];

    // Guard against concurrent invocations from rapid event bursts
    let delivering = false;
    const deliverJob = async () => {
      if (delivering) return;
      delivering = true;
      try {
        const job = await this.vault.getPendingJob("any");
        if (job) {
          callback({
            _id: job.jobId,
            jobId: job.jobId,
            type: job.type,
            status: job.status,
            instruction: job.instruction,
            priority: job.priority,
            securityProfile: job.securityProfile,
            modelOverride: job.modelOverride,
            thinkingLevel: job.thinkingLevel,
            _creationTime: new Date(job.createdAt).getTime(),
          });
        }
      } catch {
        // Ignore
      } finally {
        delivering = false;
      }
    };

    // If sync engine is available, subscribe to job:created events
    if (this.syncClient?.on) {
      const unsub = this.syncClient.on("job:created", () => deliverJob());
      cleanups.push(unsub);

      // Safety-net polling at 30s (down from 5s)
      const interval = setInterval(deliverJob, 30_000);
      cleanups.push(() => clearInterval(interval));
    } else {
      // Legacy polling at 5s
      const interval = setInterval(deliverJob, 5000);
      cleanups.push(() => clearInterval(interval));
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }
}
