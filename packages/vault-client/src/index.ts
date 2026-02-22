/**
 * VaultClient — Local filesystem replacement for Convex backend.
 *
 * Reads/writes markdown files with YAML frontmatter in the Obsidian vault.
 * Job claiming uses atomic fs.renameSync for concurrency safety.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
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
} from "./types";

export type { Job, Note, DelegatedTask, RelayHealth, SystemContext, SearchResult };
export { calculateCost } from "./pricing";

// Re-export types
export * from "./types";

export class VaultClient {
  readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = path.resolve(vaultPath);
    if (!fs.existsSync(this.vaultPath)) {
      throw new Error(`Vault not found at: ${this.vaultPath}`);
    }
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
  ): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const output = matter.stringify("\n" + content + "\n", frontmatter);
    fs.writeFileSync(filePath, output, "utf-8");
  }

  private updateFrontmatter(
    filePath: string,
    updates: Record<string, any>,
  ): void {
    const { data, content } = this.readMdFile(filePath);
    Object.assign(data, updates);
    this.writeMdFile(filePath, data, content);
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

  // ─── Job Queue ─────────────────────────────────────────────────────

  /**
   * Get the highest-priority pending job.
   * Returns null if no jobs are pending.
   */
  async getPendingJob(workerId: string): Promise<Job | null> {
    const files = this.listMdFiles("_jobs/pending");
    if (files.length === 0) return null;

    // Parse all pending jobs and sort by priority DESC, then createdAt ASC
    const jobs: { file: string; data: Record<string, any>; content: string }[] = [];
    for (const file of files) {
      try {
        const { data, content } = this.readMdFile(file);
        jobs.push({ file, data, content });
      } catch {
        // Skip malformed files
      }
    }

    if (jobs.length === 0) return null;

    jobs.sort((a, b) => {
      const priDiff = (b.data.priority ?? 50) - (a.data.priority ?? 50);
      if (priDiff !== 0) return priDiff;
      return (
        new Date(a.data.createdAt ?? 0).getTime() -
        new Date(b.data.createdAt ?? 0).getTime()
      );
    });

    const best = jobs[0];
    return this.parseJob(best.file, best.data, best.content);
  }

  /**
   * Claim a job by atomically moving it from pending/ to running/.
   * Returns true if successfully claimed, false if another worker got it first.
   */
  async claimJob(jobId: string, workerId: string): Promise<boolean> {
    const pendingDir = this.resolve("_jobs/pending");
    const runningDir = this.resolve("_jobs/running");

    const files = this.listMdFiles("_jobs/pending");
    const target = files.find((f) => {
      try {
        const { data } = this.readMdFile(f);
        return data.jobId === jobId;
      } catch {
        return false;
      }
    });

    if (!target) return false;

    const filename = path.basename(target);
    const dest = path.join(runningDir, filename);

    try {
      // Atomic rename — only one process succeeds
      fs.renameSync(target, dest);

      // Update frontmatter with worker info
      this.updateFrontmatter(dest, {
        status: "running",
        workerId,
        updatedAt: this.nowISO(),
      });

      return true;
    } catch {
      // Another worker claimed it (ENOENT)
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
    // Find the job file in any status directory
    const statusDirs = ["pending", "running", "done", "failed"];
    let currentPath: string | null = null;

    for (const dir of statusDirs) {
      const files = this.listMdFiles(`_jobs/${dir}`);
      const found = files.find((f) => {
        try {
          const { data: fm } = this.readMdFile(f);
          return fm.jobId === jobId;
        } catch {
          return false;
        }
      });
      if (found) {
        currentPath = found;
        break;
      }
    }

    if (!currentPath) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const filename = path.basename(currentPath);
    const targetDir = this.resolve(`_jobs/${status === "waiting_for_user" ? "running" : status}`);
    const targetPath = path.join(targetDir, filename);

    // Update frontmatter
    const { data: fm, content } = this.readMdFile(currentPath);
    Object.assign(fm, { status, updatedAt: this.nowISO() });

    if (data?.result) fm.result = data.result;
    if (data?.stats) fm.stats = data.stats;
    if (data?.steeringMessage) fm.steeringMessage = data.steeringMessage;

    // Write conversation history and streaming text into the body
    let body = content;
    if (data?.streamingText) {
      // Append streaming text section
      if (!body.includes("## Streaming Output")) {
        body += "\n\n## Streaming Output\n";
      }
      body = body.replace(
        /## Streaming Output\n[\s\S]*$/,
        `## Streaming Output\n${data.streamingText}`,
      );
    }
    if (data?.conversationHistory && data.conversationHistory.length > 0) {
      if (!body.includes("## Conversation History")) {
        body += "\n\n## Conversation History\n";
      }
      const historyMd = data.conversationHistory
        .map((m) => `### ${m.role} (${m.timestamp})\n${m.content}`)
        .join("\n\n");
      body = body.replace(
        /## Conversation History\n[\s\S]*$/,
        `## Conversation History\n${historyMd}`,
      );
    }

    this.writeMdFile(currentPath, fm, body);

    // Move file if status directory changed
    if (currentPath !== targetPath) {
      try {
        fs.renameSync(currentPath, targetPath);
      } catch {
        // Already moved or doesn't exist
      }
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
    const filename = `${jobId}.md`;
    const filePath = this.resolve("_jobs/pending", filename);

    const frontmatter: Record<string, any> = {
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
    };

    this.writeMdFile(filePath, frontmatter, `# Instruction\n\n${options.instruction}`);
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
    };

    // Append graph link sentinel so the daemon can inject wikilinks later
    const GRAPH_MARKER = "<!-- agent-hq-graph-links -->";
    const body = content.includes(GRAPH_MARKER)
      ? `# ${title}\n\n${content}`
      : `# ${title}\n\n${content}\n\n${GRAPH_MARKER}\n## Related Notes\n\n_Links will be auto-generated after embedding._\n`;

    this.writeMdFile(filePath, frontmatter, body);
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

    const { data, content: existingContent } = this.readMdFile(filePath);

    if (frontmatterUpdates) {
      Object.assign(data, frontmatterUpdates);
    }
    data.updatedAt = this.nowISO();

    // Mark for re-embedding if content changed
    if (content && content !== existingContent) {
      data.embeddingStatus = "pending";
    }

    this.writeMdFile(filePath, data, content ?? existingContent);
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
    }>,
  ): Promise<void> {
    for (const task of tasks) {
      const filename = `task-${task.taskId}.md`;
      const filePath = this.resolve("_delegation/pending", filename);

      this.writeMdFile(
        filePath,
        {
          taskId: task.taskId,
          jobId,
          targetHarnessType: task.targetHarnessType ?? "any",
          status: "pending",
          priority: task.priority ?? 50,
          deadlineMs: task.deadlineMs ?? 600000,
          dependsOn: task.dependsOn ?? [],
          modelOverride: task.modelOverride ?? null,
          claimedBy: null,
          claimedAt: null,
          createdAt: this.nowISO(),
        },
        `# Task Instruction\n\n${task.instruction}`,
      );
    }
  }

  /**
   * Get pending tasks for a specific harness type.
   * Respects task dependencies (only returns tasks whose dependsOn are all completed).
   */
  async getPendingTasks(harnessType: string): Promise<DelegatedTask[]> {
    const pending = this.listMdFiles("_delegation/pending");
    const completed = this.listMdFiles("_delegation/completed");

    // Build set of completed task IDs
    const completedIds = new Set<string>();
    for (const f of completed) {
      try {
        const { data } = this.readMdFile(f);
        if (data.taskId) completedIds.add(data.taskId);
      } catch {
        // Skip
      }
    }

    const tasks: DelegatedTask[] = [];
    for (const f of pending) {
      try {
        const { data, content } = this.readMdFile(f);
        // Filter by harness type
        if (
          data.targetHarnessType !== "any" &&
          data.targetHarnessType !== harnessType
        ) {
          continue;
        }
        // Check dependencies
        const deps = (data.dependsOn as string[]) ?? [];
        const allDepsCompleted = deps.every((d) => completedIds.has(d));
        if (!allDepsCompleted) continue;

        tasks.push(this.parseDelegatedTask(f, data, content));
      } catch {
        // Skip
      }
    }

    tasks.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50));
    return tasks;
  }

  /**
   * Claim a delegated task atomically.
   */
  async claimTask(taskId: string, relayId: string): Promise<boolean> {
    const files = this.listMdFiles("_delegation/pending");
    const target = files.find((f) => {
      try {
        const { data } = this.readMdFile(f);
        return data.taskId === taskId;
      } catch {
        return false;
      }
    });

    if (!target) return false;

    const filename = path.basename(target);
    const dest = this.resolve("_delegation/claimed", filename);

    try {
      fs.renameSync(target, dest);
      this.updateFrontmatter(dest, {
        status: "claimed",
        claimedBy: relayId,
        claimedAt: this.nowISO(),
      });
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
    const dirs = ["pending", "claimed", "completed"];
    let currentPath: string | null = null;

    for (const dir of dirs) {
      const files = this.listMdFiles(`_delegation/${dir}`);
      const found = files.find((f) => {
        try {
          const { data } = this.readMdFile(f);
          return data.taskId === taskId;
        } catch {
          return false;
        }
      });
      if (found) {
        currentPath = found;
        break;
      }
    }

    if (!currentPath) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const filename = path.basename(currentPath);
    const targetDir =
      status === "completed" || status === "failed"
        ? "completed"
        : status === "claimed" || status === "running"
          ? "claimed"
          : "pending";
    const targetPath = this.resolve(`_delegation/${targetDir}`, filename);

    const updates: Record<string, any> = { status };
    if (result) updates.result = result;
    if (error) updates.error = error;
    updates.completedAt = this.nowISO();

    this.updateFrontmatter(currentPath, updates);

    if (currentPath !== targetPath) {
      try {
        fs.renameSync(currentPath, targetPath);
      } catch {
        // Already moved
      }
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
      _filePath: filePath,
    };
  }
}
