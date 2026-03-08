/**
 * vault-memory SQLite schema.
 * Database lives at {vaultPath}/_embeddings/memory.db
 */

import { Database } from "bun:sqlite";
import * as path from "path";
import * as fs from "fs";

export interface Memory {
  id: number;
  source: string;      // 'discord', 'job-abc', 'delegation-xyz', 'vault-note', 'daemon'
  harness: string;     // 'claude-code', 'gemini-cli', 'opencode', 'relay', 'agent'
  raw_text: string;
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;  // 0.0 - 1.0
  consolidated: boolean;
  created_at: string;
}

export interface Consolidation {
  id: number;
  source_ids: number[];
  insight: string;
  connections: Array<{ from_id: number; to_id: number; relationship: string }>;
  created_at: string;
}

export function openMemoryDB(vaultPath: string): Database {
  const embeddingsDir = path.join(vaultPath, "_embeddings");
  fs.mkdirSync(embeddingsDir, { recursive: true });

  const db = new Database(path.join(embeddingsDir, "memory.db"), { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL DEFAULT '',
      harness     TEXT    NOT NULL DEFAULT '',
      raw_text    TEXT    NOT NULL,
      summary     TEXT    NOT NULL,
      entities    TEXT    NOT NULL DEFAULT '[]',
      topics      TEXT    NOT NULL DEFAULT '[]',
      importance  REAL    NOT NULL DEFAULT 0.5,
      consolidated INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ids  TEXT    NOT NULL,
      insight     TEXT    NOT NULL,
      connections TEXT    NOT NULL DEFAULT '[]',
      created_at  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated);
    CREATE INDEX IF NOT EXISTS idx_memories_topics ON memories(topics);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  `);

  // Schema migrations — safe to run on existing DBs
  try { db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;"); } catch { /* already exists */ }

  return db;
}

// ── Read helpers ──────────────────────────────────────────────────────

export function getAllMemories(db: Database, limit = 50): Memory[] {
  return db
    .prepare("SELECT * FROM memories ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(parseMemoryRow) as Memory[];
}

export function getUnconsolidatedMemories(db: Database, limit = 15): Memory[] {
  return db
    .prepare("SELECT * FROM memories WHERE consolidated = 0 ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(parseMemoryRow) as Memory[];
}

export function getRecentMemories(db: Database, limit = 10): Memory[] {
  return db
    .prepare("SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?")
    .all(limit)
    .map(parseMemoryRow) as Memory[];
}

export function getConsolidationHistory(db: Database, limit = 5): Consolidation[] {
  return db
    .prepare("SELECT * FROM consolidations ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r: any) => ({
      id: r.id,
      source_ids: JSON.parse(r.source_ids),
      insight: r.insight,
      connections: JSON.parse(r.connections),
      created_at: r.created_at,
    })) as Consolidation[];
}

export function getMemoryStats(db: Database) {
  const total = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
  const unconsolidated = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE consolidated = 0").get() as any).c;
  const consolidations = (db.prepare("SELECT COUNT(*) as c FROM consolidations").get() as any).c;
  return { total, unconsolidated, consolidations };
}

// ── Write helpers ─────────────────────────────────────────────────────

export function storeMemory(
  db: Database,
  opts: {
    source: string;
    harness: string;
    raw_text: string;
    summary: string;
    entities: string[];
    topics: string[];
    importance: number;
  }
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO memories (source, harness, raw_text, summary, entities, topics, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.source,
      opts.harness,
      opts.raw_text,
      opts.summary,
      JSON.stringify(opts.entities),
      JSON.stringify(opts.topics),
      opts.importance,
      now
    );
  return result.lastInsertRowid as number;
}

export function storeConsolidation(
  db: Database,
  sourceIds: number[],
  insight: string,
  connections: Array<{ from_id: number; to_id: number; relationship: string }>
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO consolidations (source_ids, insight, connections, created_at) VALUES (?, ?, ?, ?)`
  ).run(JSON.stringify(sourceIds), insight, JSON.stringify(connections), now);

  // Mark source memories as consolidated
  if (sourceIds.length > 0) {
    const placeholders = sourceIds.map(() => "?").join(",");
    db.prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`).run(...sourceIds);
  }
}

// ── Decay & Pruning helpers (Synaptic Homeostasis) ────────────────────

/**
 * Decay importance of unconsolidated memories older than minAgeDays.
 * Each call reduces importance by decayRate (e.g. 0.015 = 1.5%/day).
 * Returns the number of memories updated.
 */
export function decayOldMemories(db: Database, decayRate = 0.015, minAgeDays = 7): number {
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString();
  const result = db.prepare(`
    UPDATE memories
    SET importance = MAX(0.01, importance - ?)
    WHERE consolidated = 0 AND created_at < ?
  `).run(decayRate, cutoff);
  return result.changes as number;
}

/**
 * Delete memories that have decayed below the importance threshold and are old enough.
 * Returns the number of memories pruned.
 */
export function pruneWeakMemories(db: Database, threshold = 0.05, minAgeDays = 60): number {
  const cutoff = new Date(Date.now() - minAgeDays * 86400_000).toISOString();
  const result = db.prepare(`
    DELETE FROM memories WHERE importance <= ? AND created_at < ?
  `).run(threshold, cutoff);
  return result.changes as number;
}

/**
 * Bump access count for a memory (called when it's served to an agent).
 * High-access memories resist decay more.
 */
export function touchMemory(db: Database, id: number): void {
  db.prepare(`
    UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

// ── Private ───────────────────────────────────────────────────────────

function parseMemoryRow(r: any): Memory {
  return {
    id: r.id,
    source: r.source,
    harness: r.harness,
    raw_text: r.raw_text,
    summary: r.summary,
    entities: JSON.parse(r.entities || "[]"),
    topics: JSON.parse(r.topics || "[]"),
    importance: r.importance,
    consolidated: Boolean(r.consolidated),
    created_at: r.created_at,
  };
}
