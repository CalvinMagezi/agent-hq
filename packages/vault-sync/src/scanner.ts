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
  hashFilesParallel,
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

      const candidates: Array<{ relativePath: string; absolutePath: string; mtime: number; size: number; existing: any }> = [];

      // 1. Walk the vault directory to find candidates for hashing
      await this.collectCandidates(this.vaultPath, foundPaths, candidates);

      // 2. Batch hash all candidates in parallel
      if (candidates.length > 0) {
        const absolutePaths = candidates.map(c => c.absolutePath);
        const hashes = await hashFilesParallel(absolutePaths);

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          const contentHash = hashes[i];

          if (!contentHash) continue; // Skip if hash failed

          // Skip if content hash is actually the same (mtime changed but content didn't)
          if (candidate.existing && candidate.existing.contentHash === contentHash) {
            continue;
          }

          const changeType = candidate.existing ? "modify" : "create";
          changes.push({
            changeId: 0,
            path: candidate.relativePath,
            type: changeType,
            contentHash,
            size: candidate.size,
            mtime: candidate.mtime,
            detectedAt: Date.now(),
            source: "scan",
            deviceId: this.deviceId,
          });
        }
      }

      // 3. Detect deletions: paths in SyncState but not on disk
      this.detectDeletions(trackedPaths, foundPaths, changes);

      return changes;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Detect deletions: paths in SyncState but not on disk
   */
  private detectDeletions(trackedPaths: Set<string>, foundPaths: Set<string>, changes: FileChange[]): void {
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
  }

  /**
   * Recursively walk a directory, collecting candidate .md files for hashing.
   */
  private async collectCandidates(
    dirPath: string,
    foundPaths: Set<string>,
    candidates: Array<{ relativePath: string; absolutePath: string; mtime: number; size: number; existing: any }>,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = normalizeVaultPath(fullPath, this.vaultPath);

      if (shouldIgnorePath(relativePath, this.config.ignorePatterns)) continue;

      if (entry.isDirectory()) {
        await this.collectCandidates(fullPath, foundPaths, candidates);
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        foundPaths.add(relativePath);
        
        // Fast pre-filter
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        const mtime = stat.mtimeMs;
        const size = stat.size;

        if (this.syncState.hasChanged(relativePath, mtime, size)) {
          const existing = this.syncState.getFileState(relativePath);
          candidates.push({ relativePath, absolutePath: fullPath, mtime, size, existing });
        }
      }
    }
  }
}
