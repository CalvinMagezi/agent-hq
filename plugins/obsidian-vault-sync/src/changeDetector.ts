/**
 * ChangeDetector — Hooks into Obsidian vault events to detect local file changes.
 *
 * Debounces rapid changes (300ms) and computes SHA-256 hashes via WebCrypto.
 * Produces SyncChangeEntry objects ready for the sync transport.
 */

import type { App, TFile, EventRef } from "obsidian";
import type { SyncChangeEntry } from "@repo/vault-sync-protocol";
import { hashContent, IGNORE_PATTERNS } from "@repo/vault-sync-protocol";

export type ChangeCallback = (change: SyncChangeEntry) => void;

export class ChangeDetector {
  private eventRefs: EventRef[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
  private callback: ChangeCallback | null = null;
  private deviceId: string;
  private changeCounter = 0;
  /** Paths being written by remote sync — suppress re-detection */
  private suppressedPaths = new Set<string>();

  constructor(
    private app: App,
    deviceId: string,
    debounceMs = 300,
  ) {
    this.deviceId = deviceId;
    this.debounceMs = debounceMs;
  }

  /**
   * Start listening for vault events.
   */
  start(callback: ChangeCallback): void {
    this.callback = callback;

    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        if (file instanceof Object && "extension" in file) {
          this.handleChange(file as TFile, "create");
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof Object && "extension" in file) {
          this.handleChange(file as TFile, "modify");
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        if (file instanceof Object && "extension" in file) {
          this.handleDelete(file as TFile);
        }
      }),
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof Object && "extension" in file) {
          this.handleRename(file as TFile, oldPath);
        }
      }),
    );
  }

  /**
   * Stop listening for vault events.
   */
  stop(): void {
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.callback = null;
  }

  /**
   * Suppress change detection for a path (during remote file write).
   */
  suppressPath(path: string): void {
    this.suppressedPaths.add(path);
  }

  /**
   * Un-suppress a path.
   */
  unsuppressPath(path: string): void {
    this.suppressedPaths.delete(path);
  }

  // ─── Internal Handlers ────────────────────────────────────

  private handleChange(file: TFile, type: "create" | "modify"): void {
    if (!this.shouldSync(file.path)) return;
    if (this.suppressedPaths.has(file.path)) return;

    this.debounce(file.path, async () => {
      try {
        const content = await this.app.vault.read(file);
        const contentHash = await hashContent(content);

        this.emitChange({
          changeId: ++this.changeCounter,
          path: file.path,
          changeType: type,
          contentHash,
          size: content.length,
          mtime: file.stat.mtime,
          detectedAt: Date.now(),
          deviceId: this.deviceId,
        });
      } catch {
        // File may have been deleted between event and read
      }
    });
  }

  private handleDelete(file: TFile): void {
    if (!this.shouldSync(file.path)) return;
    if (this.suppressedPaths.has(file.path)) return;

    // No debounce for deletes — they're rare and important
    this.emitChange({
      changeId: ++this.changeCounter,
      path: file.path,
      changeType: "delete",
      contentHash: null,
      size: null,
      mtime: null,
      detectedAt: Date.now(),
      deviceId: this.deviceId,
    });
  }

  private handleRename(file: TFile, oldPath: string): void {
    if (!this.shouldSync(file.path) && !this.shouldSync(oldPath)) return;
    if (this.suppressedPaths.has(file.path)) return;

    this.debounce(file.path, async () => {
      try {
        const content = await this.app.vault.read(file);
        const contentHash = await hashContent(content);

        this.emitChange({
          changeId: ++this.changeCounter,
          path: file.path,
          oldPath,
          changeType: "rename",
          contentHash,
          size: content.length,
          mtime: file.stat.mtime,
          detectedAt: Date.now(),
          deviceId: this.deviceId,
        });
      } catch {
        // File may have been deleted
      }
    });
  }

  // ─── Helpers ──────────────────────────────────────────────

  private shouldSync(path: string): boolean {
    // Only sync markdown files
    if (!path.endsWith(".md")) return false;

    // Check ignore patterns
    for (const pattern of IGNORE_PATTERNS) {
      if (path.includes(pattern)) return false;
    }

    return true;
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        fn();
      }, this.debounceMs),
    );
  }

  private emitChange(change: SyncChangeEntry): void {
    if (this.callback) {
      this.callback(change);
    }
  }
}
