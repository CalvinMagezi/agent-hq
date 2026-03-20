//! LLM provider abstraction layer.

pub mod models;
pub mod openrouter;
pub mod provider;

pub use provider::{ChatRequest, ChatResponse, LlmProvider, StreamChunk};
