//! MemoryQuerier — retrieves relevant memories for context injection.
//!
//! Used by the ContextEngine memory layer to pull live memories
//! instead of only reading the static MEMORY.md file.
//!
//! No LLM needed for basic queries — pure SQLite filtering.
//! Implements differential pattern separation: when two memories share 3+ topic tags,
//! the unique "delta" is extracted via Ollama in the background (cached in DB),
//! preserving nuanced information instead of discarding overlapping memories.
//!
//! Ported from vault-memory/src/querier.ts.

use anyhow::Result;
use hq_db::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{info, warn};

use crate::db::{
    get_consolidation_history, get_memory_by_id, get_memory_stats, get_recent_memories,
    store_delta_summary, touch_memory,
};
use crate::ollama::{check_ollama_available, ollama_chat, OllamaChatMessage};
use crate::types::{Memory, MemoryFact, MemoryStats};

/// Formatted memory context ready for system prompt injection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryContext {
    /// Formatted string ready for injection into a system prompt
    pub formatted: String,
    /// Raw memories retrieved
    pub memories: Vec<Memory>,
    /// Recent consolidation insights
    pub insights: Vec<String>,
    /// Stats for debugging
    pub stats: MemoryStats,
}

/// Memory querier with novelty deduplication and differential pattern separation.
pub struct MemoryQuerier {
    db: Database,
    /// Memories queued for background delta extraction
    pending_deltas: HashMap<i64, PendingDelta>,
}

struct PendingDelta {
    #[allow(dead_code)]
    candidate_id: i64,
    existing_summary: String,
}

impl MemoryQuerier {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            pending_deltas: HashMap::new(),
        }
    }

    /// Get recent high-importance memories formatted for context injection.
    /// Returns an empty context if no memories exist yet.
    pub fn get_recent_context(
        &mut self,
        limit: Option<i64>,
        topic_filter: Option<&[String]>,
    ) -> Result<MemoryContext> {
        let limit = limit.unwrap_or(8);

        let mut memories = get_recent_memories(&self.db, limit * 2)?;

        // Optional topic filter
        if let Some(filter) = topic_filter {
            if !filter.is_empty() {
                let filter_set: std::collections::HashSet<String> =
                    filter.iter().map(|t| t.to_lowercase()).collect();
                memories.retain(|m| {
                    m.topics.iter().any(|t| filter_set.contains(&t.to_lowercase()))
                });
            }
        }

        // Novelty deduplication with differential pattern separation
        memories = self.deduplicate_by_novelty(memories, limit as usize);

        // Touch accessed memories so the forgetter knows they're still relevant
        for m in &memories {
            let _ = touch_memory(&self.db, m.id);
        }

        let insights: Vec<String> = get_consolidation_history(&self.db, 3)?
            .into_iter()
            .map(|c| c.insight)
            .collect();

        let stats = get_memory_stats(&self.db)?;

        let formatted = format_for_context(&memories, &insights);

        Ok(MemoryContext { memories, insights, stats, formatted })
    }

    /// Get structured memory facts (high-importance, structured data).
    pub fn get_memory_facts(&self, limit: Option<i64>) -> Result<Vec<MemoryFact>> {
        let memories = get_recent_memories(&self.db, limit.unwrap_or(10))?;
        let facts: Vec<MemoryFact> = memories
            .into_iter()
            .filter(|m| m.importance >= 0.7)
            .map(|m| MemoryFact {
                fact_type: if m.topics.contains(&"decision".to_string()) {
                    "decision".into()
                } else if m.topics.contains(&"goal".to_string()) {
                    "goal".into()
                } else {
                    "fact".into()
                },
                content: m.summary,
                source: m.source,
            })
            .collect();
        Ok(facts)
    }

    /// Process queued delta extractions in the background.
    /// Called from daemon during idle time (piggybacks on consolidation cycle).
    /// Returns the number of deltas computed.
    pub async fn process_pending_deltas(&mut self) -> Result<usize> {
        if self.pending_deltas.is_empty() {
            return Ok(0);
        }

        if !check_ollama_available(None).await {
            return Ok(0);
        }

        let mut computed = 0;
        let pending: Vec<(i64, String)> = self.pending_deltas
            .iter()
            .map(|(id, pd)| (*id, pd.existing_summary.clone()))
            .collect();

        for (mem_id, existing_summary) in pending {
            let memory = match get_memory_by_id(&self.db, mem_id)? {
                Some(m) => m,
                None => {
                    self.pending_deltas.remove(&mem_id);
                    continue;
                }
            };

            let prompt = format!(
                r#"Given two memories that share similar topics:

EXISTING (already in context): "{existing_summary}"
CANDIDATE (overlapping): "{}"

Extract ONLY the unique information in the CANDIDATE that is NOT covered by the EXISTING memory. If there is nothing unique, respond with exactly "NO_DELTA".
Keep it to one concise sentence."#,
                memory.summary
            );

            let messages = vec![
                OllamaChatMessage {
                    role: "system".into(),
                    content: "You extract unique differential information between two overlapping memories. Be extremely concise.".into(),
                },
                OllamaChatMessage {
                    role: "user".into(),
                    content: prompt,
                },
            ];

            match ollama_chat(&messages, None).await {
                Ok(delta) => {
                    if !delta.contains("NO_DELTA") {
                        store_delta_summary(&self.db, mem_id, delta.trim())?;
                        computed += 1;
                    } else {
                        // Mark as checked with no unique info
                        store_delta_summary(&self.db, mem_id, "")?;
                    }
                }
                Err(e) => {
                    warn!(mem_id, error = %e, "Delta extraction failed");
                }
            }

            self.pending_deltas.remove(&mem_id);
        }

        if computed > 0 {
            info!(computed, "Computed memory deltas");
        }

        Ok(computed)
    }

    /// Differential pattern separation — keeps the injection set diverse while
    /// preserving unique information from overlapping memories.
    ///
    /// If two memories share 3+ topic tags:
    ///   - If the candidate has a cached delta_summary -> include it (using the delta)
    ///   - If the candidate has delta_summary="" -> skip (checked, nothing unique)
    ///   - If no delta cached yet -> queue for background extraction, skip this round
    ///
    /// High-salience memories always survive regardless.
    fn deduplicate_by_novelty(&mut self, memories: Vec<Memory>, limit: usize) -> Vec<Memory> {
        let mut seen: Vec<Memory> = Vec::new();

        for candidate in memories {
            if seen.len() >= limit {
                break;
            }

            let is_high_salience = candidate.topics.contains(&"high-salience".to_string());

            // Always include high-salience memories
            if is_high_salience {
                seen.push(candidate);
                continue;
            }

            // Check overlap with already-selected memories
            let mut overlap_summary: Option<String> = None;
            for existing in &seen {
                let overlap_count = candidate.topics.iter()
                    .filter(|t| existing.topics.contains(t))
                    .count();
                if overlap_count >= 3 {
                    overlap_summary = Some(existing.summary.clone());
                    break;
                }
            }

            match overlap_summary {
                None => {
                    // No overlap — include normally
                    seen.push(candidate);
                }
                Some(existing_summary) => {
                    // Check delta_summary status without holding a borrow across the move
                    let delta_status = match &candidate.delta_summary {
                        Some(delta) if !delta.is_empty() => Some(delta.clone()),
                        Some(_) => None, // empty string = checked, nothing unique
                        None => {
                            // Queue for background extraction
                            let cid = candidate.id;
                            self.pending_deltas.insert(cid, PendingDelta {
                                candidate_id: cid,
                                existing_summary,
                            });
                            None
                        }
                    };

                    if let Some(delta) = delta_status {
                        let mut modified = candidate;
                        modified.summary = delta;
                        seen.push(modified);
                    }
                }
            }
        }

        seen
    }
}

/// Format memories as a compact block for system prompt injection.
fn format_for_context(memories: &[Memory], insights: &[String]) -> String {
    if memories.is_empty() && insights.is_empty() {
        return String::new();
    }

    let mut parts: Vec<String> = Vec::new();

    if !insights.is_empty() {
        parts.push("**Recent Agent Insights:**".into());
        for insight in insights {
            parts.push(format!("- {insight}"));
        }
    }

    if !memories.is_empty() {
        parts.push("\n**Recent Memory:**".into());
        for m in memories {
            let age = relative_age(&m.created_at);
            parts.push(format!("- [{}/{age}] {}", m.source, m.summary));
        }
    }

    parts.join("\n")
}

/// Compute a human-readable relative age string.
fn relative_age(iso_date: &str) -> String {
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso_date) else {
        return "?".into();
    };
    let now = chrono::Utc::now();
    let duration = now.signed_duration_since(dt);
    let mins = duration.num_minutes();

    if mins < 60 {
        format!("{mins}m ago")
    } else {
        let hrs = mins / 60;
        if hrs < 24 {
            format!("{hrs}h ago")
        } else {
            format!("{}d ago", hrs / 24)
        }
    }
}
