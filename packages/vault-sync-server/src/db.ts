/**
 * SQLite schema for the sync server.
 *
 * Stores device registrations and vault group metadata.
 * Does NOT store file content — the server is zero-knowledge.
 */

import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

export function initServerDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(`
    -- Registered devices and their vault group membership
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      device_token TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (device_id, vault_id)
    );
    CREATE INDEX IF NOT EXISTS idx_devices_vault ON devices(vault_id);

    -- Vault groups (one per unique vault passphrase)
    CREATE TABLE IF NOT EXISTS vault_groups (
      vault_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      device_count INTEGER NOT NULL DEFAULT 0
    );

    -- Server metadata
    CREATE TABLE IF NOT EXISTS server_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function openServerDatabase(dbPath: string): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  initServerDatabase(db);
  return db;
}
