/**
 * LockManager — Advisory file-level locks using SQLite.
 *
 * Addresses the non-atomic read-modify-write problem in VaultClient.
 * All writers should acquire a lock before modifying vault files.
 *
 * External writers (Obsidian, git) bypass this — conflicts from
 * external modifications are handled by ConflictResolver.
 *
 * Lock TTL: 30 seconds (auto-expires to prevent deadlocks).
 * Storage: SQLite table in the sync database.
 */

import { Database } from "bun:sqlite";
import type { FileLock } from "./types";

const DEFAULT_TTL_MS = 30_000;

export class LockManager {
  private acquireStmt;
  private releaseStmt;
  private checkStmt;
  private cleanupStmt;

  constructor(
    private db: Database,
    private holderId: string,
  ) {
    this.acquireStmt = db.prepare(`
      INSERT INTO locks (path, holder, acquired_at, expires_at)
      VALUES ($path, $holder, $acquiredAt, $expiresAt)
      ON CONFLICT(path) DO UPDATE SET
        holder = $holder,
        acquired_at = $acquiredAt,
        expires_at = $expiresAt
      WHERE locks.expires_at < $now OR locks.holder = $holder
    `);

    this.releaseStmt = db.prepare(
      "DELETE FROM locks WHERE path = $path AND holder = $holder",
    );

    this.checkStmt = db.prepare(
      "SELECT path, holder, acquired_at, expires_at FROM locks WHERE path = $path AND expires_at >= $now",
    );

    this.cleanupStmt = db.prepare(
      "DELETE FROM locks WHERE expires_at < $now",
    );
  }

  /**
   * Acquire a lock on a file path.
   * Returns true if acquired, false if held by another holder.
   */
  acquire(filePath: string, ttlMs: number = DEFAULT_TTL_MS): boolean {
    const now = Date.now();
    const result = this.acquireStmt.run({
      $path: filePath,
      $holder: this.holderId,
      $acquiredAt: now,
      $expiresAt: now + ttlMs,
      $now: now,
    });
    return result.changes > 0;
  }

  /** Release a lock. */
  release(filePath: string): void {
    this.releaseStmt.run({
      $path: filePath,
      $holder: this.holderId,
    });
  }

  /** Check if a path is currently locked. */
  isLocked(filePath: string): FileLock | null {
    const row = this.checkStmt.get({
      $path: filePath,
      $now: Date.now(),
    }) as any | null;

    if (!row) return null;
    return {
      path: row.path,
      holder: row.holder,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Execute a callback while holding a lock.
   * Auto-releases on completion or error.
   */
  async withLock<T>(
    filePath: string,
    fn: () => T | Promise<T>,
    ttlMs: number = DEFAULT_TTL_MS,
  ): Promise<T> {
    if (!this.acquire(filePath, ttlMs)) {
      const existing = this.isLocked(filePath);
      throw new Error(
        `Failed to acquire lock on ${filePath} (held by ${existing?.holder ?? "unknown"})`,
      );
    }
    try {
      return await fn();
    } finally {
      this.release(filePath);
    }
  }

  /** Clean up expired locks. Returns count of locks removed. */
  cleanupExpired(): number {
    const result = this.cleanupStmt.run({ $now: Date.now() });
    return result.changes;
  }

  /** Get all active locks. */
  getActiveLocks(): FileLock[] {
    const rows = this.db
      .query(
        "SELECT path, holder, acquired_at, expires_at FROM locks WHERE expires_at >= $now",
      )
      .all({ $now: Date.now() }) as any[];

    return rows.map((r) => ({
      path: r.path,
      holder: r.holder,
      acquiredAt: r.acquired_at,
      expiresAt: r.expires_at,
    }));
  }
}
