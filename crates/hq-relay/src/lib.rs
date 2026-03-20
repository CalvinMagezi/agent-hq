//! Relay adapter core — unified chat relay framework.
//!
//! Provides the `PlatformBridge` trait, `UnifiedBot`, harness spawning,
//! session orchestration, command dispatch, thread storage, and chat handling.

pub mod bridge;
pub mod bot;
pub mod chat;
pub mod commands;
pub mod harness;
pub mod orchestrator;
pub mod protocol;
pub mod thread;

pub use bridge::{PlatformBridge, MessageCallback};
pub use bot::UnifiedBot;
pub use chat::handle_chat;
pub use commands::dispatch_command;
pub use harness::LocalHarness;
pub use orchestrator::SessionOrchestrator;
pub use thread::{Thread, ThreadStore};
