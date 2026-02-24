/**
 * FullScanner — Periodic safety-net scan of the entire vault.
 *
 * Compares the filesystem state against SyncState to find:
 * - Files created while the watcher was down
 * - Files modified but whose events were somehow missed
 * - Files deleted externally
 *
 * Uses mtime + size as a fast pre-filter before computing content hashes.
 * Designed to run every 1 hour (configurable) as a background task.
 */

import * as fs from "fs";
import * as path from "path";
import type { FileChange, VaultSyncConfig } from "./types";
import { SyncState } from "./syncState";
import {
  shouldIgnorePath,
  isMarkdownFile,
  computeContentHash,
  normalizeVaultPath,
} from "./utils";

export class FullScanner {
  private scanning = false;

  constructor(
    private vaultPath: string,
    private syncState: SyncState,
    private deviceId: string,
    private config: VaultSyncConfig,
  ) {}

  /** Whether a scan is currently in progress. */
  get isScanning(): boolean {
    return this.scanning;
  }

  /**
   * Perform a full scan. Returns detected changes.
   * Compares every .md file in the vault against SyncState.
   */
  async scan(): Promise<FileChange[]> {
    if (this.scanning) return [];
    this.scanning = true;

    try {
      const changes: FileChange[] = [];
      const trackedPaths = this.syncState.getAllPaths();
      const foundPaths = new Set<string>();

      // Walk the vault directory
      await this.walkDirectory(this.vaultPath, foundPaths, changes);

      // Detect deletions: paths in SyncState but not on disk
      for (const trackedPath of trackedPaths) {
        if (!foundPaths.has(trackedPath)) {
          changes.push({
            changeId: 0,
            path: trackedPath,
            type: "delete",
            contentHash: null,
            size: null,
            mtime: null,
            detectedAt: Date.now(),
            source: "scan",
            deviceId: this.deviceId,
          });
        }
      }

      return changes;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Recursively walk a directory, finding changed .md files.
   */
  private async walkDirectory(
    dirPath: string,
    foundPaths: Set<string>,
    changes: FileChange[],
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return; // Permission denied or deleted directory
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = normalizeVaultPath(fullPath, this.vaultPath);

      // Skip ignored paths early
      if (shouldIgnorePath(relativePath, this.config.ignorePatterns)) continue;

      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, foundPaths, changes);
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        foundPaths.add(relativePath);
        await this.checkFile(relativePath, fullPath, changes);
      }
    }
  }

  /**
   * Check a single file against SyncState.
   * Uses mtime + size as fast pre-filter, only hashes if they differ.
   */
  private async checkFile(
    relativePath: string,
    absolutePath: string,
    changes: FileChange[],
  ): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      return; // File disappeared
    }

    const mtime = stat.mtimeMs;
    const size = stat.size;

    // Fast check: has mtime or size changed?
    if (!this.syncState.hasChanged(relativePath, mtime, size)) {
      return; // No change
    }

    // Slow check: compute content hash
    try {
      const contentHash = await computeContentHash(absolutePath);
      const existing = this.syncState.getFileState(relativePath);

      // Skip if content hash is actually the same (mtime changed but content didn't)
      if (existing && existing.contentHash === contentHash) {
        return;
      }

      const changeType = existing ? "modify" : "create";

      changes.push({
        changeId: 0,
        path: relativePath,
        type: changeType,
        contentHash,
        size,
        mtime,
        detectedAt: Date.now(),
        source: "scan",
        deviceId: this.deviceId,
      });
    } catch {
      // Hash computation failed (file locked, permission denied, etc.)
    }
  }
}
