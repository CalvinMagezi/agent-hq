/**
 * SQLite schema initialization and migrations for the sync database.
 *
 * Location: .vault/_embeddings/sync.db (separate from search.db)
 * Engine: bun:sqlite with WAL mode
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

const CURRENT_SCHEMA_VERSION = 2;

/** Initialize the sync database with all required tables. */
export function initSyncDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    -- Current known state of each file in the vault
    CREATE TABLE IF NOT EXISTS file_state (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      device_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    -- Version history for conflict resolution and rollback
    CREATE TABLE IF NOT EXISTS file_versions (
      path TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (path, version)
    );

    -- Append-only change journal (the replication log)
    CREATE TABLE IF NOT EXISTS changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      old_path TEXT,
      type TEXT NOT NULL CHECK(type IN ('create', 'modify', 'delete', 'rename')),
      content_hash TEXT,
      size INTEGER,
      mtime INTEGER,
      detected_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('watcher', 'scan', 'api', 'remote')),
      device_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_path ON changes(path);
    CREATE INDEX IF NOT EXISTS idx_changes_detected ON changes(detected_at);

    -- Consumer cursors for guaranteed delivery
    CREATE TABLE IF NOT EXISTS cursors (
      consumer_id TEXT PRIMARY KEY,
      last_change_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- Advisory file locks for write atomicity
    CREATE TABLE IF NOT EXISTS locks (
      path TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Unresolved conflicts
    CREATE TABLE IF NOT EXISTS conflicts (
      conflict_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      local_hash TEXT NOT NULL,
      remote_hash TEXT NOT NULL,
      local_device TEXT NOT NULL,
      remote_device TEXT NOT NULL,
      strategy TEXT NOT NULL,
      resolution_json TEXT,
      detected_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conflicts_path ON conflicts(path);
    CREATE INDEX IF NOT EXISTS idx_conflicts_unresolved
      ON conflicts(resolved_at) WHERE resolved_at IS NULL;

    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- Peer sync cursors for cross-device sync
    CREATE TABLE IF NOT EXISTS peer_cursors (
      peer_device_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
      last_change_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (peer_device_id, direction)
    );
  `);

  // Set schema version if not already set
  const existing = db
    .query("SELECT value FROM sync_meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;

  if (!existing) {
    db.run(
      "INSERT INTO sync_meta (key, value) VALUES ('schema_version', ?)",
      [String(CURRENT_SCHEMA_VERSION)],
    );
  }
}

/** Open or create the sync database at the standard location. */
export function openSyncDatabase(vaultPath: string, dbPath?: string): Database {
  const resolvedPath =
    dbPath ?? path.join(vaultPath, "_embeddings", "sync.db");

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  initSyncDatabase(db);
  return db;
}
