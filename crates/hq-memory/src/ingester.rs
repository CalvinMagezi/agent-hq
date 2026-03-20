//! MemoryIngester — converts raw text into a structured memory entry.
//!
//! Calls Ollama (qwen3.5:9b) to extract summary, entities, topics, importance.
//! Then stores the result in the memory DB.
//!
//! Ported from vault-memory/src/ingester.ts.

use anyhow::Result;
use hq_db::Database;
use regex::Regex;
use std::sync::LazyLock;
use std::time::Instant;
use tracing::{info, warn};

use crate::db::store_memory;
use crate::ollama::{check_ollama_available, ollama_json};
use crate::types::ExtractedMemory;

const SYSTEM_PROMPT: &str = r#"You are a memory extraction assistant for a personal AI agent hub called Agent-HQ.

Your job is to read a piece of text and extract structured memory from it.

Return a JSON object with exactly these fields:
{
  "summary": "1-2 sentence summary of what happened or was learned",
  "entities": ["array", "of", "key", "names", "projects", "tools"],
  "topics": ["2-4", "topic", "tags"],
  "importance": 0.7
}

importance scale:
- 0.9-1.0: critical decisions, major achievements, key user preferences
- 0.7-0.8: significant work done, useful insights, project updates
- 0.5-0.6: routine task completions, minor notes
- 0.3-0.4: low-value background info"#;

/// Salience detector — implements "Synaptic Tagging" from neuroscience.
///
/// When important events occur (decisions, failures, milestones), the brain
/// tags those synapses for priority consolidation. We do the same: scan for
/// salience markers in raw text and boost the importance score immediately
/// at encoding time, before the memory enters the consolidation queue.
static SALIENCE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(deadline|urgent|critical|blocker|blocked|decision|breakthrough|failed|failure|error|crash|security|vulnerability|breach|approved|rejected|milestone|launch|shipped|signed|cancelled|crisis|risk|escalat|budget|contract|deal|acquisition|pivot|layoff|hire|resign|fund(?:ing|ed)?|raise|partnership)\b").unwrap()
});

fn apply_salience_boost(text: &str, importance: f64, topics: &mut Vec<String>) -> f64 {
    if !SALIENCE_PATTERN.is_match(text) {
        return importance;
    }
    let boosted = (importance * 1.5).min(1.0);
    if !topics.contains(&"high-salience".to_string()) {
        topics.push("high-salience".to_string());
    }
    boosted
}

/// Memory ingester — extracts and stores structured memory from raw text.
pub struct MemoryIngester {
    db: Database,
    /// Cached availability status
    available: Option<bool>,
    /// Timestamp of last availability check
    last_check: Option<Instant>,
}

/// Re-check Ollama every 5 minutes on failure (self-healing).
const RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(300);

impl MemoryIngester {
    pub fn new(db: Database) -> Self {
        Self {
            db,
            available: None,
            last_check: None,
        }
    }

    /// Ingest a piece of text as a memory.
    /// Returns the new memory ID, or None if Ollama is unavailable or text is too short.
    pub async fn ingest(
        &mut self,
        text: &str,
        source: &str,
        harness: Option<&str>,
    ) -> Result<Option<i64>> {
        let harness = harness.unwrap_or("unknown");

        // Skip very short or empty content
        if text.trim().len() < 30 {
            return Ok(None);
        }

        // Check Ollama availability with retry logic
        let now = Instant::now();
        let should_recheck = match (self.available, self.last_check) {
            (None, _) => true,
            (Some(false), Some(last)) => now.duration_since(last) > RETRY_AFTER,
            _ => false,
        };

        if should_recheck {
            self.last_check = Some(now);
            self.available = Some(check_ollama_available(None).await);
            if self.available == Some(true) {
                info!("Ollama connection restored");
            }
        }

        if self.available != Some(true) {
            warn!("Ollama not available — skipping ingestion (will retry in 5m)");
            return Ok(None);
        }

        // Truncate text to 2000 chars for LLM call
        let truncated: String = text.chars().take(2000).collect();

        let extracted = match ollama_json::<ExtractedMemory>(
            SYSTEM_PROMPT,
            &format!("Extract memory from this text:\n\n{truncated}"),
            None,
        ).await {
            Ok(e) => e,
            Err(e) => {
                warn!(error = %e, "Ingestion LLM extraction failed");
                return Ok(None);
            }
        };

        // Validate shape
        if extracted.summary.is_empty() {
            warn!("Invalid extraction shape (empty summary), skipping");
            return Ok(None);
        }

        // Apply salience boost (synaptic tagging)
        let base_importance = extracted.importance.clamp(0.0, 1.0);
        let mut topics: Vec<String> = extracted.topics.into_iter().take(5).collect();
        let importance = apply_salience_boost(text, base_importance, &mut topics);

        // Truncate raw text to 4000 chars for storage
        let raw_text: String = text.chars().take(4000).collect();
        let entities: Vec<String> = extracted.entities.into_iter().take(10).collect();

        let id = store_memory(
            &self.db, source, harness, &raw_text, &extracted.summary,
            &entities, &topics, importance,
        )?;

        info!(id, source, summary = %extracted.summary.chars().take(80).collect::<String>(), "Ingested memory");
        Ok(Some(id))
    }

    /// Batch ingest multiple texts. Useful for job completion summaries.
    pub async fn ingest_batch(
        &mut self,
        items: &[(&str, &str, Option<&str>)],
    ) -> Result<Vec<i64>> {
        let mut ids = Vec::new();
        for (text, source, harness) in items {
            if let Some(id) = self.ingest(text, source, *harness).await? {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}
