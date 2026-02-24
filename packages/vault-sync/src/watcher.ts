/**
 * FileWatcher — Hybrid filesystem change detection.
 *
 * Primary: fs.watch in recursive mode (macOS FSEvents, Linux inotify).
 * Each raw event goes through:
 *   1. Ignore filter (skip .obsidian/, _embeddings/, .git/, etc.)
 *   2. Markdown filter (only .md files)
 *   3. Per-path debounce (300ms) — collapses rapid save events
 *   4. Stability check (1000ms) — waits for writes to finish
 *   5. Content hashing + FileChange emission
 *
 * Safety net: FullScanner runs periodically to catch any missed events.
 */

import { watch, type FSWatcher } from "fs";
import * as fs from "fs";
import * as path from "path";
import type { FileChange, VaultSyncConfig } from "./types";
import {
  shouldIgnorePath,
  isMarkdownFile,
  computeContentHash,
  normalizeVaultPath,
  safeStatSync,
} from "./utils";

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;
  private debounceMs: number;
  private stabilityMs: number;

  constructor(
    private config: VaultSyncConfig,
    private onChanges: (changes: FileChange[]) => void,
  ) {
    this.debounceMs = config.debounceMs ?? 300;
    this.stabilityMs = config.stabilityMs ?? 1000;
  }

  /** Start watching the vault. Returns a cleanup function. */
  start(): () => void {
    this.running = true;

    try {
      this.watcher = watch(
        this.config.vaultPath,
        { recursive: true },
        (eventType, filename) => {
          if (!filename || !this.running) return;
          this.handleRawEvent(eventType, filename as string);
        },
      );

      this.watcher.on("error", (err) => {
        if (this.config.debug) {
          console.error("[vault-sync:watcher] Error:", err.message);
        }
      });
    } catch (err: any) {
      console.error("[vault-sync:watcher] Failed to start:", err.message);
    }

    return () => this.stop();
  }

  /** Stop watching and clean up all timers. */
  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Whether the watcher is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle a raw fs.watch event. Applies ignore + debounce.
   */
  private handleRawEvent(eventType: string, relativePath: string): void {
    // Normalize path separators
    const normalized = relativePath.split(path.sep).join("/");

    // Filter: skip ignored paths
    if (shouldIgnorePath(normalized, this.config.ignorePatterns)) return;

    // Filter: only .md files
    if (!isMarkdownFile(normalized)) return;

    // Debounce: collapse rapid events on same path
    const existing = this.debounceTimers.get(normalized);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      normalized,
      setTimeout(() => {
        this.debounceTimers.delete(normalized);
        this.checkStability(normalized);
      }, this.debounceMs),
    );
  }

  /**
   * After debounce, wait for mtime to stabilize before processing.
   * This handles Obsidian's multi-step save (write temp → rename).
   */
  private checkStability(relativePath: string): void {
    const absPath = path.join(this.config.vaultPath, relativePath);
    const initialStat = safeStatSync(absPath);

    // If file doesn't exist, it was deleted
    if (!initialStat) {
      this.emitChange(relativePath, "delete");
      return;
    }

    const initialMtime = initialStat.mtimeMs;

    // Wait for stability
    setTimeout(async () => {
      if (!this.running) return;

      const finalStat = safeStatSync(absPath);

      // Deleted during stability window
      if (!finalStat) {
        this.emitChange(relativePath, "delete");
        return;
      }

      // If mtime changed during stability window, recheck
      if (finalStat.mtimeMs !== initialMtime) {
        this.checkStability(relativePath);
        return;
      }

      // File is stable — compute hash and emit
      try {
        const contentHash = await computeContentHash(absPath);
        this.emitChange(relativePath, "modify", {
          contentHash,
          size: finalStat.size,
          mtime: finalStat.mtimeMs,
        });
      } catch (err: any) {
        if (this.config.debug) {
          console.error(
            `[vault-sync:watcher] Hash failed for ${relativePath}:`,
            err.message,
          );
        }
      }
    }, this.stabilityMs);
  }

  /**
   * Build and emit a FileChange through the callback.
   */
  private emitChange(
    relativePath: string,
    type: "modify" | "delete",
    data?: { contentHash: string; size: number; mtime: number },
  ): void {
    const change: FileChange = {
      changeId: 0, // Will be set by ChangeLog
      path: relativePath,
      type: type === "modify" ? "modify" : "delete",
      contentHash: data?.contentHash ?? null,
      size: data?.size ?? null,
      mtime: data?.mtime ?? null,
      detectedAt: Date.now(),
      source: "watcher",
      deviceId: this.config.deviceId ?? "unknown",
    };

    this.onChanges([change]);
  }
}
