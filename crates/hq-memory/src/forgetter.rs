//! MemoryForgetter — implements "Synaptic Homeostasis" for vault memory.
//!
//! Inspired by the Synaptic Homeostasis Hypothesis (SHY): the brain doesn't
//! passively forget — it actively scales down weak synapses during sleep to
//! preserve the signal-to-noise ratio of important memories.
//!
//! Applied here: a daily decay cycle with schema-guided tiered rates:
//!   1. Standard decay (1.5%/day) for unconsolidated memories
//!   2. Accelerated decay (5%/day) for consolidated memories with low vault connectivity
//!   3. Protected decay (0.5%/day) for consolidated memories anchoring well-linked schemas
//!   4. Resist decay for high-access and replayed memories
//!   5. Prune memories below threshold after 60 days
//!
//! Ported from vault-memory/src/forgetter.ts.

use anyhow::Result;
use hq_db::Database;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tracing::info;

use crate::db::{decay_old_memories, get_memory_stats, prune_weak_memories};
use crate::types::MemoryStats;

/// Minimum backlinks on an insight note to qualify as "well-connected schema".
const HIGH_LINK_THRESHOLD: usize = 3;

/// Result of a forgetting cycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgetterResult {
    /// Memories whose importance was reduced
    pub decayed: i64,
    /// Memories deleted (importance fell below threshold)
    pub pruned: i64,
    /// Stats after the cycle
    pub stats_after: MemoryStats,
}

/// Memory forgetter with schema-guided tiered decay.
pub struct MemoryForgetter {
    db: Database,
    vault_path: PathBuf,
}

impl MemoryForgetter {
    pub fn new(db: Database, vault_path: PathBuf) -> Self {
        Self { db, vault_path }
    }

    /// Run one forgetting cycle with schema-guided tiered decay.
    ///
    /// Tier 1 (Standard): 1.5%/day for unconsolidated memories >7 days old.
    ///   A 0.5-importance memory takes ~30 days to reach the 0.05 prune threshold.
    ///
    /// Tier 2 (Accelerated): 5%/day for consolidated memories whose insight notes
    ///   have few backlinks (<3). The core insight has been extracted — raw data
    ///   can be cleaned up faster.
    ///
    /// Tier 3 (Protected): 0.5%/day for consolidated memories whose insight notes
    ///   are well-linked (3+ backlinks). These anchor important knowledge schemas
    ///   and should resist decay strongly.
    ///
    /// Protected: memories with access_count > 0 or replay_count > 0 get partial
    /// restore, since being accessed/replayed signals ongoing relevance.
    pub fn run_cycle(&self) -> Result<ForgetterResult> {
        // ── Tier 1: Standard decay — unconsolidated memories ──────────────
        let standard_decayed = decay_old_memories(&self.db, 0.015, 7)?;

        // ── Tiers 2 & 3: Schema-guided decay for consolidated memories ───
        let (low_link, high_link) = self.classify_consolidated_memories()?;
        let cutoff_7d = cutoff_iso(7);

        let mut accelerated_decayed = 0i64;
        let mut protected_decayed = 0i64;

        if !low_link.is_empty() {
            accelerated_decayed = self.db.with_conn(|conn| {
                let placeholders: String = low_link.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "UPDATE memories SET importance = MAX(0.01, importance - 0.05) WHERE id IN ({placeholders}) AND created_at < ?"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = low_link
                    .iter()
                    .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
                    .collect();
                params.push(Box::new(cutoff_7d.clone()));
                let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
                Ok(stmt.execute(param_refs.as_slice())? as i64)
            })?;
        }

        if !high_link.is_empty() {
            protected_decayed = self.db.with_conn(|conn| {
                let placeholders: String = high_link.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                let sql = format!(
                    "UPDATE memories SET importance = MAX(0.01, importance - 0.005) WHERE id IN ({placeholders}) AND created_at < ?"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = high_link
                    .iter()
                    .map(|id| Box::new(*id) as Box<dyn rusqlite::types::ToSql>)
                    .collect();
                params.push(Box::new(cutoff_7d.clone()));
                let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
                Ok(stmt.execute(param_refs.as_slice())? as i64)
            })?;
        }

        let decayed = standard_decayed + accelerated_decayed + protected_decayed;

        // ── Access-count protection ──────────────────────────────────────
        let cutoff_14d = cutoff_iso(14);
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE memories SET importance = MIN(1.0, importance + 0.0075) WHERE access_count > 0 AND consolidated = 0 AND created_at < ?1",
                [&cutoff_14d],
            )?;
            Ok(())
        })?;

        // ── Replay-count protection ──────────────────────────────────────
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE memories SET importance = MIN(1.0, importance + 0.0075) WHERE replay_count > 0 AND consolidated = 0 AND created_at < ?1",
                [&cutoff_14d],
            )?;
            Ok(())
        })?;

        // ── Prune memories below relevance floor ─────────────────────────
        let pruned = prune_weak_memories(&self.db, 0.05, 60)?;

        let stats_after = get_memory_stats(&self.db)?;

        if decayed > 0 || pruned > 0 {
            info!(decayed, pruned, "Forgetter cycle complete");
        }

        Ok(ForgetterResult { decayed, pruned, stats_after })
    }

    /// Classify consolidated memories by the link density of their insight notes.
    ///
    /// Queries the consolidations table, derives each insight note's path,
    /// then counts backlinks by scanning for wikilinks in the vault.
    /// Memories whose insight notes have 3+ backlinks are "high link"
    /// (schema anchors); the rest are "low link" (insight extracted, raw data expendable).
    fn classify_consolidated_memories(&self) -> Result<(Vec<i64>, Vec<i64>)> {
        let consolidations = self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT memory_ids, created_at FROM consolidations ORDER BY created_at DESC"
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })?;
            let mut result = Vec::new();
            for row in rows {
                result.push(row?);
            }
            Ok(result)
        })?;

        if consolidations.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }

        let mut low_link: Vec<i64> = Vec::new();
        let mut high_link: Vec<i64> = Vec::new();

        for (ids_json, created_at) in &consolidations {
            let source_ids: Vec<i64> = serde_json::from_str(ids_json).unwrap_or_default();
            if source_ids.is_empty() {
                continue;
            }

            // Derive insight note path — matches consolidator pattern
            let date = &created_at[..10.min(created_at.len())];
            let time = if created_at.len() >= 19 {
                created_at[11..19].replace(':', "-")
            } else {
                "00-00-00".into()
            };
            let note_path = format!("Notebooks/Memories/{date}-{time}-insight.md");

            // Count backlinks in the vault by scanning for [[note_path]] references
            let link_count = count_backlinks(&self.vault_path, &note_path);

            let bucket = if link_count >= HIGH_LINK_THRESHOLD {
                &mut high_link
            } else {
                &mut low_link
            };
            for id in &source_ids {
                bucket.push(*id);
            }
        }

        Ok((low_link, high_link))
    }
}

/// Count files in the vault that contain a wikilink to the given note path.
/// This is a simplified version — in production, you'd use the vault graph.
fn count_backlinks(vault_path: &PathBuf, note_path: &str) -> usize {
    let note_name = std::path::Path::new(note_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    if note_name.is_empty() {
        return 0;
    }

    let search_pattern = format!("[[{note_name}]]");
    let notebooks_dir = vault_path.join("Notebooks");

    if !notebooks_dir.exists() {
        return 0;
    }

    count_files_containing(&notebooks_dir, &search_pattern)
}

/// Recursively count markdown files containing a given string.
fn count_files_containing(dir: &std::path::Path, pattern: &str) -> usize {
    let mut count = 0;
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            count += count_files_containing(&path, pattern);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains(pattern) {
                    count += 1;
                }
            }
        }
    }
    count
}

fn cutoff_iso(days: i64) -> String {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);
    cutoff.to_rfc3339()
}
