/**
 * ConflictHandler — Detects and resolves sync conflicts in the Obsidian plugin.
 *
 * When a remote change arrives for a file that was also locally modified,
 * this handler determines the resolution strategy and preserves both versions.
 */

import type { App } from "obsidian";
import type { SyncChangeEntry } from "@repo/vault-sync-protocol";
import { FileAdapter } from "./fileAdapter";
import type { VaultSyncSettings } from "./types";

export interface ConflictInfo {
  path: string;
  localHash: string;
  remoteHash: string;
  remoteDeviceId: string;
  detectedAt: number;
}

export class ConflictHandler {
  private fileAdapter: FileAdapter;
  private conflicts: ConflictInfo[] = [];

  constructor(
    private app: App,
    private settings: VaultSyncSettings,
  ) {
    this.fileAdapter = new FileAdapter(app);
  }

  /**
   * Check if applying a remote change would create a conflict.
   * Returns true if a conflict was detected and handled.
   */
  async checkAndResolve(
    change: SyncChangeEntry,
    localHash: string | null,
  ): Promise<{ isConflict: boolean; shouldApply: boolean }> {
    // No local file → no conflict
    if (!localHash) {
      return { isConflict: false, shouldApply: true };
    }

    // Same hash → already in sync
    if (localHash === change.contentHash) {
      return { isConflict: false, shouldApply: false };
    }

    // Different hash from different device → conflict
    if (change.deviceId !== this.settings.deviceId) {
      const conflict: ConflictInfo = {
        path: change.path,
        localHash,
        remoteHash: change.contentHash!,
        remoteDeviceId: change.deviceId,
        detectedAt: Date.now(),
      };

      return this.resolveConflict(conflict, change);
    }

    return { isConflict: false, shouldApply: true };
  }

  private async resolveConflict(
    conflict: ConflictInfo,
    change: SyncChangeEntry,
  ): Promise<{ isConflict: boolean; shouldApply: boolean }> {
    switch (this.settings.conflictStrategy) {
      case "newer-wins":
        return this.resolveNewerWins(conflict, change);
      case "merge-frontmatter":
        return this.resolveNewerWins(conflict, change); // Simplified for now
      case "manual":
        return this.deferToManual(conflict);
      default:
        return this.resolveNewerWins(conflict, change);
    }
  }

  /**
   * Newer mtime wins. The loser is preserved as a .sync-conflict-* file.
   */
  private async resolveNewerWins(
    conflict: ConflictInfo,
    change: SyncChangeEntry,
  ): Promise<{ isConflict: boolean; shouldApply: boolean }> {
    const localStat = await this.fileAdapter.getFileStat(conflict.path);
    const localMtime = localStat?.mtime ?? 0;
    const remoteMtime = change.mtime ?? 0;

    if (remoteMtime >= localMtime) {
      // Remote wins — preserve local as conflict copy
      await this.preserveLoserCopy(
        conflict.path,
        this.settings.deviceId ?? "local",
      );
      return { isConflict: true, shouldApply: true };
    } else {
      // Local wins — preserve remote (don't apply it)
      // The remote content will be requested and saved as a conflict copy
      this.conflicts.push(conflict);
      return { isConflict: true, shouldApply: false };
    }
  }

  /**
   * Defer to manual resolution — preserve both copies and let user decide.
   */
  private async deferToManual(
    conflict: ConflictInfo,
  ): Promise<{ isConflict: boolean; shouldApply: boolean }> {
    await this.preserveLoserCopy(
      conflict.path,
      conflict.remoteDeviceId,
    );
    this.conflicts.push(conflict);
    return { isConflict: true, shouldApply: false };
  }

  /**
   * Copy the current file to a .sync-conflict-* name.
   */
  private async preserveLoserCopy(
    filePath: string,
    deviceId: string,
  ): Promise<string> {
    const content = await this.fileAdapter.readFile(filePath);
    if (!content) return filePath;

    const ext = filePath.endsWith(".md") ? ".md" : "";
    const base = ext ? filePath.slice(0, -ext.length) : filePath;
    const timestamp = this.formatTimestamp(Date.now());
    const conflictPath = `${base}.sync-conflict-${timestamp}-${deviceId.slice(0, 8)}${ext}`;

    await this.fileAdapter.writeFile(conflictPath, content);
    return conflictPath;
  }

  private formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /**
   * Get list of unresolved conflicts.
   */
  getConflicts(): ConflictInfo[] {
    return [...this.conflicts];
  }

  /**
   * Clear resolved conflicts.
   */
  clearConflict(path: string): void {
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
  }

  get conflictCount(): number {
    return this.conflicts.length;
  }
}
