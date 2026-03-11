/**
 * VaultClient — Context, system, settings, threads, and approvals.
 */

import * as fs from "fs";
import * as path from "path";
import { VaultClient } from "./core";
import type { Note, SystemContext } from "./types";

declare module "./core" {
  interface VaultClient {
    // Context & System
    getAgentContext(): Promise<SystemContext>;
    getPinnedNotes(): Promise<Note[]>;

    // Settings
    getSetting(key: string): Promise<string | null>;
    setSetting(key: string, value: string): Promise<void>;

    // Threads
    createThread(title?: string): Promise<string>;
    appendMessage(
      threadId: string,
      role: "user" | "assistant",
      content: string,
    ): Promise<void>;
    listThreads(): Promise<
      Array<{ threadId: string; title: string; createdAt: string; status: string }>
    >;

    // Approvals
    createApproval(options: {
      title: string;
      description: string;
      toolName: string;
      toolArgs?: Record<string, any>;
      riskLevel: "low" | "medium" | "high" | "critical";
      jobId?: string;
      timeoutMinutes?: number;
    }): Promise<string>;
    getApproval(
      approvalId: string,
    ): Promise<{ status: string; resolvedBy?: string; rejectionReason?: string } | null>;
    resolveApproval(
      approvalId: string,
      decision: "approved" | "rejected",
      resolvedBy?: string,
      rejectionReason?: string,
    ): Promise<void>;
  }
}

// ─── Context & System ──────────────────────────────────────────────

VaultClient.prototype.getAgentContext = async function () {
  const readSystem = (name: string): string => {
    const fp = this.resolve("_system", `${name}.md`);
    if (!fs.existsSync(fp)) return "";
    return this.readMdFile(fp).content;
  };

  const pinnedNotes = await this.getPinnedNotes();

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
};

VaultClient.prototype.getPinnedNotes = async function () {
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
};

// ─── Settings ──────────────────────────────────────────────────────

VaultClient.prototype.getSetting = async function (key) {
  const ctx = await this.getAgentContext();
  return ctx.config[key] ?? null;
};

VaultClient.prototype.setSetting = async function (key, value) {
  const filePath = this.resolve("_system", "CONFIG.md");
  const raw = fs.readFileSync(filePath, "utf-8");

  const keyPattern = new RegExp(`\\|\\s*${key}\\s*\\|[^|]*\\|`);
  if (keyPattern.test(raw)) {
    const updated = raw.replace(keyPattern, `| ${key} | ${value} |`);
    fs.writeFileSync(filePath, updated, "utf-8");
  } else {
    const lines = raw.split("\n");
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
};

// ─── Threads ───────────────────────────────────────────────────────

VaultClient.prototype.createThread = async function (title) {
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
};

VaultClient.prototype.appendMessage = async function (threadId, role, content) {
  const filePath = this.resolve("_threads/active", `${threadId}.md`);
  if (!fs.existsSync(filePath)) {
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
};

VaultClient.prototype.listThreads = async function () {
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
};

// ─── Approvals ─────────────────────────────────────────────────────

VaultClient.prototype.createApproval = async function (options) {
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
};

VaultClient.prototype.getApproval = async function (approvalId) {
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
};

VaultClient.prototype.resolveApproval = async function (approvalId, decision, resolvedBy, rejectionReason) {
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

  const filename = path.basename(found);
  const dest = this.resolve("_approvals/resolved", filename);
  fs.renameSync(found, dest);
};
