/**
 * VaultClient — Local filesystem replacement for Convex backend.
 *
 * Reads/writes markdown files with YAML frontmatter in the Obsidian vault.
 * Job claiming uses atomic fs.renameSync for concurrency safety.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { JobQueue, DelegationQueue, FbmqCli, jobCodec, delegationCodec } from "@repo/queue-transport";
import { calculateCost } from "./pricing";
import type {
  Job,
  JobStatus,
  JobType,
  SecurityProfile,
  ThinkingLevel,
  Note,
  NoteType,
  EmbeddingStatus,
  DelegatedTask,
  HarnessType,
  TaskStatus,
  RelayHealth,
  SystemContext,
  UsageEntry,
  WorkerSession,
  ConversationMessage,
  JobStats,
  SearchResult,
  RecentActivityEntry,
} from "./types";

export type { Job, Note, DelegatedTask, RelayHealth, SystemContext, SearchResult, RecentActivityEntry };
export { calculateCost } from "./pricing";

// Re-export types
export * from "./types";

export class VaultClient {
  readonly vaultPath: string;
  readonly jobQueue: JobQueue;
  readonly delegationQueue: DelegationQueue;

  // Track claimed paths for ack/nack
  private claimedJobs = new Map<string, string>();
  private claimedTasks = new Map<string, string>();

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault not found at: ${this.vaultPath}`);
    }

    this.jobQueue = new JobQueue({ queueRoot: this.resolve("_fbmq/jobs") });
    this.delegationQueue = new DelegationQueue(
      { queueRoot: this.resolve("_fbmq/delegation") },
      this.resolve("_fbmq/staged")
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private resolve(...parts: string[]): string {
    return path.join(this.vaultPath, ...parts);
  }

  private readMdFile(filePath: string): { data: Record<string, any>; content: string } {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    return { data, content: content.trim() };
  }

  private writeMdFile(
    filePath: string,
    frontmatter: Record<string, any>,
    content: string,
    metadata?: Partial<{ modifiedBy: string, isCreate: boolean }>
  ): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Inject optimistic concurrency / tracking fields
    if (frontmatter.version === undefined) {
      frontmatter.version = 1;
    } else if (typeof frontmatter.version === "number" && !metadata?.isCreate) {
      frontmatter.version += 1;
    }

    if (metadata?.modifiedBy) {
      frontmatter.lastModifiedBy = metadata.modifiedBy;
    }

    const output = matter.stringify("\n" + content + "\n", frontmatter);
    fs.writeFileSync(filePath, output, "utf-8");
  }

  private updateFrontmatter(
    filePath: string,
    updates: Record<string, any>,
    metadata?: Partial<{ modifiedBy: string }>
  ): void {
    const { data, content } = this.readMdFile(filePath);
    Object.assign(data, updates);
    this.writeMdFile(filePath, data, content, metadata);
  }

  private listMdFiles(dirPath: string): string[] {
    const full = this.resolve(dirPath);
    if (!fs.existsSync(full)) return [];
    return fs
      .readdirSync(full)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(full, f));
  }

  private generateId(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `${ts}-${rand}`;
  }

  private nowISO(): string {
    return new Date().toISOString();
  }

  // ─── Locking ───────────────────────────────────────────────────────

  /**
   * Acquire a lock for a specific file path.
   * If the lock exists and is younger than maxAgeMs, throws an error.
   */
  async acquireLock(filepath: string, maxAgeMs: number = 30000): Promise<string> {
    const lockDir = this.resolve("_locks");
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Hash the absolute path so we can lock files outside the vault if needed,
    // but typically it's relative. We'll base64 encode the path to be safe.
    const safeName = Buffer.from(filepath).toString("base64").replace(/[/+=]/g, "-");
    const lockPath = path.join(lockDir, `${safeName}.lock`);
    const lockToken = this.generateId();

    try {
      // Try to read existing lock
      if (fs.existsSync(lockPath)) {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age < maxAgeMs) {
          throw new Error(`File is locked: ${filepath}`);
        }
        // Lock is stale, we can overwrite it
      }

      // Write lock token atomically (wx flag fails if file exists, 
      // but we just checked for stale locks, so we unlink first if stale)
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      fs.writeFileSync(lockPath, lockToken, { flag: "wx" });
      return lockToken;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        throw new Error(`File is locked: ${filepath}`);
      }
      throw err;
    }
  }

  /**
   * Release a lock using the token returned by acquireLock.
   */
  async releaseLock(filepath: string, token: string): Promise<void> {
    const safeName = Buffer.from(filepath).toString("base64").replace(/[/+=]/g, "-");
    const lockPath = this.resolve("_locks", `${safeName}.lock`);

    try {
      if (fs.existsSync(lockPath)) {
        const existingToken = fs.readFileSync(lockPath, "utf-8");
        if (existingToken === token) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // Helper to write RFC822 inline (since fbmq CLI push creates new files, we modify processing files directly)
  private writeRFC822(filePath: string, item: any, codec: any) {
    const { body, priority, tags, correlationId, custom, ttl } = codec.serialize(item);
    let rfc822 = `Priority: ${priority}\n`;
    if (tags) rfc822 += `Tags: ${tags}\n`;
    if (correlationId) rfc822 += `Correlation-Id: ${correlationId}\n`;
    if (ttl) rfc822 += `TTL: ${ttl}\n`;
    if (custom && Object.keys(custom).length > 0) {
      rfc822 += `Custom:\n`;
      for (const [k, v] of Object.entries(custom)) {
        rfc822 += `  ${k}: ${v}\n`;
      }
    }
    rfc822 += `\n${body}`;
    fs.writeFileSync(filePath, rfc822, "utf-8");
  }

  // Helper to parse RFC822 inline or from fbmqCli
  // For simplicity, if we have the Item already, we just modify it and serialize.

  // ─── Job Queue ─────────────────────────────────────────────────────

  /**
   * Get the highest-priority pending job.
   * Returns null if no jobs are pending.
   */
  async getPendingJob(workerId: string): Promise<Job | null> {
    const job = await this.jobQueue.dequeue();
    if (job) {
      this.claimedJobs.set(job.jobId, job._filePath);
    }
    return job;
  }

  /**
   * Claim a job by atomically moving it from pending/ to running/.
   * Returns true if successfully claimed, false if another worker got it first.
   */
  async claimJob(jobId: string, workerId: string): Promise<boolean> {
    const claimedPath = this.claimedJobs.get(jobId);
    if (!claimedPath) return false;

    // We can't use updateFrontmatter. Read via CLI or raw, modify, rewrite.
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
  }

  /**
   * Update a job's status and optionally set result/stats.
   * Moves the file to the appropriate status directory.
   */
  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    data?: Partial<{
      result: string;
      streamingText: string;
      stats: JobStats;
      steeringMessage: string;
      conversationHistory: ConversationMessage[];
    }>,
  ): Promise<void> {
    const claimedPath = this.claimedJobs.get(jobId);
    if (!claimedPath) {
      throw new Error(`Job not found or not claimed by this process: ${jobId}`);
    }

    // Update file contents BEFORE ack/nack (which moves the file via atomic rename)
    const headers = await this.jobQueue["cli"].inspect(claimedPath);
    const rawBodyStr = await this.jobQueue["cli"].cat(claimedPath);
    const { custom: jobCustom, cleanBody: jobCleanBody } = FbmqCli.parseBodyCustom(rawBodyStr);
    headers.custom = { ...headers.custom, ...jobCustom };
    const job = jobCodec.deserialize(claimedPath, jobCleanBody, headers);

    job.status = status;
    job.updatedAt = this.nowISO();

    if (data?.result) job.result = data.result;
    if (data?.stats) job.stats = data.stats;
    if (data?.steeringMessage) job.steeringMessage = data.steeringMessage;
    if (data?.streamingText) job.streamingText = data.streamingText;
    if (data?.conversationHistory && data.conversationHistory.length > 0) {
      job.conversationHistory = data.conversationHistory;
    }

    // Write updated metadata back to the processing file
    this.writeRFC822(claimedPath, job, jobCodec);

    // For all terminal states, ack the message (move to done/).
    // fbmq nack = "retry" (return to pending), which is wrong for app-level failures.
    // The application-level status (done/failed/cancelled) is in the file metadata.
    if (status === "done" || status === "failed" || status === "cancelled") {
      await this.jobQueue.complete(claimedPath);
      this.claimedJobs.delete(jobId);
    }
  }

  /**
   * Append a log entry to the job's log file.
   */
  async addJobLog(
    jobId: string,
    type: string,
    content: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
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
  }

  /**
   * Create a new job in the pending queue.
   */
  async createJob(options: {
    instruction: string;
    type?: JobType;
    priority?: number;
    securityProfile?: SecurityProfile;
    modelOverride?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    threadId?: string | null;
  }): Promise<string> {
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
      _filePath: "" // Not relevant until dequeued
    };

    await this.jobQueue.enqueue(job);
    return jobId;
  }

  /**
   * Update a worker's heartbeat.
   */
  async workerHeartbeat(
    workerId: string,
    metadata?: {
      status?: "online" | "offline" | "busy";
      currentJobId?: string | null;
      modelConfig?: { provider: string; model: string };
    },
  ): Promise<void> {
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
  }

  // ─── Context & System ──────────────────────────────────────────────

  /**
   * Load all system context for agent initialization.
   */
  async getAgentContext(): Promise<SystemContext> {
    const readSystem = (name: string): string => {
      const fp = this.resolve("_system", `${name}.md`);
      if (!fs.existsSync(fp)) return "";
      return this.readMdFile(fp).content;
    };

    const pinnedNotes = await this.getPinnedNotes();

    // Parse CONFIG.md as key-value pairs from markdown table (line-by-line to avoid cross-line matching)
    const configContent = readSystem("CONFIG");
    const config: Record<string, string> = {};
    for (const line of configContent.split("\n")) {
      const m = line.match(/^\|\s*(\S+)\s*\|\s*(.+?)\s*\|/);
      if (m && m[1] !== "Key" && !/^-+$/.test(m[1])) {
        config[m[1]] = m[2].trim();
      }
    }

    return {
      soul: readSystem("SOUL"),
      memory: readSystem("MEMORY"),
      preferences: readSystem("PREFERENCES"),
      heartbeat: readSystem("HEARTBEAT"),
      config,
      pinnedNotes,
    };
  }

  /**
   * Get all pinned notes from the vault.
   */
  async getPinnedNotes(): Promise<Note[]> {
    const notes: Note[] = [];
    const notebooksDir = this.resolve("Notebooks");
    if (!fs.existsSync(notebooksDir)) return notes;

    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          try {
            const { data, content } = this.readMdFile(fullPath);
            if (data.pinned === true) {
              notes.push(this.parseNote(fullPath, data, content));
            }
          } catch {
            // Skip malformed files
          }
        }
      }
    };

    scanDir(notebooksDir);

    // Also check _system/ for pinned system files
    const systemDir = this.resolve("_system");
    if (fs.existsSync(systemDir)) {
      for (const file of fs.readdirSync(systemDir).filter((f) => f.endsWith(".md"))) {
        try {
          const fp = path.join(systemDir, file);
          const { data, content } = this.readMdFile(fp);
          if (data.pinned === true) {
            notes.push(this.parseNote(fp, data, content));
          }
        } catch {
          // Skip
        }
      }
    }

    return notes;
  }

  // ─── Notes ─────────────────────────────────────────────────────────

  /**
   * Create a new note in the specified notebook folder.
   */
  async createNote(
    folder: string,
    title: string,
    content: string,
    options?: Partial<{
      noteType: NoteType;
      tags: string[];
      pinned: boolean;
      source: string;
    }>,
  ): Promise<string> {
    const safeTitle = title.replace(/[/\\:*?"<>|]/g, "-");
    const filePath = this.resolve("Notebooks", folder, `${safeTitle}.md`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const frontmatter: Record<string, any> = {
      noteType: options?.noteType ?? "note",
      tags: options?.tags ?? [],
      pinned: options?.pinned ?? false,
      source: options?.source ?? "manual",
      embeddingStatus: "pending",
      relatedNotes: [],
      createdAt: this.nowISO(),
      updatedAt: this.nowISO(),
      version: 1,
      lastModifiedBy: "hq-agent",
    };

    // Append graph link sentinel so the daemon can inject wikilinks later
    const GRAPH_MARKER = "<!-- agent-hq-graph-links -->";
    const body = content.includes(GRAPH_MARKER)
      ? `# ${title}\n\n${content}`
      : `# ${title}\n\n${content}\n\n${GRAPH_MARKER}\n## Related Notes\n\n_Links will be auto-generated after embedding._\n`;

    this.writeMdFile(filePath, frontmatter, body, { modifiedBy: "hq-agent", isCreate: true });
    return filePath;
  }

  /**
   * Read a note from the vault by its path (absolute or relative to vault).
   */
  async readNote(notePath: string): Promise<Note> {
    const filePath = path.isAbsolute(notePath)
      ? notePath
      : this.resolve(notePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Note not found: ${notePath}`);
    }

    const { data, content } = this.readMdFile(filePath);
    return this.parseNote(filePath, data, content);
  }

  /**
   * Update a note's content and/or frontmatter.
   */
  async updateNote(
    notePath: string,
    content?: string,
    frontmatterUpdates?: Record<string, any>,
  ): Promise<void> {
    const filePath = path.isAbsolute(notePath)
      ? notePath
      : this.resolve(notePath);

    const token = await this.acquireLock(filePath);
    try {
      const { data, content: existingContent } = this.readMdFile(filePath);

      if (frontmatterUpdates) {
        Object.assign(data, frontmatterUpdates);
      }
      data.updatedAt = this.nowISO();

      // Mark for re-embedding if content changed
      if (content && content !== existingContent) {
        data.embeddingStatus = "pending";
      }

      this.writeMdFile(filePath, data, content ?? existingContent, { modifiedBy: "hq-agent" });
    } finally {
      await this.releaseLock(filePath, token);
    }
  }

  /**
   * Search notes by keyword (basic grep-style search).
   * For semantic search, use the SearchClient from ./search.ts.
   */
  async searchNotes(query: string, limit: number = 10): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const notebooksDir = this.resolve("Notebooks");
    if (!fs.existsSync(notebooksDir)) return results;

    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          try {
            const { data, content } = this.readMdFile(fullPath);
            const titleMatch = (data.title || entry.name)
              .toLowerCase()
              .includes(queryLower);
            const contentMatch = content.toLowerCase().includes(queryLower);
            const tagMatch = (data.tags || []).some((t: string) =>
              t.toLowerCase().includes(queryLower),
            );

            if (titleMatch || contentMatch || tagMatch) {
              // Calculate simple relevance
              let relevance = 0;
              if (titleMatch) relevance += 3;
              if (tagMatch) relevance += 2;
              if (contentMatch) relevance += 1;

              // Extract snippet around match
              let snippet = "";
              const idx = content.toLowerCase().indexOf(queryLower);
              if (idx !== -1) {
                const start = Math.max(0, idx - 50);
                const end = Math.min(content.length, idx + query.length + 50);
                snippet = content.substring(start, end).replace(/\n/g, " ");
                if (start > 0) snippet = "..." + snippet;
                if (end < content.length) snippet += "...";
              } else {
                snippet = content.substring(0, 100).replace(/\n/g, " ");
              }

              const relPath = path.relative(this.resolve("Notebooks"), fullPath);
              const notebook = relPath.split(path.sep)[0] ?? "Unknown";

              results.push({
                noteId: path.relative(this.vaultPath, fullPath),
                title: path.basename(entry.name, ".md"),
                notebook,
                snippet,
                tags: data.tags ?? [],
                relevance,
                _filePath: fullPath,
              });
            }
          } catch {
            // Skip malformed files
          }
        }
      }
    };

    scanDir(notebooksDir);
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  /**
   * List all notes in a folder, optionally filtered by frontmatter properties.
   */
  async listNotes(
    folder: string,
    filters?: Partial<{ noteType: NoteType; pinned: boolean; embeddingStatus: EmbeddingStatus }>,
  ): Promise<Note[]> {
    const dir = this.resolve("Notebooks", folder);
    if (!fs.existsSync(dir)) return [];

    const notes: Note[] = [];
    const scanDir = (d: string) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".md") && entry.name !== "_meta.md") {
          try {
            const { data, content } = this.readMdFile(fullPath);
            if (filters) {
              if (filters.noteType && data.noteType !== filters.noteType) continue;
              if (filters.pinned !== undefined && data.pinned !== filters.pinned) continue;
              if (filters.embeddingStatus && data.embeddingStatus !== filters.embeddingStatus) continue;
            }
            notes.push(this.parseNote(fullPath, data, content));
          } catch {
            // Skip
          }
        }
      }
    };

    scanDir(dir);
    return notes;
  }

  /**
   * Get all notes with a specific embedding status (for the embedding processor).
   */
  async getNotesForEmbedding(
    status: EmbeddingStatus = "pending",
    limit: number = 10,
  ): Promise<Note[]> {
    const results: Note[] = [];
    const notebooksDir = this.resolve("Notebooks");
    if (!fs.existsSync(notebooksDir)) return results;

    const scanDir = (dir: string) => {
      if (results.length >= limit) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          try {
            const { data, content } = this.readMdFile(fullPath);
            if (data.embeddingStatus === status) {
              results.push(this.parseNote(fullPath, data, content));
            }
          } catch {
            // Skip
          }
        }
      }
    };

    scanDir(notebooksDir);
    return results;
  }

  // ─── Delegation ────────────────────────────────────────────────────

  /**
   * Create delegated tasks for a job.
   */
  async createDelegatedTasks(
    jobId: string,
    tasks: Array<{
      taskId: string;
      instruction: string;
      targetHarnessType?: HarnessType;
      priority?: number;
      deadlineMs?: number;
      dependsOn?: string[];
      modelOverride?: string;
      traceId?: string;
      spanId?: string;
      parentSpanId?: string;
      securityConstraints?: import("./types").DelegationSecurityConstraints;
    }>,
  ): Promise<void> {
    for (const t of tasks) {
      const task: DelegatedTask = {
        taskId: t.taskId,
        jobId,
        targetHarnessType: t.targetHarnessType ?? "any",
        status: "pending",
        priority: t.priority ?? 50,
        deadlineMs: t.deadlineMs ?? 600000,
        dependsOn: t.dependsOn ?? [],
        claimedBy: null,
        claimedAt: null,
        instruction: t.instruction,
        createdAt: this.nowISO(),
        traceId: t.traceId,
        spanId: t.spanId,
        parentSpanId: t.parentSpanId,
        securityConstraints: t.securityConstraints,
        _filePath: ""
      };
      await this.delegationQueue.enqueue(task);
    }
  }

  /**
   * Read a full result file stored in _delegation/results/.
   * Returns null if not found.
   */
  readFullResult(taskId: string): string | null {
    const filePath = this.resolve("_delegation/results", `result-${taskId}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  /**
   * Get pending tasks for a specific harness type.
   * Respects task dependencies (only returns tasks whose dependsOn are all completed).
   */
  async getPendingTasks(harnessType: string): Promise<DelegatedTask[]> {
    const task = await this.delegationQueue.dequeue(harnessType as HarnessType);
    if (!task) return [];
    this.claimedTasks.set(task.taskId, task._filePath);
    return [task];
  }

  /**
   * Claim a delegated task atomically.
   */
  async claimTask(taskId: string, relayId: string): Promise<boolean> {
    const claimedPath = this.claimedTasks.get(taskId);
    if (!claimedPath) return false;

    try {
      const headers = await this.delegationQueue["mainCli"].inspect(claimedPath);
      const rawBody = await this.delegationQueue["mainCli"].cat(claimedPath);
      const { custom: taskCustom, cleanBody: taskCleanBody } = FbmqCli.parseBodyCustom(rawBody);
      headers.custom = { ...headers.custom, ...taskCustom };
      const task = delegationCodec.deserialize(claimedPath, taskCleanBody, headers);

      task.status = "claimed";
      task.claimedBy = relayId;
      task.claimedAt = this.nowISO();

      this.writeRFC822(claimedPath, task, delegationCodec);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update a delegated task's status.
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: string,
    error?: string,
  ): Promise<void> {
    const claimedPath = this.claimedTasks.get(taskId);
    if (!claimedPath) {
      throw new Error(`Task not found or not claimed by this process: ${taskId}`);
    }

    const headers = await this.delegationQueue["mainCli"].inspect(claimedPath);
    const rawBodyStr = await this.delegationQueue["mainCli"].cat(claimedPath);
    const { custom: taskCustom2, cleanBody: taskCleanBody2 } = FbmqCli.parseBodyCustom(rawBodyStr);
    headers.custom = { ...headers.custom, ...taskCustom2 };
    const task = delegationCodec.deserialize(claimedPath, taskCleanBody2, headers);

    task.status = status;
    if (result) task.result = result;
    if (error) task.error = error;

    this.writeRFC822(claimedPath, task, delegationCodec);

    // Ack for all terminal states — app-level status is in file metadata.
    if (status === "completed" || status === "failed" || status === "cancelled" || status === "timeout") {
      await this.delegationQueue.complete(claimedPath);
      this.claimedTasks.delete(taskId);
    }
  }

  /**
   * Get all tasks for a specific job.
   */
  async getTasksForJob(jobId: string): Promise<DelegatedTask[]> {
    const tasks: DelegatedTask[] = [];
    const dirs = ["pending", "claimed", "completed"];

    for (const dir of dirs) {
      const files = this.listMdFiles(`_delegation/${dir}`);
      for (const f of files) {
        try {
          const { data, content } = this.readMdFile(f);
          if (data.jobId === jobId) {
            tasks.push(this.parseDelegatedTask(f, data, content));
          }
        } catch {
          // Skip
        }
      }
    }

    return tasks;
  }

  // ─── Relay Health ──────────────────────────────────────────────────

  /**
   * Get health status for all relay bots.
   */
  async getRelayHealthAll(): Promise<RelayHealth[]> {
    const files = this.listMdFiles("_delegation/relay-health");
    const relays: RelayHealth[] = [];

    for (const f of files) {
      try {
        const { data, content } = this.readMdFile(f);
        relays.push({
          relayId: data.relayId ?? "",
          harnessType: data.harnessType ?? "",
          displayName: data.displayName ?? "",
          status: data.status ?? "offline",
          lastHeartbeat: data.lastHeartbeat ?? null,
          tasksCompleted: data.tasksCompleted ?? 0,
          tasksFailed: data.tasksFailed ?? 0,
          avgResponseTimeMs: data.avgResponseTimeMs ?? 0,
          capabilities: data.capabilities ?? [],
          discordChannelId: data.discordChannelId ?? null,
          _filePath: f,
        });
      } catch {
        // Skip
      }
    }

    return relays;
  }

  /**
   * Update or create relay health record.
   */
  async upsertRelayHealth(
    relayId: string,
    data: Partial<Omit<RelayHealth, "relayId" | "_filePath">>,
  ): Promise<void> {
    const safeId = relayId.replace(/[/\\:*?"<>|]/g, "-");
    const filePath = this.resolve("_delegation/relay-health", `${safeId}.md`);

    if (fs.existsSync(filePath)) {
      this.updateFrontmatter(filePath, {
        ...data,
        lastHeartbeat: data.lastHeartbeat ?? this.nowISO(),
      });
    } else {
      this.writeMdFile(
        filePath,
        {
          relayId,
          harnessType: data.harnessType ?? "unknown",
          displayName: data.displayName ?? relayId,
          status: data.status ?? "offline",
          lastHeartbeat: this.nowISO(),
          tasksCompleted: data.tasksCompleted ?? 0,
          tasksFailed: data.tasksFailed ?? 0,
          avgResponseTimeMs: data.avgResponseTimeMs ?? 0,
          capabilities: data.capabilities ?? [],
          discordChannelId: data.discordChannelId ?? null,
        },
        `# Relay: ${data.displayName ?? relayId}`,
      );
    }
  }

  // ─── Usage Tracking ────────────────────────────────────────────────

  /**
   * Log a usage entry.
   */
  async logUsage(
    model: string,
    tokens: { promptTokens: number; completionTokens: number; totalTokens: number },
    cost?: number,
  ): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const month = today.substring(0, 7);
    const dailyFile = this.resolve("_usage/daily", `${today}.md`);
    const monthlyFile = this.resolve("_usage", `${month}-usage.md`);

    const computedCost =
      cost ?? calculateCost(model, tokens.promptTokens, tokens.completionTokens);
    const timestamp = this.nowISO();
    const entry = `| ${timestamp.split("T")[1]?.substring(0, 8)} | ${model} | ${tokens.promptTokens} | ${tokens.completionTokens} | $${computedCost.toFixed(4)} |\n`;

    // Append to daily file
    if (!fs.existsSync(dailyFile)) {
      const header = `---\ndate: "${today}"\ntotalPromptTokens: 0\ntotalCompletionTokens: 0\ntotalCost: 0\nrequestCount: 0\n---\n# Usage: ${today}\n\n| Time | Model | Prompt | Completion | Cost |\n|------|-------|--------|------------|------|\n`;
      fs.writeFileSync(dailyFile, header + entry, "utf-8");
    } else {
      fs.appendFileSync(dailyFile, entry, "utf-8");
    }

    // Update daily totals in frontmatter
    try {
      const { data } = this.readMdFile(dailyFile);
      data.totalPromptTokens = (data.totalPromptTokens ?? 0) + tokens.promptTokens;
      data.totalCompletionTokens =
        (data.totalCompletionTokens ?? 0) + tokens.completionTokens;
      data.totalCost = (data.totalCost ?? 0) + computedCost;
      data.requestCount = (data.requestCount ?? 0) + 1;
      // Re-read content (since we appended) and update frontmatter
      const raw = fs.readFileSync(dailyFile, "utf-8");
      const parsed = matter(raw);
      Object.assign(parsed.data, data);
      fs.writeFileSync(dailyFile, matter.stringify(parsed.content, parsed.data), "utf-8");
    } catch {
      // Non-critical
    }
  }

  // ─── Settings ──────────────────────────────────────────────────────

  /**
   * Get a setting value from CONFIG.md.
   */
  async getSetting(key: string): Promise<string | null> {
    const ctx = await this.getAgentContext();
    return ctx.config[key] ?? null;
  }

  /**
   * Set a value in CONFIG.md (updates the markdown table).
   */
  async setSetting(key: string, value: string): Promise<void> {
    const filePath = this.resolve("_system", "CONFIG.md");
    const raw = fs.readFileSync(filePath, "utf-8");

    // Check if key exists in table
    const keyPattern = new RegExp(`\\|\\s*${key}\\s*\\|[^|]*\\|`);
    if (keyPattern.test(raw)) {
      // Update existing row
      const updated = raw.replace(keyPattern, `| ${key} | ${value} |`);
      fs.writeFileSync(filePath, updated, "utf-8");
    } else {
      // Append new row before the last section or at the end
      const lines = raw.split("\n");
      // Find last table row and insert after it
      let lastTableIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("|") && !lines[i].includes("---")) {
          lastTableIdx = i;
          break;
        }
      }
      if (lastTableIdx !== -1) {
        lines.splice(lastTableIdx + 1, 0, `| ${key} | ${value} |`);
      } else {
        lines.push(`| ${key} | ${value} |`);
      }
      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
    }
  }

  // ─── Threads ───────────────────────────────────────────────────────

  /**
   * Create a new chat thread.
   */
  async createThread(title?: string): Promise<string> {
    const threadId = `thread-${this.generateId()}`;
    const filePath = this.resolve("_threads/active", `${threadId}.md`);

    this.writeMdFile(
      filePath,
      {
        threadId,
        status: "active",
        titleGenerated: !title,
        createdAt: this.nowISO(),
      },
      `# ${title ?? "New Conversation"}\n`,
    );

    return threadId;
  }

  /**
   * Append a message to a thread.
   */
  async appendMessage(
    threadId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const filePath = this.resolve("_threads/active", `${threadId}.md`);
    if (!fs.existsSync(filePath)) {
      // Try archived
      const archived = this.resolve("_threads/archived", `${threadId}.md`);
      if (!fs.existsSync(archived)) {
        throw new Error(`Thread not found: ${threadId}`);
      }
    }

    const time = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const entry = `\n## ${role === "user" ? "User" : "Assistant"} (${time})\n\n${content}\n`;
    fs.appendFileSync(filePath, entry, "utf-8");
  }

  /**
   * List active threads.
   */
  async listThreads(): Promise<
    Array<{ threadId: string; title: string; createdAt: string; status: string }>
  > {
    const files = this.listMdFiles("_threads/active");
    const threads: Array<{
      threadId: string;
      title: string;
      createdAt: string;
      status: string;
    }> = [];

    for (const f of files) {
      try {
        const { data, content } = this.readMdFile(f);
        // Extract title from first heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        threads.push({
          threadId: data.threadId ?? path.basename(f, ".md"),
          title: titleMatch?.[1] ?? "Untitled",
          createdAt: data.createdAt ?? "",
          status: data.status ?? "active",
        });
      } catch {
        // Skip
      }
    }

    threads.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return threads;
  }

  // ─── Approvals ─────────────────────────────────────────────────────

  /**
   * Create an approval request.
   */
  async createApproval(options: {
    title: string;
    description: string;
    toolName: string;
    toolArgs?: Record<string, any>;
    riskLevel: "low" | "medium" | "high" | "critical";
    jobId?: string;
    timeoutMinutes?: number;
  }): Promise<string> {
    const approvalId = `approval-${this.generateId()}`;
    const filePath = this.resolve("_approvals/pending", `${approvalId}.md`);
    const timeout = options.timeoutMinutes ?? 10;

    this.writeMdFile(
      filePath,
      {
        approvalId,
        status: "pending",
        title: options.title,
        toolName: options.toolName,
        toolArgs: options.toolArgs ?? null,
        riskLevel: options.riskLevel,
        jobId: options.jobId ?? null,
        expiresAt: new Date(
          Date.now() + timeout * 60 * 1000,
        ).toISOString(),
        createdAt: this.nowISO(),
      },
      `# ${options.title}\n\n${options.description}`,
    );

    return approvalId;
  }

  /**
   * Get an approval by ID.
   */
  async getApproval(
    approvalId: string,
  ): Promise<{ status: string; resolvedBy?: string; rejectionReason?: string } | null> {
    for (const dir of ["pending", "resolved"]) {
      const files = this.listMdFiles(`_approvals/${dir}`);
      const found = files.find((f) => {
        try {
          const { data } = this.readMdFile(f);
          return data.approvalId === approvalId;
        } catch {
          return false;
        }
      });
      if (found) {
        const { data } = this.readMdFile(found);
        return {
          status: data.status,
          resolvedBy: data.resolvedBy,
          rejectionReason: data.rejectionReason,
        };
      }
    }
    return null;
  }

  /**
   * Resolve an approval request (approve or reject).
   */
  async resolveApproval(
    approvalId: string,
    decision: "approved" | "rejected",
    resolvedBy?: string,
    rejectionReason?: string,
  ): Promise<void> {
    const files = this.listMdFiles("_approvals/pending");
    const found = files.find((f) => {
      try {
        const { data } = this.readMdFile(f);
        return data.approvalId === approvalId;
      } catch {
        return false;
      }
    });

    if (!found) throw new Error(`Approval not found: ${approvalId}`);

    this.updateFrontmatter(found, {
      status: decision,
      resolvedBy: resolvedBy ?? "local-user",
      resolvedAt: this.nowISO(),
      ...(rejectionReason && { rejectionReason }),
    });

    // Move to resolved
    const filename = path.basename(found);
    const dest = this.resolve("_approvals/resolved", filename);
    fs.renameSync(found, dest);
  }

  // ─── Live Task Output ──────────────────────────────────────────────

  /**
   * Write a chunk of harness stdout to the live output file for a task.
   * Creates the file on first call; appends and trims to 50KB rolling window on subsequent calls.
   */
  writeLiveChunk(taskId: string, claimedBy: string, chunk: string): void {
    const MAX_BODY = 50_000;
    const TRIM_TO = 50_000;
    const now = this.nowISO();
    const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);

    if (!fs.existsSync(filePath)) {
      this.writeMdFile(
        filePath,
        { taskId, claimedBy, startedAt: now, lastChunkAt: now, byteCount: chunk.length },
        chunk,
      );
    } else {
      try {
        const { data, content } = this.readMdFile(filePath);
        let newBody = content + chunk;
        if (newBody.length > MAX_BODY + 1024) {
          newBody = newBody.slice(newBody.length - TRIM_TO);
        }
        data.lastChunkAt = now;
        data.byteCount = (data.byteCount ?? 0) + chunk.length;
        this.writeMdFile(filePath, data, newBody);
      } catch {
        // If read fails, overwrite with just this chunk
        this.writeMdFile(
          filePath,
          { taskId, claimedBy, startedAt: now, lastChunkAt: now, byteCount: chunk.length },
          chunk,
        );
      }
    }
  }

  /**
   * Read the current live output for a running task. Returns null if no live file exists.
   */
  readLiveOutput(taskId: string): import("./types").LiveTaskOutput | null {
    const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const { data, content } = this.readMdFile(filePath);
      return {
        taskId: data.taskId ?? taskId,
        claimedBy: data.claimedBy ?? "",
        startedAt: data.startedAt ?? "",
        lastChunkAt: data.lastChunkAt ?? "",
        byteCount: data.byteCount ?? 0,
        output: content,
        _filePath: filePath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete the live output file for a task (call on completion/failure).
   */
  deleteLiveOutput(taskId: string): void {
    const filePath = this.resolve("_delegation/live", `live-${taskId}.md`);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Non-fatal
    }
  }

  /**
   * List all currently active live output files, sorted by most recently updated.
   */
  listLiveTasks(): import("./types").LiveTaskOutput[] {
    const files = this.listMdFiles("_delegation/live");
    const results: import("./types").LiveTaskOutput[] = [];
    for (const f of files) {
      try {
        const { data, content } = this.readMdFile(f);
        const taskId = data.taskId ?? path.basename(f, ".md").replace("live-", "");
        results.push({
          taskId,
          claimedBy: data.claimedBy ?? "",
          startedAt: data.startedAt ?? "",
          lastChunkAt: data.lastChunkAt ?? "",
          byteCount: data.byteCount ?? 0,
          output: content,
          _filePath: f,
        });
      } catch {
        // Skip malformed files
      }
    }
    return results.sort(
      (a, b) => new Date(b.lastChunkAt).getTime() - new Date(a.lastChunkAt).getTime(),
    );
  }

  // ─── Recent Activity ─────────────────────────────────────────────────

  /**
   * Append a message to the recent activity log.
   * Maintains a rolling window of the most recent messages.
   */
  async appendRecentActivity(entry: RecentActivityEntry): Promise<void> {
    const filePath = this.resolve("_system", "RECENT_ACTIVITY.md");
    const MAX_ENTRIES = 30;
    const MAX_CONTENT_LENGTH = 1000;

    let entries: RecentActivityEntry[] = [];

    // Read existing entries
    if (fs.existsSync(filePath)) {
      try {
        const { data } = this.readMdFile(filePath);
        entries = (data.entries as RecentActivityEntry[]) ?? [];
      } catch {
        entries = [];
      }
    }

    // Truncate content if too long
    const truncatedContent = entry.content.length > MAX_CONTENT_LENGTH
      ? entry.content.substring(0, MAX_CONTENT_LENGTH) + "..."
      : entry.content;

    // Add new entry with heavily truncated content for frontmatter (to avoid JSON/YAML bloat)
    // Since getRecentActivity reads from data.entries, 200 chars is enough context.
    entries.push({
      ...entry,
      content: truncatedContent.length > 200 ? truncatedContent.substring(0, 200) + "..." : truncatedContent,
    });

    // Keep only the most recent entries
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
    }

    // Build markdown content (uses full truncatedContent, not the 200-char version)
    const lines = entries.slice().reverse().map(e => {
      const roleLabel = e.role === "user" ? "User" : "Assistant";
      const sourceLabel = e.source === "discord" ? "[Discord]" : e.source === "chat" ? "[Chat]" : "[Job]";
      const channelInfo = e.channel ? ` (#${e.channel.substring(0, 8)})` : "";
      const time = new Date(e.timestamp).toLocaleString();
      return `### ${roleLabel} ${sourceLabel}${channelInfo} — ${time}\n\n${e.content}`;
    });

    const content = `# Recent Activity\n\nA rolling log of the most recent conversations across Discord, Chat, and Jobs.\n\n---\n\n${lines.join("\n\n---\n\n")}`;

    this.writeMdFile(filePath, { entries, updatedAt: this.nowISO() }, content);
  }

  /**
   * Get the recent activity log.
   */
  async getRecentActivity(limit: number = 15): Promise<RecentActivityEntry[]> {
    const filePath = this.resolve("_system", "RECENT_ACTIVITY.md");

    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const { data } = this.readMdFile(filePath);
      const entries = (data.entries as RecentActivityEntry[]) ?? [];
      return entries.slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * Get recent activity formatted as a context string for prompts.
   */
  async getRecentActivityContext(limit: number = 15): Promise<string> {
    const entries = await this.getRecentActivity(limit);

    if (entries.length === 0) {
      return "";
    }

    const lines = entries.map(e => {
      const roleLabel = e.role === "user" ? "User" : "Assistant";
      const sourceLabel = e.source === "discord" ? "Discord" : e.source === "chat" ? "Chat" : "Job";
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      return `[${time} ${sourceLabel}] ${roleLabel}: ${e.content}`;
    });

    return `## Recent Conversation History (${entries.length} messages)\n\n` + lines.join("\n\n");
  }

  // ─── COO Inbox/Outbox ──────────────────────────────────────────────

  /**
   * Send an intent to the active COO by writing to _delegation/coo_inbox.
   * Returns the intent ID.
   */
  async sendToCoo(intent: Omit<import("./types").MasterIntent, "intentId" | "status" | "createdAt">): Promise<string> {
    const intentId = `intent-${this.generateId()}`;
    const inboxPath = this.resolve("_delegation/coo_inbox", `${intentId}.json`);

    const payload: import("./types").MasterIntent = {
      ...intent,
      intentId,
      status: "pending",
      createdAt: this.nowISO()
    };

    const dir = path.dirname(inboxPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(inboxPath, JSON.stringify(payload, null, 2), "utf-8");
    return intentId;
  }

  /**
   * Periodically called to check if COO has replied in _delegation/coo_outbox.
   * Returns response string or null if not yet processed.
   */
  async getCooResponse(intentId: string): Promise<string | null> {
    const outboxPath = this.resolve("_delegation/coo_outbox", `${intentId}.json`);
    if (!fs.existsSync(outboxPath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(outboxPath, "utf-8"));
      if (data.status === "completed" || data.response) {
        fs.unlinkSync(outboxPath);
        return data.response ?? "[Done]";
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * List all pending intent IDs in the coo_outbox.
   */
  async listCooResponses(): Promise<string[]> {
    const outboxDir = this.resolve("_delegation/coo_outbox");
    if (!fs.existsSync(outboxDir)) return [];

    return fs.readdirSync(outboxDir)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(".json", ""));
  }

  // ─── CFO Inbox/Outbox ──────────────────────────────────────────────

  /**
   * Send an intent to the CFO subprocess by writing to _delegation/cfo_inbox.
   * Returns the intent ID.
   */
  async sendToCfo(intent: Omit<import("./types").CFOIntent, "intentId" | "status" | "createdAt">): Promise<string> {
    const intentId = `cfo-${this.generateId()}`;
    const inboxPath = this.resolve("_delegation/cfo_inbox", `${intentId}.json`);

    const payload: import("./types").CFOIntent = {
      ...intent,
      intentId,
      status: "pending",
      createdAt: this.nowISO(),
    };

    const dir = path.dirname(inboxPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(inboxPath, JSON.stringify(payload, null, 2), "utf-8");
    return intentId;
  }

  /**
   * Check if CFO has replied in _delegation/cfo_outbox.
   * Returns parsed CfoEstimate or null if not yet processed.
   * Auto-deletes the response file after reading.
   */
  async getCfoResponse(intentId: string): Promise<import("./types").CfoEstimate | string | null> {
    const outboxPath = this.resolve("_delegation/cfo_outbox", `${intentId}.json`);
    if (!fs.existsSync(outboxPath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(outboxPath, "utf-8"));
      if (data.status === "completed" || data.estimate || data.response) {
        fs.unlinkSync(outboxPath);
        return data.estimate ?? data.response ?? "[Done]";
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Append a usage record to today's daily usage log in _usage/daily/YYYY-MM-DD.md.
   */
  async recordUsage(record: import("./types").UsageRecord): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const dailyDir = this.resolve("_usage/daily");
    if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });

    const filePath = path.join(dailyDir, `${today}.md`);
    const line = `- ${record.timestamp} | ${record.model} | in:${record.inputTokens} out:${record.outputTokens} | $${record.estimatedCostUsd.toFixed(6)} | task:${record.taskId}\n`;

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# Usage Log — ${today}\n\n`, "utf-8");
    }
    fs.appendFileSync(filePath, line, "utf-8");
  }

  /**
   * Read the pricing cache from _usage/pricing-cache.md.
   * Returns a map of modelId → { inputPer1k, outputPer1k }.
   */
  getPricingCache(): Record<string, { inputPer1k: number; outputPer1k: number }> {
    const cachePath = this.resolve("_usage/pricing-cache.md");
    if (!fs.existsSync(cachePath)) return {};

    try {
      const matter = require("gray-matter");
      const { data } = matter(fs.readFileSync(cachePath, "utf-8"));
      return (data.models as import("./types").ModelPricing[] | undefined ?? []).reduce(
        (acc, m) => {
          acc[m.modelId] = { inputPer1k: m.inputPer1k, outputPer1k: m.outputPer1k };
          return acc;
        },
        {} as Record<string, { inputPer1k: number; outputPer1k: number }>,
      );
    } catch {
      return {};
    }
  }

  // ─── Parsers ───────────────────────────────────────────────────────

  private parseJob(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): Job {
    // Extract instruction from content (everything after "# Instruction" heading)
    const instrMatch = content.match(/^#\s+Instruction\s*\n([\s\S]*?)(?=\n##|$)/m);
    const instruction = instrMatch?.[1]?.trim() ?? content;

    return {
      jobId: data.jobId ?? "",
      type: data.type ?? "background",
      status: data.status ?? "pending",
      priority: data.priority ?? 50,
      securityProfile: data.securityProfile ?? "standard",
      modelOverride: data.modelOverride ?? null,
      thinkingLevel: data.thinkingLevel ?? null,
      workerId: data.workerId ?? null,
      threadId: data.threadId ?? null,
      instruction,
      result: data.result,
      streamingText: data.streamingText,
      conversationHistory: data.conversationHistory,
      steeringMessage: data.steeringMessage,
      stats: data.stats,
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt,
      _filePath: filePath,
    };
  }

  private parseNote(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): Note {
    return {
      title: path.basename(filePath, ".md"),
      content,
      noteType: data.noteType ?? "note",
      tags: data.tags ?? [],
      pinned: data.pinned ?? false,
      source: data.source ?? "manual",
      embeddingStatus: data.embeddingStatus ?? "pending",
      relatedNotes: data.relatedNotes ?? [],
      createdAt: data.createdAt ?? "",
      updatedAt: data.updatedAt ?? "",
      _filePath: filePath,
    };
  }

  private parseDelegatedTask(
    filePath: string,
    data: Record<string, any>,
    content: string,
  ): DelegatedTask {
    const instrMatch = content.match(
      /^#\s+Task\s+Instruction\s*\n([\s\S]*?)(?=\n##|$)/m,
    );
    const instruction = instrMatch?.[1]?.trim() ?? content;

    return {
      taskId: data.taskId ?? "",
      jobId: data.jobId ?? "",
      targetHarnessType: data.targetHarnessType ?? "any",
      status: data.status ?? "pending",
      priority: data.priority ?? 50,
      deadlineMs: data.deadlineMs ?? 600000,
      dependsOn: data.dependsOn ?? [],
      claimedBy: data.claimedBy ?? null,
      claimedAt: data.claimedAt ?? null,
      instruction,
      result: data.result,
      error: data.error,
      createdAt: data.createdAt ?? "",
      traceId: data.traceId ?? undefined,
      spanId: data.spanId ?? undefined,
      parentSpanId: data.parentSpanId ?? undefined,
      securityConstraints: data.securityConstraints ?? undefined,
      _filePath: filePath,
    };
  }
}
