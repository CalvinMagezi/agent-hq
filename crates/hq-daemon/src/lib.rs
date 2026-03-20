//! Background daemon — interval-based task scheduling, embedding processing,
//! health checks, cleanup, memory consolidation, and plan management.

pub mod cleanup;
pub mod embeddings;
pub mod health;
pub mod memory;
pub mod plans;
pub mod scheduler;

pub use cleanup::{cleanup_done_jobs, cleanup_stale_jobs};
pub use embeddings::process_embeddings;
pub use health::{check_health, HealthReport};
pub use memory::{consolidate_memories, run_memory_cycle};
pub use plans::sync_plan_status;
pub use scheduler::DaemonScheduler;
