//! hq-memory — Always-on persistent memory for Agent-HQ.
//!
//! Ported from the TypeScript `@repo/vault-memory` package.
//!
//! Components:
//! - **Ingester** — converts raw text into structured memory entries via LLM extraction
//! - **Consolidator** — clusters unconsolidated memories, synthesizes insights via LLM
//! - **Querier** — retrieves relevant memories for context injection (pure SQLite)
//! - **Forgetter** — implements Synaptic Homeostasis (tiered decay + pruning)
//! - **AwakeReplay** — credit assignment (reverse) and planning (forward) replay
//! - **OllamaClient** — thin HTTP client for the local Ollama instance
//!
//! Usage:
//! ```no_run
//! use hq_memory::MemorySystem;
//! use hq_db::Database;
//!
//! let db = Database::open(std::path::Path::new(".vault/_embeddings/hq.db")).unwrap();
//! let system = MemorySystem::new(db, "/path/to/.vault".into());
//! ```

pub mod types;
pub mod db;
pub mod ollama;
pub mod ingester;
pub mod consolidator;
pub mod querier;
pub mod forgetter;
pub mod awake_replay;

pub use types::*;
pub use db::{
    open_memory_tables, store_memory, get_all_memories, get_unconsolidated_memories,
    get_recent_memories, get_consolidation_history, get_memory_stats, get_bookmarked_memories,
    store_consolidation, store_replay, bump_replay_count, decay_old_memories,
    prune_weak_memories, touch_memory, store_delta_summary,
};
pub use ingester::MemoryIngester;
pub use consolidator::MemoryConsolidator;
pub use querier::{MemoryQuerier, MemoryContext};
pub use forgetter::{MemoryForgetter, ForgetterResult};
pub use awake_replay::AwakeReplayEngine;
pub use ollama::{ollama_chat, ollama_json, check_ollama_available, OllamaChatMessage};

use hq_db::Database;
use std::path::PathBuf;

/// The full memory system, constructed from a vault path.
pub struct MemorySystem {
    pub db: Database,
    pub ingester: MemoryIngester,
    pub consolidator: MemoryConsolidator,
    pub querier: MemoryQuerier,
    pub forgetter: MemoryForgetter,
    pub awake_replay: AwakeReplayEngine,
}

impl MemorySystem {
    /// Create the full memory system. Call once at startup.
    pub fn new(db: Database, vault_path: PathBuf) -> Self {
        let ingester = MemoryIngester::new(db.clone());
        let consolidator = MemoryConsolidator::new(db.clone(), vault_path.clone());
        let querier = MemoryQuerier::new(db.clone());
        let forgetter = MemoryForgetter::new(db.clone(), vault_path.clone());
        let awake_replay = AwakeReplayEngine::new(db.clone(), vault_path.clone());

        Self { db, ingester, consolidator, querier, forgetter, awake_replay }
    }
}
