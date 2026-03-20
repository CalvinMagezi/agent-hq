//! AwakeReplayEngine — reverse (credit assignment) and forward (planning) replay.
//!
//! Ported from vault-memory/src/awakeReplay.ts.
//!
//! Reverse Replay: triggered by job/task completion. Finds memories created during
//! the job's lifetime and boosts their importance (credit assignment).
//!
//! Forward Replay: triggered by new job/task creation. Finds related precedent
//! memories by cue matching (entities, topics).

use anyhow::Result;
use hq_db::Database;
use regex::Regex;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::LazyLock;
use tracing::info;

use crate::db::{bump_replay_count, store_replay};
use crate::types::{Memory, ReplayTriggerType};

/// Awake replay engine for credit assignment and planning.
pub struct AwakeReplayEngine {
    db: Database,
    #[allow(dead_code)]
    vault_path: PathBuf,
}

/// Result of a reverse replay operation.
#[derive(Debug, Clone)]
pub struct ReverseReplayResult {
    pub replayed_count: usize,
    pub credit_delta: f64,
}

/// Result of a forward replay operation.
#[derive(Debug, Clone)]
pub struct ForwardReplayResult {
    pub precedents: Vec<Memory>,
    pub replayed_count: usize,
}

/// Cues extracted from text for memory retrieval.
struct Cues {
    entities: Vec<String>,
    topics: Vec<String>,
}

// Regex patterns for cue extraction
static CAP_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*)\b").unwrap()
});

static TAG_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"#([a-zA-Z0-9_]+)").unwrap()
});

static MENTION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@([a-zA-Z0-9_]+)").unwrap()
});

static QUOTE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""([^"]+)"|'([^']+)'"#).unwrap()
});

impl AwakeReplayEngine {
    pub fn new(db: Database, vault_path: PathBuf) -> Self {
        Self { db, vault_path }
    }

    /// Reverse Replay (Credit Assignment)
    /// Triggered by: job completion, task completion, [DONE:] tag.
    ///
    /// Finds memories created during the job's lifetime or related by entities,
    /// boosts their importance, bumps replay_count, stores a replay record.
    pub fn reverse_replay(
        &self,
        trigger_ref: &str,
        trigger_source: &str,
        entities: Option<&[String]>,
        time_window_ms: Option<i64>,
    ) -> Result<ReverseReplayResult> {
        let time_window = time_window_ms.unwrap_or(24 * 60 * 60 * 1000);
        let cutoff = chrono::Utc::now() - chrono::Duration::milliseconds(time_window);
        let cutoff_iso = cutoff.to_rfc3339();

        let direct_pattern = format!("%{trigger_ref}%");

        // Build query for direct job memories + entity matches
        let memories = self.db.with_conn(|conn| {
            let mut sql = String::from(
                "SELECT * FROM memories WHERE (source LIKE ?1 OR summary LIKE ?2) AND created_at > ?3"
            );
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![
                Box::new(direct_pattern.clone()),
                Box::new(direct_pattern.clone()),
                Box::new(cutoff_iso.clone()),
            ];

            if let Some(ents) = entities {
                if !ents.is_empty() {
                    let entity_conditions: Vec<String> = ents.iter()
                        .map(|_| "entities LIKE ?".to_string())
                        .collect();
                    sql.push_str(&format!(" OR ({})", entity_conditions.join(" OR ")));
                    for e in ents {
                        params.push(Box::new(format!("%{e}%")));
                    }
                }
            }

            let mut stmt = conn.prepare(&sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), crate::db::parse_memory_row)?;

            let mut result = Vec::new();
            for row in rows {
                result.push(row?);
            }
            Ok(result)
        })?;

        if memories.is_empty() {
            return Ok(ReverseReplayResult { replayed_count: 0, credit_delta: 0.0 });
        }

        // Order chronologically (ASC)
        let mut sequence = memories;
        sequence.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        let memory_ids: Vec<i64> = sequence.iter().map(|m| m.id).collect();

        // Credit delta: base 0.05 + 0.01 per chain step (capped at 0.15)
        let credit_delta = (0.05 + (sequence.len() as f64 * 0.01)).min(0.15);

        // Update importance in DB
        self.db.with_conn(|conn| {
            let placeholders: String = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "UPDATE memories SET importance = MIN(1.0, importance + ?1) WHERE id IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(credit_delta)];
            for id in &memory_ids {
                params.push(Box::new(*id));
            }
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            stmt.execute(param_refs.as_slice())?;
            Ok(())
        })?;

        // Bump replay_count
        bump_replay_count(&self.db, &memory_ids)?;

        // Store replay record
        store_replay(
            &self.db,
            &ReplayTriggerType::Reverse,
            trigger_source,
            trigger_ref,
            &memory_ids,
            &memory_ids,
            credit_delta,
        )?;

        let replayed_count = sequence.len();
        info!(replayed_count, credit_delta, trigger_ref, "Reverse replay complete");

        Ok(ReverseReplayResult { replayed_count, credit_delta })
    }

    /// Forward Replay (Planning/Preplay)
    /// Triggered by: new job creation, new task creation.
    ///
    /// Extracts cues from instruction text, finds related precedent memories,
    /// bumps replay_count, stores a replay record.
    pub fn forward_replay(
        &self,
        trigger_ref: &str,
        trigger_source: &str,
        instruction_text: &str,
        limit: Option<usize>,
    ) -> Result<ForwardReplayResult> {
        let limit = limit.unwrap_or(5);

        // Extract cues from instruction text
        let cues = extract_cues(instruction_text);

        // Find related memories
        let precedents = self.find_related_memories(&cues, limit)?;

        if precedents.is_empty() {
            return Ok(ForwardReplayResult { precedents: Vec::new(), replayed_count: 0 });
        }

        let memory_ids: Vec<i64> = precedents.iter().map(|m| m.id).collect();

        // Bump replay_count
        bump_replay_count(&self.db, &memory_ids)?;

        // Store replay record
        store_replay(
            &self.db,
            &ReplayTriggerType::Forward,
            trigger_source,
            trigger_ref,
            &memory_ids,
            &memory_ids, // sequence same as IDs for forward replay
            0.0,
        )?;

        let replayed_count = precedents.len();
        info!(replayed_count, trigger_ref, "Forward replay complete");

        Ok(ForwardReplayResult { precedents, replayed_count })
    }

    /// Memory retrieval by cue matching.
    fn find_related_memories(&self, cues: &Cues, limit: usize) -> Result<Vec<Memory>> {
        self.db.with_conn(|conn| {
            if cues.entities.is_empty() && cues.topics.is_empty() {
                // Fallback: just return the most important recent memories
                let mut stmt = conn.prepare(
                    "SELECT * FROM memories WHERE consolidated = 0 ORDER BY importance DESC, created_at DESC LIMIT ?1"
                )?;
                let rows = stmt.query_map([limit as i64], crate::db::parse_memory_row)?;
                let mut result = Vec::new();
                for row in rows {
                    result.push(row?);
                }
                return Ok(result);
            }

            let mut conditions: Vec<String> = Vec::new();
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            for e in &cues.entities {
                conditions.push("entities LIKE ?".to_string());
                params.push(Box::new(format!("%{e}%")));
            }

            for t in &cues.topics {
                conditions.push("topics LIKE ?".to_string());
                params.push(Box::new(format!("%{t}%")));
            }

            let sql = format!(
                "SELECT * FROM memories WHERE ({}) ORDER BY importance DESC, created_at DESC LIMIT ?",
                conditions.join(" OR ")
            );
            params.push(Box::new(limit as i64));

            let mut stmt = conn.prepare(&sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), crate::db::parse_memory_row)?;

            let mut result = Vec::new();
            for row in rows {
                result.push(row?);
            }
            Ok(result)
        })
    }
}

/// Fast cue extraction (regex only, <50ms).
fn extract_cues(text: &str) -> Cues {
    let mut entities = HashSet::new();
    let mut topics = HashSet::new();

    // Capitalized phrases (Entities)
    for cap in CAP_PATTERN.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            if m.as_str().len() > 3 {
                entities.insert(m.as_str().to_string());
            }
        }
    }

    // #tags (Topics)
    for cap in TAG_PATTERN.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            topics.insert(m.as_str().to_string());
        }
    }

    // @mentions (Entities)
    for cap in MENTION_PATTERN.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            entities.insert(m.as_str().to_string());
        }
    }

    // Quoted strings (Entities/Specifics)
    for cap in QUOTE_PATTERN.captures_iter(text) {
        let val = cap.get(1).or_else(|| cap.get(2));
        if let Some(v) = val {
            if v.as_str().len() > 2 {
                entities.insert(v.as_str().to_string());
            }
        }
    }

    Cues {
        entities: entities.into_iter().collect(),
        topics: topics.into_iter().collect(),
    }
}
