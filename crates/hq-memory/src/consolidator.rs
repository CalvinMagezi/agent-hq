//! MemoryConsolidator — the "brain during sleep" cycle.
//!
//! Runs periodically (default: every 30 minutes via daemon).
//! Takes unconsolidated memories, finds connections via topic clustering,
//! generates insights, then writes them back to:
//!   1. The consolidations table (SQLite)
//!   2. Notebooks/Memories/ as a markdown note (visible in the vault)
//!
//! Ported from vault-memory/src/consolidator.ts.

use anyhow::Result;
use hq_db::Database;
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::{info, warn};

use crate::db::{get_consolidation_history, get_unconsolidated_memories, store_consolidation};
use crate::ollama::{check_ollama_available, ollama_json};
use crate::types::{Connection, ConsolidationResult, Memory};

const CONSOLIDATE_SYSTEM: &str = r#"You are a memory consolidation agent for Agent-HQ, a personal AI hub.

You receive a list of recent memories from various agent harnesses (Claude Code, Gemini CLI, Discord relay, etc).

Your job is to:
1. Find meaningful connections between memories
2. Identify cross-cutting patterns or insights
3. Generate one key insight that synthesizes all of them

Return a JSON object with exactly:
{
  "connections": [
    { "from_id": 1, "to_id": 3, "relationship": "brief description of how they relate" }
  ],
  "insight": "One key cross-cutting insight or pattern discovered across these memories"
}

Be concise. Focus on what's actionable or meaningful for the user."#;

const META_SYSTEM: &str = r#"You are a meta-synthesis agent. Given a list of insights from different topic clusters,
identify the single most important cross-cutting pattern or connection that spans them all.
Return JSON: { "insight": "one concise cross-cluster insight", "connections": [] }"#;

/// Memory consolidator with topic clustering and cross-cluster synthesis.
pub struct MemoryConsolidator {
    db: Database,
    vault_path: PathBuf,
}

impl MemoryConsolidator {
    pub fn new(db: Database, vault_path: PathBuf) -> Self {
        Self { db, vault_path }
    }

    /// Run one consolidation cycle using topic clustering.
    ///
    /// Inspired by hippocampal sharp-wave ripple replay: the brain doesn't replay
    /// all memories at once — it replays related memories in clusters, strengthening
    /// connections within each cluster before doing cross-cluster integration.
    ///
    /// Returns the final insight generated, or None if nothing to consolidate.
    pub async fn run_cycle(&self) -> Result<Option<String>> {
        let memories = get_unconsolidated_memories(&self.db, 30)?;

        if memories.len() < 3 {
            info!(count = memories.len(), "Consolidation skipped — need 3+ unconsolidated memories");
            return Ok(None);
        }

        if !check_ollama_available(None).await {
            warn!("Ollama not available — skipping consolidation");
            return Ok(None);
        }

        // ── Cluster memories by topic (hippocampal replay grouping) ──────
        let clusters = cluster_by_topic(&memories);
        let mut sorted_clusters: Vec<_> = clusters.into_iter().collect();
        sorted_clusters.sort_by(|a, b| b.1.len().cmp(&a.1.len())); // largest first

        let mut cluster_insights: Vec<String> = Vec::new();
        let mut last_insight: Option<String> = None;

        for (topic, cluster) in &sorted_clusters {
            if cluster.len() < 2 {
                continue; // skip singletons
            }
            if let Some(insight) = self.consolidate_cluster(cluster, topic).await? {
                cluster_insights.push(insight.clone());
                last_insight = Some(insight);
            }
        }

        // ── Cross-cluster synthesis (schema integration) ─────────────────
        if cluster_insights.len() >= 2 {
            if let Some(meta) = self.synthesize_clusters(&cluster_insights).await {
                last_insight = Some(meta);
            }
        }

        // Fallback: if no clusters with 2+ memories, consolidate all together
        if cluster_insights.is_empty() && memories.len() >= 3 {
            let capped: Vec<_> = memories.into_iter().take(15).collect();
            last_insight = self.consolidate_cluster(&capped, "general").await?;
        }

        Ok(last_insight)
    }

    /// Update _system/MEMORY.md with top insights from consolidation history.
    pub fn refresh_memory_file(&self) -> Result<()> {
        let history = get_consolidation_history(&self.db, 10)?;
        if history.is_empty() {
            return Ok(());
        }

        let memory_path = self.vault_path.join("_system").join("MEMORY.md");
        if !memory_path.exists() {
            return Ok(());
        }

        let existing = std::fs::read_to_string(&memory_path)?;

        let section_header = "## Agent Insights (Auto-Generated)";
        let insight_lines: Vec<String> = history
            .iter()
            .map(|c| format!("- [{}] {}", &c.created_at[..10.min(c.created_at.len())], c.insight))
            .collect();
        let section = format!("{section_header}\n\n{}\n", insight_lines.join("\n"));

        let updated = if existing.contains(section_header) {
            let escaped = regex::escape(section_header);
            let re = regex::Regex::new(&format!(r"(?m){escaped}[\s\S]*?(?=\n## |$)")).unwrap();
            re.replace(&existing, &section).to_string()
        } else {
            format!("{}\n\n{section}", existing.trim_end())
        };

        std::fs::write(&memory_path, updated)?;
        info!("Updated _system/MEMORY.md with agent insights");
        Ok(())
    }

    // ── Private: Cluster consolidation ──────────────────────────────────

    async fn consolidate_cluster(&self, cluster: &[Memory], topic: &str) -> Result<Option<String>> {
        // Cap cluster size to prevent oversized payloads
        let capped: Vec<&Memory> = cluster.iter().take(12).collect();
        info!(topic, count = capped.len(), total = cluster.len(), "Consolidating cluster");

        let memory_summary: String = capped
            .iter()
            .map(|m| {
                let summary_preview: String = m.summary.chars().take(200).collect();
                format!("[Memory #{}] ({}/{}) {}", m.id, m.source, m.harness, summary_preview)
            })
            .collect::<Vec<_>>()
            .join("\n");

        let result = match ollama_json::<ConsolidationResult>(
            CONSOLIDATE_SYSTEM,
            &format!("Consolidate these memories (topic cluster: \"{topic}\"):\n\n{memory_summary}"),
            None,
        ).await {
            Ok(r) => r,
            Err(e) => {
                warn!(topic, error = %e, "Cluster consolidation failed");
                return Ok(None);
            }
        };

        if result.insight.is_empty() {
            return Ok(None);
        }

        let valid_ids: std::collections::HashSet<i64> = capped.iter().map(|m| m.id).collect();
        let valid_connections: Vec<Connection> = result.connections
            .into_iter()
            .filter(|c| valid_ids.contains(&c.from_id) && valid_ids.contains(&c.to_id))
            .collect();

        let source_ids: Vec<i64> = capped.iter().map(|m| m.id).collect();
        store_consolidation(&self.db, &source_ids, &result.insight, &valid_connections)?;

        // Write insight note to vault
        let memories_owned: Vec<Memory> = capped.into_iter().cloned().collect();
        self.write_insight_note(&memories_owned, &result.insight, &valid_connections)?;

        let preview: String = result.insight.chars().take(100).collect();
        info!(topic, insight = %preview, "Cluster consolidated");
        Ok(Some(result.insight))
    }

    async fn synthesize_clusters(&self, insights: &[String]) -> Option<String> {
        let numbered: String = insights
            .iter()
            .enumerate()
            .map(|(i, insight)| format!("{}. {insight}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");

        match ollama_json::<ConsolidationResult>(
            META_SYSTEM,
            &format!("Find the cross-cluster pattern in these insights:\n\n{numbered}"),
            None,
        ).await {
            Ok(r) if !r.insight.is_empty() => {
                let preview: String = r.insight.chars().take(100).collect();
                info!(insight = %preview, "Cross-cluster insight");
                Some(r.insight)
            }
            _ => None,
        }
    }

    fn write_insight_note(
        &self,
        memories: &[Memory],
        insight: &str,
        connections: &[Connection],
    ) -> Result<()> {
        let notes_dir = self.vault_path.join("Notebooks").join("Memories");
        std::fs::create_dir_all(&notes_dir)?;

        let now = chrono::Utc::now();
        let date = now.format("%Y-%m-%d").to_string();
        let time = now.format("%H-%M-%S").to_string();
        let filename = format!("{date}-{time}-insight.md");
        let file_path = notes_dir.join(&filename);

        let sources: Vec<String> = memories.iter().map(|m| m.source.clone()).collect();
        let sources_dedup: Vec<&String> = {
            let mut seen = std::collections::HashSet::new();
            sources.iter().filter(|s| seen.insert(s.as_str())).collect()
        };

        let harnesses: Vec<String> = memories.iter().map(|m| m.harness.clone()).collect();
        let harnesses_dedup: Vec<&String> = {
            let mut seen = std::collections::HashSet::new();
            harnesses.iter().filter(|h| seen.insert(h.as_str())).collect()
        };

        let all_topics: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            memories.iter()
                .flat_map(|m| m.topics.iter().cloned())
                .filter(|t| seen.insert(t.clone()))
                .take(8)
                .collect()
        };

        let tags_str = all_topics.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ");
        let sources_str = sources_dedup.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        let harnesses_str = harnesses_dedup.iter().map(|h| h.as_str()).collect::<Vec<_>>().join(", ");

        let connection_lines = if connections.is_empty() {
            "_No connections identified_".to_string()
        } else {
            connections.iter()
                .map(|c| format!("- Memory #{} <-> #{}: {}", c.from_id, c.to_id, c.relationship))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let memory_summaries: String = memories.iter()
            .map(|m| format!("- **#{}** ({}): {}", m.id, m.source, m.summary))
            .collect::<Vec<_>>()
            .join("\n");

        let content = format!(
            r#"---
noteType: consolidation-insight
tags: [{tags_str}]
sources: [{sources_str}]
harnesses: [{harnesses_str}]
memoriesConsolidated: {count}
createdAt: "{created_at}"
---

# Agent Memory Insight -- {date}

## Key Insight

{insight}

## Connections Found

{connection_lines}

## Source Memories

{memory_summaries}
"#,
            count = memories.len(),
            created_at = now.to_rfc3339(),
        );

        std::fs::write(&file_path, content)?;
        info!(filename, "Wrote insight note");
        Ok(())
    }
}

/// Group memories by their primary (first) topic.
fn cluster_by_topic(memories: &[Memory]) -> HashMap<String, Vec<Memory>> {
    let mut clusters: HashMap<String, Vec<Memory>> = HashMap::new();
    for memory in memories {
        let primary_topic = memory.topics.first().cloned().unwrap_or_else(|| "general".into());
        clusters.entry(primary_topic).or_default().push(memory.clone());
    }
    clusters
}
