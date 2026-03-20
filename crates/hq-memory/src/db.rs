//! SQLite database operations for the memory system.
//! Ported from vault-memory/src/db.ts.

use anyhow::Result;
use hq_db::Database;

use crate::types::{
    Consolidation, Connection as MemConnection, Memory, MemoryStats, ReplayTriggerType,
};

// ─── Schema ─────────────────────────────────────────────────────────

/// Ensure the memory tables exist. Called at startup.
/// This is safe to run multiple times (idempotent).
///
/// NOTE: The base `memories` and `consolidations` tables are created by the
/// hq-db 001_initial migration. This function adds the extra columns and the
/// `replays` table that the full memory system requires.
pub fn open_memory_tables(db: &Database) -> Result<()> {
    db.with_conn(|conn| {
        // The replays table (not in the base migration)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS replays (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                trigger_type   TEXT NOT NULL,
                trigger_source TEXT NOT NULL,
                trigger_ref    TEXT NOT NULL,
                memory_ids     TEXT NOT NULL,
                sequence       TEXT NOT NULL DEFAULT '[]',
                credit_delta   REAL NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL
            );"
        )?;

        // Extra columns the full memory system needs (safe ALTER — ignore if exists)
        let extra_columns = [
            ("memories", "harness", "TEXT NOT NULL DEFAULT ''"),
            ("memories", "raw_text", "TEXT NOT NULL DEFAULT ''"),
            ("memories", "summary", "TEXT NOT NULL DEFAULT ''"),
            ("memories", "entities", "TEXT NOT NULL DEFAULT '[]'"),
            ("memories", "topics", "TEXT NOT NULL DEFAULT '[]'"),
            ("memories", "last_accessed_at", "TEXT"),
            ("memories", "access_count", "INTEGER NOT NULL DEFAULT 0"),
            ("memories", "replay_count", "INTEGER NOT NULL DEFAULT 0"),
            ("memories", "delta_summary", "TEXT"),
        ];

        for (table, col, typedef) in &extra_columns {
            let sql = format!("ALTER TABLE {table} ADD COLUMN {col} {typedef};");
            // Ignore "duplicate column name" errors
            let _ = conn.execute_batch(&sql);
        }

        // Add connections column to consolidations if missing
        let _ = conn.execute_batch(
            "ALTER TABLE consolidations ADD COLUMN connections TEXT NOT NULL DEFAULT '[]';"
        );
        // Add source_ids alias (the base migration uses memory_ids, TS uses source_ids)
        // We'll use memory_ids as the canonical column name and handle both in code.

        // Extra indexes
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memories_consolidated ON memories(consolidated);
             CREATE INDEX IF NOT EXISTS idx_memories_topics ON memories(topics);
             CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_memories_replay ON memories(replay_count DESC);
             CREATE INDEX IF NOT EXISTS idx_replays_trigger ON replays(trigger_type, created_at DESC);"
        )?;

        Ok(())
    })
}

// ─── Row parsing ────────────────────────────────────────────────────

/// Parse a rusqlite Row into a Memory struct.
/// The row must have been selected with `SELECT * FROM memories`.
pub fn parse_memory_row(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    let entities_json: String = row.get_or_default("entities", "[]".to_string());
    let topics_json: String = row.get_or_default("topics", "[]".to_string());

    Ok(Memory {
        id: row.get("id")?,
        source: row.get("source")?,
        harness: row.get_or_default("harness", String::new()),
        raw_text: row.get_or_default("raw_text", String::new()),
        summary: row.get_or_default("summary", String::new()),
        entities: serde_json::from_str(&entities_json).unwrap_or_default(),
        topics: serde_json::from_str(&topics_json).unwrap_or_default(),
        importance: row.get("importance")?,
        consolidated: row.get::<_, i64>("consolidated")? != 0,
        replay_count: row.get_or_default("replay_count", 0),
        created_at: row.get("created_at")?,
        last_accessed_at: row.get_or_default("last_accessed_at", None),
        access_count: row.get_or_default("access_count", 0),
        delta_summary: row.get_or_default("delta_summary", None),
    })
}

/// Helper trait to get a column value with a default if the column doesn't exist.
trait RowExt {
    fn get_or_default<T: rusqlite::types::FromSql>(&self, col: &str, default: T) -> T;
}

impl RowExt for rusqlite::Row<'_> {
    fn get_or_default<T: rusqlite::types::FromSql>(&self, col: &str, default: T) -> T {
        self.get(col).unwrap_or(default)
    }
}

// ─── Read helpers ───────────────────────────────────────────────────

pub fn get_all_memories(db: &Database, limit: i64) -> Result<Vec<Memory>> {
    db.with_conn(|conn| {
        query_memories(conn, "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?1", &[&limit])
    })
}

pub fn get_unconsolidated_memories(db: &Database, limit: i64) -> Result<Vec<Memory>> {
    db.with_conn(|conn| {
        query_memories(
            conn,
            "SELECT * FROM memories WHERE consolidated = 0 ORDER BY replay_count DESC, created_at DESC LIMIT ?1",
            &[&limit],
        )
    })
}

pub fn get_recent_memories(db: &Database, limit: i64) -> Result<Vec<Memory>> {
    db.with_conn(|conn| {
        query_memories(
            conn,
            "SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?1",
            &[&limit],
        )
    })
}

pub fn get_bookmarked_memories(db: &Database, limit: i64) -> Result<Vec<Memory>> {
    db.with_conn(|conn| {
        query_memories(
            conn,
            "SELECT * FROM memories WHERE replay_count > 0 AND consolidated = 0 ORDER BY replay_count DESC, importance DESC LIMIT ?1",
            &[&limit],
        )
    })
}

pub fn get_consolidation_history(db: &Database, limit: i64) -> Result<Vec<Consolidation>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT * FROM consolidations ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map([limit], |row| {
            let memory_ids_json: String = row.get("memory_ids")?;
            let connections_json: String = row.get_or_default("connections", "[]".to_string());
            Ok(Consolidation {
                id: row.get("id")?,
                source_ids: serde_json::from_str(&memory_ids_json).unwrap_or_default(),
                insight: row.get("insight")?,
                connections: serde_json::from_str(&connections_json).unwrap_or_default(),
                created_at: row.get("created_at")?,
            })
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    })
}

pub fn get_memory_stats(db: &Database) -> Result<MemoryStats> {
    db.with_conn(|conn| {
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))?;
        let unconsolidated: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE consolidated = 0", [], |r| r.get(0)
        )?;
        let consolidations: i64 = conn.query_row("SELECT COUNT(*) FROM consolidations", [], |r| r.get(0))?;
        let replays: i64 = conn.query_row("SELECT COUNT(*) FROM replays", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(MemoryStats { total, unconsolidated, consolidations, replays })
    })
}

/// Get a single memory by ID.
pub fn get_memory_by_id(db: &Database, id: i64) -> Result<Option<Memory>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT * FROM memories WHERE id = ?1")?;
        let mut rows = stmt.query_map([id], parse_memory_row)?;
        match rows.next() {
            Some(Ok(m)) => Ok(Some(m)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    })
}

// ─── Write helpers ──────────────────────────────────────────────────

/// Store a new memory. Returns the inserted row ID.
pub fn store_memory(
    db: &Database,
    source: &str,
    harness: &str,
    raw_text: &str,
    summary: &str,
    entities: &[String],
    topics: &[String],
    importance: f64,
) -> Result<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    let entities_json = serde_json::to_string(entities)?;
    let topics_json = serde_json::to_string(topics)?;

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO memories (source, harness, raw_text, summary, entities, topics, importance, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?4, ?8)",
            rusqlite::params![source, harness, raw_text, summary, entities_json, topics_json, importance, now],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

/// Store a consolidation and mark source memories as consolidated.
pub fn store_consolidation(
    db: &Database,
    source_ids: &[i64],
    insight: &str,
    connections: &[MemConnection],
) -> Result<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    let ids_json = serde_json::to_string(source_ids)?;
    let conns_json = serde_json::to_string(connections)?;

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO consolidations (memory_ids, insight, connections, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ids_json, insight, conns_json, now],
        )?;
        let consolidation_id = conn.last_insert_rowid();

        // Mark source memories as consolidated
        if !source_ids.is_empty() {
            let placeholders: String = source_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("UPDATE memories SET consolidated = 1 WHERE id IN ({placeholders})");
            let mut stmt = conn.prepare(&sql)?;
            let params: Vec<Box<dyn rusqlite::types::ToSql>> = source_ids
                .iter()
                .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
                .collect();
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            stmt.execute(param_refs.as_slice())?;
        }

        Ok(consolidation_id)
    })
}

/// Store a replay record.
pub fn store_replay(
    db: &Database,
    trigger_type: &ReplayTriggerType,
    trigger_source: &str,
    trigger_ref: &str,
    memory_ids: &[i64],
    sequence: &[i64],
    credit_delta: f64,
) -> Result<i64> {
    let now = chrono::Utc::now().to_rfc3339();
    let ids_json = serde_json::to_string(memory_ids)?;
    let seq_json = serde_json::to_string(sequence)?;

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO replays (trigger_type, trigger_source, trigger_ref, memory_ids, sequence, credit_delta, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![trigger_type.to_string(), trigger_source, trigger_ref, ids_json, seq_json, credit_delta, now],
        )?;
        Ok(conn.last_insert_rowid())
    })
}

/// Increment replay_count for a set of memory IDs.
pub fn bump_replay_count(db: &Database, memory_ids: &[i64]) -> Result<()> {
    if memory_ids.is_empty() { return Ok(()); }
    db.with_conn(|conn| {
        let placeholders: String = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE memories SET replay_count = replay_count + 1 WHERE id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<Box<dyn rusqlite::types::ToSql>> = memory_ids
            .iter()
            .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
            .collect();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        stmt.execute(param_refs.as_slice())?;
        Ok(())
    })
}

// ─── Decay & Pruning (Synaptic Homeostasis) ─────────────────────────

/// Decay importance of unconsolidated memories older than `min_age_days`.
/// Returns the number of memories updated.
pub fn decay_old_memories(db: &Database, decay_rate: f64, min_age_days: i64) -> Result<i64> {
    let cutoff = cutoff_iso(min_age_days);
    db.with_conn(|conn| {
        let changes = conn.execute(
            "UPDATE memories SET importance = MAX(0.01, importance - ?1) WHERE consolidated = 0 AND created_at < ?2",
            rusqlite::params![decay_rate, cutoff],
        )?;
        Ok(changes as i64)
    })
}

/// Delete memories below the importance threshold that are old enough.
/// Returns the number of memories pruned.
pub fn prune_weak_memories(db: &Database, threshold: f64, min_age_days: i64) -> Result<i64> {
    let cutoff = cutoff_iso(min_age_days);
    db.with_conn(|conn| {
        let changes = conn.execute(
            "DELETE FROM memories WHERE importance <= ?1 AND created_at < ?2",
            rusqlite::params![threshold, cutoff],
        )?;
        Ok(changes as i64)
    })
}

/// Bump access count and last_accessed_at for a memory (served to an agent).
pub fn touch_memory(db: &Database, id: i64) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        Ok(())
    })
}

/// Store a cached differential summary for a memory (pattern separation).
pub fn store_delta_summary(db: &Database, id: i64, delta: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute("UPDATE memories SET delta_summary = ?1 WHERE id = ?2", rusqlite::params![delta, id])?;
        Ok(())
    })
}

// ─── Internal helpers ───────────────────────────────────────────────

fn query_memories(conn: &rusqlite::Connection, sql: &str, params: &[&dyn rusqlite::types::ToSql]) -> Result<Vec<Memory>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, parse_memory_row)?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn cutoff_iso(days: i64) -> String {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    cutoff.to_rfc3339()
}
