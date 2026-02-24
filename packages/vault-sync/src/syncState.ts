/**
 * SyncState — Tracks the known state of every file in the vault.
 *
 * On startup, the FullScanner compares the current filesystem state
 * against SyncState to detect changes that occurred while offline.
 *
 * Every file version is tagged with a deviceId, enabling multi-device
 * sync and conflict resolution in the future.
 */

import { Database } from "bun:sqlite";
import type { FileVersion } from "./types";

export class SyncState {
  private getStateStmt;
  private upsertStateStmt;
  private deleteStateStmt;
  private insertVersionStmt;
  private getMaxVersionStmt;
  private getVersionHistoryStmt;
  private getAllPathsStmt;

  constructor(
    private db: Database,
    private deviceId: string,
  ) {
    this.getStateStmt = db.prepare(`
      SELECT path, content_hash, size, mtime, version, device_id, recorded_at
      FROM file_state WHERE path = $path
    `);

    this.upsertStateStmt = db.prepare(`
      INSERT INTO file_state (path, content_hash, size, mtime, version, device_id, recorded_at)
      VALUES ($path, $contentHash, $size, $mtime, $version, $deviceId, $recordedAt)
      ON CONFLICT(path) DO UPDATE SET
        content_hash = $contentHash,
        size = $size,
        mtime = $mtime,
        version = $version,
        device_id = $deviceId,
        recorded_at = $recordedAt
    `);

    this.deleteStateStmt = db.prepare(
      "DELETE FROM file_state WHERE path = $path",
    );

    this.insertVersionStmt = db.prepare(`
      INSERT OR REPLACE INTO file_versions (path, version, content_hash, size, mtime, device_id, recorded_at)
      VALUES ($path, $version, $contentHash, $size, $mtime, $deviceId, $recordedAt)
    `);

    this.getMaxVersionStmt = db.prepare(`
      SELECT MAX(version) as max_ver FROM file_versions WHERE path = $path
    `);

    this.getVersionHistoryStmt = db.prepare(`
      SELECT path, version, content_hash, size, mtime, device_id, recorded_at
      FROM file_versions
      WHERE path = $path
      ORDER BY version DESC
      LIMIT $limit
    `);

    this.getAllPathsStmt = db.prepare("SELECT path FROM file_state");
  }

  /** Get the current known state of a file. */
  getFileState(filePath: string): FileVersion | null {
    const row = this.getStateStmt.get({ $path: filePath }) as any | null;
    if (!row) return null;
    return this.rowToVersion(row);
  }

  /** Record a new version of a file. Returns the new version number. */
  recordVersion(
    filePath: string,
    contentHash: string,
    size: number,
    mtime: number,
  ): number {
    const now = Date.now();

    // Get next version number
    const maxRow = this.getMaxVersionStmt.get({ $path: filePath }) as {
      max_ver: number | null;
    } | null;
    const nextVersion = (maxRow?.max_ver ?? 0) + 1;

    // Update current state
    this.upsertStateStmt.run({
      $path: filePath,
      $contentHash: contentHash,
      $size: size,
      $mtime: mtime,
      $version: nextVersion,
      $deviceId: this.deviceId,
      $recordedAt: now,
    });

    // Record version history
    this.insertVersionStmt.run({
      $path: filePath,
      $version: nextVersion,
      $contentHash: contentHash,
      $size: size,
      $mtime: mtime,
      $deviceId: this.deviceId,
      $recordedAt: now,
    });

    return nextVersion;
  }

  /** Remove a file from state tracking (on delete). */
  removeFile(filePath: string): void {
    this.deleteStateStmt.run({ $path: filePath });
    // Keep version history for audit trail
  }

  /** Handle a rename: transfer current state to new path. */
  handleRename(oldPath: string, newPath: string): void {
    const current = this.getFileState(oldPath);
    if (!current) return;

    // Remove old state
    this.deleteStateStmt.run({ $path: oldPath });

    // Create state under new path
    this.upsertStateStmt.run({
      $path: newPath,
      $contentHash: current.contentHash,
      $size: current.size,
      $mtime: current.mtime,
      $version: current.version,
      $deviceId: current.deviceId,
      $recordedAt: Date.now(),
    });
  }

  /** Get all tracked file paths. Used for full scan diffing. */
  getAllPaths(): Set<string> {
    const rows = this.getAllPathsStmt.all() as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  /** Get version history for a file. */
  getVersionHistory(filePath: string, limit: number = 10): FileVersion[] {
    const rows = this.getVersionHistoryStmt.all({
      $path: filePath,
      $limit: limit,
    }) as any[];
    return rows.map((r) => this.rowToVersion(r));
  }

  /** Check if a file has changed vs. stored state using mtime + size as fast check. */
  hasChanged(filePath: string, mtime: number, size: number): boolean {
    const current = this.getFileState(filePath);
    if (!current) return true; // New file
    return current.mtime !== mtime || current.size !== size;
  }

  /** Get total number of tracked files. */
  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) as cnt FROM file_state")
      .get() as { cnt: number };
    return row.cnt;
  }

  private rowToVersion(row: any): FileVersion {
    return {
      path: row.path,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      version: row.version,
      recordedAt: row.recorded_at,
      deviceId: row.device_id,
    };
  }
}
