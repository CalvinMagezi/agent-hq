//! Tool definitions and registry for Agent-HQ.
//!
//! Provides the `HqTool` trait, a `ToolRegistry`, and built-in tool
//! implementations for vault operations, skills, agents, Google Workspace,
//! image generation, TTS, DrawIt diagrams, benchmarking, webmail, planning,
//! browser automation, and workflow orchestration.

pub mod agents;
pub mod benchmark;
pub mod browser;
pub mod drawit;
pub mod gws;
pub mod imagegen;
pub mod planning;
pub mod registry;
pub mod skills;
pub mod tts;
pub mod vault;
pub mod webmail;
pub mod workflow;

pub use registry::{HqTool, ToolRegistry, ToolSummary};
