use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{ChatMessage, ToolDefinition};
use std::pin::Pin;
use tokio_stream::Stream;

/// A chunk from a streaming LLM response.
#[derive(Debug, Clone)]
pub enum StreamChunk {
    /// Text content delta
    Text(String),
    /// Tool call being built (id, name, argument delta)
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    /// Stream finished
    Done,
    /// Usage information
    Usage {
        input_tokens: u32,
        output_tokens: u32,
    },
}

/// Request to the LLM.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// Non-streaming response from the LLM.
#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub message: ChatMessage,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub model: String,
}

/// Trait for LLM providers (OpenRouter, Anthropic, Google, Ollama).
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// Provider name (e.g., "openrouter", "anthropic")
    fn name(&self) -> &str;

    /// Non-streaming chat completion.
    async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse>;

    /// Streaming chat completion.
    async fn chat_stream(
        &self,
        request: &ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk>> + Send>>>;
}
