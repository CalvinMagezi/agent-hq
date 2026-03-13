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
  replay_count: number;
  created_at: string;
  delta_summary?: string | null;  // Cached differential summary for pattern separation
}

export interface Replay {
  id: number;
  trigger_type: 'reverse' | 'forward';
  trigger_source: string;
  trigger_ref: string;
  memory_ids: number[];
  sequence: number[];
  credit_delta: number;
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
      replay_count INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS consolidations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ids  TEXT    NOT NULL,
      insight     TEXT    NOT NULL,
      connections TEXT    NOT NULL DEFAULT '[]',
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replays (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_type  TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      trigger_ref   TEXT NOT NULL,
      memory_ids    TEXT NOT NULL,
      sequence      TEXT NOT NULL DEFAULT '[]',
      credit_delta  REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated);
    CREATE INDEX IF NOT EXISTS idx_memories_topics ON memories(topics);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
  `);

  // Schema migrations — safe to run on existing DBs
  try { db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE memories ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0;"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE memories ADD COLUMN delta_summary TEXT;"); } catch { /* already exists */ }

  // Indices that might depend on migrated columns
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_replay ON memories(replay_count DESC);"); } catch { /* ignore */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_replays_trigger ON replays(trigger_type, created_at DESC);"); } catch { /* ignore */ }

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
    .prepare("SELECT * FROM memories WHERE consolidated = 0 ORDER BY replay_count DESC, created_at DESC LIMIT ?")
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
  const replays = (db.prepare("SELECT COUNT(*) as c FROM replays").get() as any).c;
  return { total, unconsolidated, consolidations, replays };
}

export function getBookmarkedMemories(db: Database, limit = 5): Memory[] {
  return db
    .prepare("SELECT * FROM memories WHERE replay_count > 0 AND consolidated = 0 ORDER BY replay_count DESC, importance DESC LIMIT ?")
    .all(limit)
    .map(parseMemoryRow) as Memory[];
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

export function storeReplay(
  db: Database,
  opts: {
    trigger_type: 'reverse' | 'forward';
    trigger_source: string;
    trigger_ref: string;
    memory_ids: number[];
    sequence: number[];
    credit_delta: number;
  }
): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO replays (trigger_type, trigger_source, trigger_ref, memory_ids, sequence, credit_delta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.trigger_type,
    opts.trigger_source,
    opts.trigger_ref,
    JSON.stringify(opts.memory_ids),
    JSON.stringify(opts.sequence),
    opts.credit_delta,
    now
  );
  return result.lastInsertRowid as number;
}

export function bumpReplayCount(db: Database, memoryIds: number[]): void {
  if (memoryIds.length === 0) return;
  const placeholders = memoryIds.map(() => "?").join(",");
  db.prepare(`UPDATE memories SET replay_count = replay_count + 1 WHERE id IN (${placeholders})`).run(...memoryIds);
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

export function parseMemoryRow(r: any): Memory {
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
    replay_count: r.replay_count || 0,
    created_at: r.created_at,
    delta_summary: r.delta_summary ?? null,
  };
}

/**
 * Store a cached differential summary for a memory.
 * Used by pattern separation: when two memories overlap, the delta
 * captures what's unique about this one. Empty string = checked, no unique info.
 */
export function storeDeltaSummary(db: Database, id: number, delta: string): void {
  db.prepare("UPDATE memories SET delta_summary = ? WHERE id = ?").run(delta, id);
}
