//! Memory system types — ported from vault-memory/src/db.ts

use serde::{Deserialize, Serialize};

/// A single memory record stored in SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub id: i64,
    /// Origin: 'discord', 'job-abc', 'delegation-xyz', 'vault-note', 'daemon'
    pub source: String,
    /// Harness: 'claude-code', 'gemini-cli', 'opencode', 'relay', 'agent'
    pub harness: String,
    /// Original text (truncated to 4000 chars at ingestion)
    pub raw_text: String,
    /// LLM-extracted 1-2 sentence summary
    pub summary: String,
    /// Key people, projects, tools
    pub entities: Vec<String>,
    /// 2-4 topic tags
    pub topics: Vec<String>,
    /// 0.0 - 1.0 importance score
    pub importance: f64,
    /// Whether this memory has been consolidated
    pub consolidated: bool,
    /// Number of times this memory was replayed (reverse/forward)
    pub replay_count: i64,
    /// ISO 8601 timestamp
    pub created_at: String,
    /// Last time this memory was served to an agent
    pub last_accessed_at: Option<String>,
    /// Number of times this memory was accessed for context
    pub access_count: i64,
    /// Cached differential summary for pattern separation
    pub delta_summary: Option<String>,
}

/// A structured fact extracted from memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFact {
    pub fact_type: String,
    pub content: String,
    pub source: String,
}

/// A consolidation record — the insight from clustering related memories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Consolidation {
    pub id: i64,
    /// IDs of the memories that produced this insight
    pub source_ids: Vec<i64>,
    /// The synthesized insight text
    pub insight: String,
    /// Discovered connections between memories
    pub connections: Vec<Connection>,
    /// ISO 8601 timestamp
    pub created_at: String,
}

/// A connection between two memories found during consolidation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub from_id: i64,
    pub to_id: i64,
    pub relationship: String,
}

/// A replay record — either reverse (credit assignment) or forward (planning).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Replay {
    pub id: i64,
    pub trigger_type: ReplayTriggerType,
    pub trigger_source: String,
    pub trigger_ref: String,
    pub memory_ids: Vec<i64>,
    pub sequence: Vec<i64>,
    pub credit_delta: f64,
    pub created_at: String,
}

/// Replay trigger direction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReplayTriggerType {
    Reverse,
    Forward,
}

impl std::fmt::Display for ReplayTriggerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Reverse => write!(f, "reverse"),
            Self::Forward => write!(f, "forward"),
        }
    }
}

impl std::str::FromStr for ReplayTriggerType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "reverse" => Ok(Self::Reverse),
            "forward" => Ok(Self::Forward),
            _ => Err(format!("unknown replay trigger type: {s}")),
        }
    }
}

/// Aggregate memory stats.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryStats {
    pub total: i64,
    pub unconsolidated: i64,
    pub consolidations: i64,
    pub replays: i64,
}

/// LLM-extracted memory from raw text (ingester output).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedMemory {
    pub summary: String,
    pub entities: Vec<String>,
    pub topics: Vec<String>,
    pub importance: f64,
}

/// Result of an LLM consolidation call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsolidationResult {
    pub connections: Vec<Connection>,
    pub insight: String,
}
