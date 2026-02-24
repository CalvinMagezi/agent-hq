/**
 * ChangeLog — Append-only journal of vault file changes.
 *
 * Every detected change is persisted before processing, ensuring
 * guaranteed delivery. Consumers use cursors (changeId watermarks)
 * to track what they've processed. If a consumer crashes, it resumes
 * from its last cursor position.
 *
 * This journal also serves as the foundation for future P2P sync —
 * it IS the replication log.
 */

import { Database } from "bun:sqlite";
import type { FileChange, ChangeType } from "./types";

export class ChangeLog {
  private insertStmt;
  private getAfterStmt;
  private getLatestStmt;
  private getCursorStmt;
  private upsertCursorStmt;

  constructor(private db: Database) {
    // Prepare statements for performance
    this.insertStmt = db.prepare(`
      INSERT INTO changes (path, old_path, type, content_hash, size, mtime, detected_at, source, device_id)
      VALUES ($path, $oldPath, $type, $contentHash, $size, $mtime, $detectedAt, $source, $deviceId)
    `);

    this.getAfterStmt = db.prepare(`
      SELECT change_id, path, old_path, type, content_hash, size, mtime, detected_at, source, device_id
      FROM changes
      WHERE change_id > $afterId
      ORDER BY change_id ASC
      LIMIT $limit
    `);

    this.getLatestStmt = db.prepare(`
      SELECT MAX(change_id) as latest FROM changes
    `);

    this.getCursorStmt = db.prepare(`
      SELECT last_change_id FROM cursors WHERE consumer_id = $consumerId
    `);

    this.upsertCursorStmt = db.prepare(`
      INSERT INTO cursors (consumer_id, last_change_id, updated_at)
      VALUES ($consumerId, $changeId, $updatedAt)
      ON CONFLICT(consumer_id) DO UPDATE SET
        last_change_id = $changeId,
        updated_at = $updatedAt
    `);
  }

  /** Append a change to the journal. Returns the assigned changeId. */
  append(change: Omit<FileChange, "changeId">): number {
    const result = this.insertStmt.run({
      $path: change.path,
      $oldPath: change.oldPath ?? null,
      $type: change.type,
      $contentHash: change.contentHash,
      $size: change.size,
      $mtime: change.mtime,
      $detectedAt: change.detectedAt,
      $source: change.source,
      $deviceId: change.deviceId,
    });
    return Number(result.lastInsertRowid);
  }

  /** Get changes after a cursor position. */
  getChangesAfter(afterChangeId: number, limit: number = 1000): FileChange[] {
    const rows = this.getAfterStmt.all({
      $afterId: afterChangeId,
      $limit: limit,
    }) as any[];

    return rows.map((row) => ({
      changeId: row.change_id,
      path: row.path,
      oldPath: row.old_path ?? undefined,
      type: row.type as ChangeType,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      detectedAt: row.detected_at,
      source: row.source as "watcher" | "scan" | "api" | "remote",
      deviceId: row.device_id,
    }));
  }

  /** Get the latest changeId (for "start from now" semantics). */
  getLatestChangeId(): number {
    const row = this.getLatestStmt.get() as { latest: number | null } | null;
    return row?.latest ?? 0;
  }

  /** Update a consumer's cursor position. */
  updateCursor(consumerId: string, changeId: number): void {
    this.upsertCursorStmt.run({
      $consumerId: consumerId,
      $changeId: changeId,
      $updatedAt: Date.now(),
    });
  }

  /** Get a consumer's cursor position. Returns 0 if never set. */
  getCursor(consumerId: string): number {
    const row = this.getCursorStmt.get({ $consumerId: consumerId }) as {
      last_change_id: number;
    } | null;
    return row?.last_change_id ?? 0;
  }

  /** Compact: remove changes older than a given number of days. Returns count removed. */
  compact(olderThanDays: number): number {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(
      "DELETE FROM changes WHERE detected_at < $cutoff",
    );
    const result = stmt.run({ $cutoff: cutoff });
    return result.changes;
  }

  /** Get total number of changes in the journal. */
  count(): number {
    const row = this.db
      .query("SELECT COUNT(*) as cnt FROM changes")
      .get() as { cnt: number };
    return row.cnt;
  }

  // ─── Peer Cursor Methods (for cross-device sync) ──────────

  /** Get the last changeId sent to or received from a peer device. */
  getPeerCursor(
    peerDeviceId: string,
    direction: "sent" | "received",
  ): number {
    const row = this.db
      .prepare(
        "SELECT last_change_id FROM peer_cursors WHERE peer_device_id = $peerId AND direction = $dir",
      )
      .get({ $peerId: peerDeviceId, $dir: direction }) as {
      last_change_id: number;
    } | null;
    return row?.last_change_id ?? 0;
  }

  /** Update the peer cursor position. */
  updatePeerCursor(
    peerDeviceId: string,
    direction: "sent" | "received",
    changeId: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO peer_cursors (peer_device_id, direction, last_change_id, updated_at)
         VALUES ($peerId, $dir, $changeId, $now)
         ON CONFLICT(peer_device_id, direction) DO UPDATE SET
           last_change_id = $changeId,
           updated_at = $now`,
      )
      .run({
        $peerId: peerDeviceId,
        $dir: direction,
        $changeId: changeId,
        $now: Date.now(),
      });
  }

  /**
   * Get changes from this device that haven't been sent to a peer yet.
   * Filters to only include changes originating from the local device.
   */
  getUnsyncedChanges(
    localDeviceId: string,
    peerDeviceId: string,
    limit: number = 500,
  ): FileChange[] {
    const lastSent = this.getPeerCursor(peerDeviceId, "sent");
    const rows = this.db
      .prepare(
        `SELECT change_id, path, old_path, type, content_hash, size, mtime, detected_at, source, device_id
         FROM changes
         WHERE change_id > $afterId AND device_id = $localDevice
         ORDER BY change_id ASC
         LIMIT $limit`,
      )
      .all({
        $afterId: lastSent,
        $localDevice: localDeviceId,
        $limit: limit,
      }) as any[];

    return rows.map((row) => ({
      changeId: row.change_id,
      path: row.path,
      oldPath: row.old_path ?? undefined,
      type: row.type as ChangeType,
      contentHash: row.content_hash,
      size: row.size,
      mtime: row.mtime,
      detectedAt: row.detected_at,
      source: row.source as "watcher" | "scan" | "api" | "remote",
      deviceId: row.device_id,
    }));
  }
}
