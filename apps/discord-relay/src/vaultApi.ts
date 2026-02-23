/**
 * VaultAPI — Drop-in replacement for ConvexAPI in the Discord relay.
 *
 * Reads/writes directly to the Obsidian vault filesystem instead of
 * calling Convex HTTP endpoints. Same API surface as convex.ts.
 */

import { VaultClient } from "@repo/vault-client";
import { SearchClient } from "@repo/vault-client/search";
import type { RelayConfig, ConvexNote, MemoryFact, DelegatedTask } from "./types.js";
import * as path from "path";
import * as fs from "fs";

/** Type alias so other relay modules can import { ConvexAPI } from vaultApi */
export type ConvexAPI = VaultAPI;

export interface SystemStatus {
  daemon: {
    startedAt: string | null;
    lastUpdated: string | null;
    pid: number | null;
    apiKeys: Record<string, boolean>;
  } | null;
  workflows: Record<string, {
    lastRun: string;
    success: boolean;
    lastSuccess: string | null;
    lastError: string | null;
  }> | null;
  heartbeat: { lastProcessed: string | null };
  workers: Array<{ workerId: string; status: string; lastHeartbeat: string | null }>;
  relays: Array<{
    displayName: string;
    relayId: string;
    status: string;
    lastHeartbeat: string | null;
    tasksCompleted: number;
    tasksFailed: number;
  }>;
}

export class VaultAPI {
  private vault: VaultClient;
  private search: SearchClient | null = null;

  constructor(config: RelayConfig) {
    // Resolve vault path — defaults to .vault/ at repo root
    const vaultPath =
      config.vaultPath ??
      path.resolve(import.meta.dir, "../../../.vault");

    this.vault = new VaultClient(vaultPath);

    try {
      this.search = new SearchClient(vaultPath);
    } catch {
      console.warn("[VaultAPI] Search index not available.");
    }
  }

  /** Search notes using keyword search (semantic if search index available) */
  async searchNotes(query: string, limit: number = 5): Promise<ConvexNote[]> {
    try {
      const results = await this.vault.searchNotes(query, limit);
      return results.map((r) => ({
        noteId: r.noteId,
        title: r.title,
        content: r.snippet,
        tags: r.tags,
        notebook: r.notebook,
      }));
    } catch (err: any) {
      console.warn("[VaultAPI] Search error:", err.message);
      return [];
    }
  }

  /** Get pinned notes for persistent context */
  async getPinnedNotes(): Promise<ConvexNote[]> {
    try {
      const notes = await this.vault.getPinnedNotes();
      return notes.map((n) => ({
        noteId: n._filePath,
        title: n.title,
        content: n.content,
        tags: n.tags,
      }));
    } catch (err: any) {
      console.warn("[VaultAPI] Pinned notes error:", err.message);
      return [];
    }
  }

  /** Get stored memory facts from the MEMORY.md system file */
  async getMemoryFacts(): Promise<MemoryFact[]> {
    try {
      const ctx = await this.vault.getAgentContext();
      const memory = ctx.memory;
      if (!memory) return [];

      // Parse memory sections
      const facts: MemoryFact[] = [];
      const factSection = memory.match(/## Key Facts\s*\n([\s\S]*?)(?=\n##|$)/);
      if (factSection) {
        const lines = factSection[1].split("\n").filter((l) => /^-\s+/.test(l));
        for (const line of lines) {
          facts.push({
            type: "fact",
            content: line.replace(/^-\s+/, "").trim(),
            createdAt: 0,
          });
        }
      }

      const goalSection = memory.match(/## Active Goals\s*\n([\s\S]*?)(?=\n##|$)/);
      if (goalSection) {
        const lines = goalSection[1].split("\n").filter((l) => /^-\s+/.test(l));
        for (const line of lines) {
          facts.push({
            type: "goal",
            content: line.replace(/^-\s+/, "").trim(),
            createdAt: 0,
          });
        }
      }

      return facts;
    } catch (err: any) {
      console.warn("[VaultAPI] Memory error:", err.message);
      return [];
    }
  }

  /** Store a memory fact or goal by appending to MEMORY.md */
  async storeMemory(
    type: "fact" | "goal",
    content: string,
    _deadline?: string,
  ): Promise<void> {
    try {
      const section = type === "fact" ? "## Key Facts" : "## Active Goals";
      const memoryPath = path.resolve(this.vault.vaultPath, "_system/MEMORY.md");
      const raw = fs.readFileSync(memoryPath, "utf-8");

      const sectionIdx = raw.indexOf(section);
      if (sectionIdx === -1) {
        // Append new section
        fs.appendFileSync(memoryPath, `\n\n${section}\n\n- ${content}\n`);
      } else {
        // Find the next ## section or end of file
        const afterSection = raw.substring(sectionIdx + section.length);
        const nextSection = afterSection.indexOf("\n##");
        const insertPos =
          nextSection === -1
            ? raw.length
            : sectionIdx + section.length + nextSection;

        const before = raw.substring(0, insertPos);
        const after = raw.substring(insertPos);
        fs.writeFileSync(memoryPath, before + `\n- ${content}` + after, "utf-8");
      }
    } catch (err: any) {
      console.warn("[VaultAPI] Store memory error:", err.message);
    }
  }

  /** Mark a goal as completed by removing it from Active Goals */
  async completeGoal(searchText: string): Promise<void> {
    try {
      const memoryPath = path.resolve(this.vault.vaultPath, "_system/MEMORY.md");
      let raw = fs.readFileSync(memoryPath, "utf-8");
      const lines = raw.split("\n");
      const filtered = lines.filter(
        (line) => !(line.startsWith("- ") && line.toLowerCase().includes(searchText.toLowerCase())),
      );
      fs.writeFileSync(memoryPath, filtered.join("\n"), "utf-8");
    } catch (err: any) {
      console.warn("[VaultAPI] Complete goal error:", err.message);
    }
  }

  /** Get recent messages for a channel from Discord Memory folder */
  async getRecentMessages(
    channelId: string,
    limit: number = 10,
  ): Promise<Array<{ role: string; content: string; timestamp: number }>> {
    try {
      const messagesDir = path.resolve(
        this.vault.vaultPath,
        "Notebooks/Discord Memory",
      );
      const channelFile = path.join(messagesDir, `channel-${channelId}.md`);

      if (!fs.existsSync(channelFile)) return [];

      const raw = fs.readFileSync(channelFile, "utf-8");
      const messages: Array<{ role: string; content: string; timestamp: number }> = [];

      // Parse message sections
      const msgRegex = /## (\w+) \(([^)]+)\)\s*\n([\s\S]*?)(?=\n## |$)/g;
      let match;
      while ((match = msgRegex.exec(raw)) !== null) {
        messages.push({
          role: match[1].toLowerCase(),
          content: match[3].trim(),
          timestamp: new Date(match[2]).getTime(),
        });
      }

      return messages.slice(-limit);
    } catch (err: any) {
      console.warn("[VaultAPI] Recent messages error:", err.message);
      return [];
    }
  }

  /** Send agent heartbeat by updating relay health file */
  async sendHeartbeat(
    workerId: string,
    status: "online" | "busy" | "offline",
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.vault.upsertRelayHealth(workerId, {
        status: status === "online" ? "healthy" : status === "busy" ? "degraded" : "offline",
        lastHeartbeat: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn("[VaultAPI] Heartbeat error:", err.message);
    }
  }

  /** Save a message to channel history */
  async saveMessage(
    role: string,
    content: string,
    channelId: string,
  ): Promise<void> {
    try {
      const messagesDir = path.resolve(
        this.vault.vaultPath,
        "Notebooks/Discord Memory",
      );
      if (!fs.existsSync(messagesDir)) {
        fs.mkdirSync(messagesDir, { recursive: true });
      }

      const channelFile = path.join(messagesDir, `channel-${channelId}.md`);
      const timestamp = new Date().toISOString();
      const entry = `\n## ${role} (${timestamp})\n\n${content}\n`;

      if (!fs.existsSync(channelFile)) {
        fs.writeFileSync(
          channelFile,
          `---\nchannelId: "${channelId}"\n---\n# Channel ${channelId}\n${entry}`,
          "utf-8",
        );
      } else {
        fs.appendFileSync(channelFile, entry, "utf-8");
      }
    } catch (err: any) {
      console.warn("[VaultAPI] Save message error:", err.message);
    }
  }

  // ── Delegation API ────────────────────────────────────────────────

  /** Get pending delegated tasks for this relay bot */
  async getPendingDelegations(
    relayId: string,
    harnessType: string,
  ): Promise<DelegatedTask[]> {
    try {
      const tasks = await this.vault.getPendingTasks(harnessType);
      return tasks.map((t) => ({
        _id: t.taskId,
        taskId: t.taskId,
        jobId: t.jobId,
        instruction: t.instruction,
        targetHarnessType: t.targetHarnessType,
        status: t.status,
        priority: t.priority,
        modelOverride: undefined as string | undefined,
        dependsOn: t.dependsOn,
        createdAt: Date.now(),
      }));
    } catch {
      return [];
    }
  }

  /** Claim a pending delegated task */
  async claimDelegation(
    taskId: string,
    relayId: string,
  ): Promise<boolean> {
    try {
      return await this.vault.claimTask(taskId, relayId);
    } catch (err: any) {
      console.warn("[VaultAPI] Claim delegation error:", err.message);
      return false;
    }
  }

  /** Update a delegated task status */
  async updateDelegation(
    taskId: string,
    status: "running" | "completed" | "failed" | "cancelled" | "timeout",
    result?: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.vault.updateTaskStatus(taskId, status, result, error);
    } catch (err: any) {
      console.warn("[VaultAPI] Update delegation error:", err.message);
    }
  }

  /** Update relay health with capabilities */
  async updateRelayHealth(
    relayId: string,
    harnessType: string,
    displayName: string,
    capabilities: string[],
  ): Promise<void> {
    try {
      await this.vault.upsertRelayHealth(relayId, {
        harnessType,
        displayName,
        capabilities,
        status: "healthy",
      });
    } catch (err: any) {
      console.warn("[VaultAPI] Update relay health error:", err.message);
    }
  }

  /** Get comprehensive system status for the !hq status command */
  async getSystemStatus(): Promise<SystemStatus> {
    const matter = await import("gray-matter").then((m) => m.default);
    const vaultPath = this.vault.vaultPath;

    // Read DAEMON-STATUS.md
    let daemon: SystemStatus["daemon"] = null;
    try {
      const statusPath = path.join(vaultPath, "_system/DAEMON-STATUS.md");
      if (fs.existsSync(statusPath)) {
        const { data } = matter(fs.readFileSync(statusPath, "utf-8"));
        daemon = {
          startedAt: data.daemonStartedAt ?? null,
          lastUpdated: data.lastUpdated ?? null,
          pid: data.pid ?? null,
          apiKeys: data.apiKeys ?? {},
        };
      }
    } catch { /* skip */ }

    // Read WORKFLOW-STATUS.md
    let workflows: SystemStatus["workflows"] = null;
    try {
      const wfPath = path.join(vaultPath, "_system/WORKFLOW-STATUS.md");
      if (fs.existsSync(wfPath)) {
        const { data } = matter(fs.readFileSync(wfPath, "utf-8"));
        workflows = data.workflows ?? null;
      }
    } catch { /* skip */ }

    // Read HEARTBEAT.md
    const heartbeat: SystemStatus["heartbeat"] = { lastProcessed: null };
    try {
      const hbPath = path.join(vaultPath, "_system/HEARTBEAT.md");
      if (fs.existsSync(hbPath)) {
        const { data } = matter(fs.readFileSync(hbPath, "utf-8"));
        heartbeat.lastProcessed = data.lastProcessed ?? null;
      }
    } catch { /* skip */ }

    // Read worker sessions
    const workers: SystemStatus["workers"] = [];
    try {
      const sessionsDir = path.join(vaultPath, "_agent-sessions");
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter((f) => f.startsWith("worker-") && f.endsWith(".md"));
        for (const file of files) {
          const { data } = matter(fs.readFileSync(path.join(sessionsDir, file), "utf-8"));
          workers.push({
            workerId: data.workerId ?? file.replace(".md", ""),
            status: data.status ?? "unknown",
            lastHeartbeat: data.lastHeartbeat ?? null,
          });
        }
      }
    } catch { /* skip */ }

    // Read relay health
    const relays: SystemStatus["relays"] = [];
    try {
      const relayHealth = await this.vault.getRelayHealthAll();
      for (const r of relayHealth) {
        relays.push({
          displayName: r.displayName ?? r.relayId,
          relayId: r.relayId,
          status: r.status ?? "unknown",
          lastHeartbeat: r.lastHeartbeat ?? null,
          tasksCompleted: r.tasksCompleted ?? 0,
          tasksFailed: r.tasksFailed ?? 0,
        });
      }
    } catch { /* skip */ }

    return { daemon, workflows, heartbeat, workers, relays };
  }
}
