/**
 * VaultBridge — VaultClient + SyncedVaultClient integration for the relay server.
 *
 * Provides a unified interface to read/write vault data and subscribe
 * to real-time change events via VaultSync.
 */

import { VaultClient } from "@repo/vault-client";
import type { Job } from "@repo/vault-client";

export class VaultBridge {
  private vault: VaultClient;
  private syncClient: any = null;
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.vault = new VaultClient(vaultPath);
  }

  get client(): VaultClient {
    return this.vault;
  }

  get vaultDir(): string {
    return this.vaultPath;
  }

  /**
   * Initialize the sync engine for event-driven change detection.
   */
  async initSync(): Promise<void> {
    try {
      const { SyncedVaultClient } = await import("@repo/vault-sync");
      const syncedVault = new SyncedVaultClient(this.vaultPath);
      await syncedVault.startSync();
      this.syncClient = syncedVault;
      this.vault = syncedVault;
      console.log("[vault-bridge] Vault sync engine initialized");
    } catch (err) {
      console.warn("[vault-bridge] Sync engine not available, using polling:", err);
    }
  }

  async stopSync(): Promise<void> {
    if (this.syncClient?.stopSync) {
      await this.syncClient.stopSync();
    }
  }

  /**
   * Subscribe to VaultSync events. Returns unsubscribe function.
   * Falls back to a no-op if sync engine is unavailable.
   */
  on(event: string, handler: (data?: any) => void): () => void {
    if (this.syncClient?.on) {
      return this.syncClient.on(event, handler);
    }
    return () => {};
  }

  // ─── Job Operations ─────────────────────────────────────────

  async createJob(opts: {
    instruction: string;
    type?: "background" | "rpc" | "interactive";
    priority?: number;
    securityProfile?: string;
    modelOverride?: string;
    threadId?: string;
  }): Promise<string> {
    return this.vault.createJob({
      instruction: opts.instruction,
      type: opts.type ?? "background",
      priority: opts.priority ?? 50,
      securityProfile: (opts.securityProfile ?? "standard") as any,
      modelOverride: opts.modelOverride,
    });
  }

  async getJob(jobId: string): Promise<Job | null> {
    // Search all status dirs
    const { VaultClient: VC } = await import("@repo/vault-client");
    const vc = new VC(this.vaultPath) as any;
    return vc.getJob?.({ jobId }) ?? null;
  }

  async getSystemStatus(): Promise<{
    pendingJobs: number;
    runningJobs: number;
    agentOnline: boolean;
  }> {
    const fs = await import("fs");
    const path = await import("path");

    const countFiles = (dir: string): number => {
      try {
        return fs.readdirSync(dir).filter((f: string) => f.endsWith(".md")).length;
      } catch {
        return 0;
      }
    };

    const pendingJobs = countFiles(path.join(this.vaultPath, "_jobs/pending"));
    const runningJobs = countFiles(path.join(this.vaultPath, "_jobs/running"));

    // Check if agent heartbeat is recent (within last 2 minutes)
    let agentOnline = false;
    try {
      const heartbeatPath = path.join(this.vaultPath, "_system/HEARTBEAT.md");
      if (fs.existsSync(heartbeatPath)) {
        const stat = fs.statSync(heartbeatPath);
        agentOnline = Date.now() - stat.mtimeMs < 2 * 60 * 1000;
      }
    } catch {
      // Ignore
    }

    return { pendingJobs, runningJobs, agentOnline };
  }

  // ─── Note/Thread Operations ─────────────────────────────────

  async searchNotes(query: string, limit = 10) {
    return this.vault.searchNotes(query, limit);
  }

  async listThreads() {
    return this.vault.listThreads();
  }

  async getAgentContext() {
    return this.vault.getAgentContext();
  }

  // ─── Delegation Operations ───────────────────────────────────

  async createDelegationTask(opts: {
    taskId: string;
    jobId: string;
    instruction: string;
    targetHarnessType: "gemini-cli" | "claude-code" | "any";
  }): Promise<void> {
    await this.vault.createDelegatedTasks(opts.jobId, [
      {
        taskId: opts.taskId,
        instruction: opts.instruction,
        targetHarnessType: opts.targetHarnessType,
        priority: 60,
        deadlineMs: 5 * 60 * 1000, // 5 min
      },
    ]);
  }

  getDelegationResult(taskId: string): string | null {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    // Check _delegation/completed/
    const completedDir = path.join(this.vaultPath, "_delegation/completed");
    try {
      const files = fs.readdirSync(completedDir);
      const match = files.find((f: string) => f.includes(taskId));
      if (match) {
        const content = fs.readFileSync(path.join(completedDir, match), "utf-8");
        // Strip YAML frontmatter and return body
        const lines = content.split("\n");
        const fmEnd = lines.findIndex((l: string, i: number) => i > 0 && l.trim() === "---");
        return fmEnd > 0 ? lines.slice(fmEnd + 1).join("\n").trim() : content.trim();
      }
    } catch {
      // Dir may not exist yet
    }

    // Also check _delegation/results/ for overflow results
    return this.vault.readFullResult(taskId);
  }
}
