//! Context assembly engine for Agent-HQ.
//!
//! Builds token-budgeted context frames from vault data,
//! conversation history, and injected notes.

pub mod budget;
pub mod chunks;
pub mod compactor;
pub mod engine;
pub mod layers;
pub mod tokenizer;

pub use engine::ContextEngine;
pub use layers::{ContextLayer, FrameInput};
