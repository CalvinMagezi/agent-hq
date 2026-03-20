//! Memory consolidation — delegates to the hq-memory crate.
//!
//! This module re-exports the full memory system and provides
//! the daemon-facing `consolidate_memories` function that was the
//! original stub.

use anyhow::Result;
use hq_db::Database;
use std::path::PathBuf;
use tracing::{info, warn};

pub use hq_memory::{
    MemorySystem, MemoryIngester, MemoryConsolidator, MemoryQuerier, MemoryForgetter,
    AwakeReplayEngine, MemoryContext, ForgetterResult,
};

/// Run a full memory maintenance cycle:
/// 1. Consolidation (cluster + synthesize insights)
/// 2. Refresh MEMORY.md
/// 3. Process pending deltas (pattern separation)
/// 4. Forgetting (tiered decay + pruning)
///
/// Called by the daemon scheduler every 30 minutes.
pub async fn run_memory_cycle(db: &Database, vault_path: &PathBuf) -> Result<()> {
    // Ensure memory tables exist
    hq_memory::open_memory_tables(db)?;

    // 1. Consolidation
    let consolidator = MemoryConsolidator::new(db.clone(), vault_path.clone());
    match consolidator.run_cycle().await {
        Ok(Some(insight)) => {
            let preview: String = insight.chars().take(100).collect();
            info!(insight = %preview, "Consolidation produced insight");
        }
        Ok(None) => {
            info!("No consolidation needed this cycle");
        }
        Err(e) => {
            warn!(error = %e, "Consolidation cycle failed");
        }
    }

    // 2. Refresh MEMORY.md
    if let Err(e) = consolidator.refresh_memory_file() {
        warn!(error = %e, "Failed to refresh MEMORY.md");
    }

    // 3. Process pending deltas (pattern separation)
    let mut querier = MemoryQuerier::new(db.clone());
    match querier.process_pending_deltas().await {
        Ok(count) if count > 0 => info!(count, "Processed pending deltas"),
        Ok(_) => {}
        Err(e) => warn!(error = %e, "Delta processing failed"),
    }

    // 4. Forgetting cycle
    let forgetter = MemoryForgetter::new(db.clone(), vault_path.clone());
    match forgetter.run_cycle() {
        Ok(result) => {
            if result.decayed > 0 || result.pruned > 0 {
                info!(
                    decayed = result.decayed,
                    pruned = result.pruned,
                    total = result.stats_after.total,
                    "Forgetting cycle complete"
                );
            }
        }
        Err(e) => warn!(error = %e, "Forgetting cycle failed"),
    }

    Ok(())
}

/// Legacy compatibility — the old `consolidate_memories` function signature.
/// Kept for backward compat with existing daemon scheduler calls.
pub async fn consolidate_memories<P: hq_llm::LlmProvider>(
    db: &Database,
    _llm_provider: &P,
) -> Result<Option<String>> {
    // The new implementation uses Ollama directly (not the LlmProvider trait),
    // matching the TS original. We ignore the llm_provider parameter.
    hq_memory::open_memory_tables(db)?;
    let consolidator = MemoryConsolidator::new(db.clone(), PathBuf::from(".vault"));
    consolidator.run_cycle().await
}
