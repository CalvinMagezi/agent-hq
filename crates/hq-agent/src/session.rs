//! Agent session loop — the core execution engine.
//!
//! Manages a conversation with an LLM, dispatching tool calls and handling
//! compaction when the context window fills up.

use anyhow::{bail, Result};
use hq_core::types::{ChatMessage, MessageRole, SessionEvent, ToolCall};
use hq_llm::provider::{ChatRequest, LlmProvider};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::tools::ToolRegistry;

// ─── Configuration ──────────────────────────────────────────────

/// Configuration for an agent session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Model identifier (e.g., "anthropic/claude-sonnet-4-20250514").
    pub model: String,
    /// Maximum number of turns (tool-call rounds) before forced stop.
    pub max_turns: u32,
    /// Context-window size in tokens for this model.
    pub context_window: usize,
    /// Fraction of context window that triggers compaction.
    pub compaction_threshold: f64,
    /// Maximum retries on transient errors.
    pub max_retries: u32,
    /// Base delay for exponential backoff.
    pub retry_base_delay: Duration,
    /// Temperature for LLM calls.
    pub temperature: Option<f32>,
    /// Max tokens for LLM response.
    pub max_tokens: Option<u32>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            model: "anthropic/claude-sonnet-4-20250514".to_string(),
            max_turns: 200,
            context_window: 200_000,
            compaction_threshold: 0.75,
            max_retries: 3,
            retry_base_delay: Duration::from_secs(2),
            temperature: None,
            max_tokens: None,
        }
    }
}

// ─── Session ────────────────────────────────────────────────────

/// The agent session — drives the prompt-tool-call loop.
pub struct AgentSession {
    messages: Vec<ChatMessage>,
    tools: Arc<Mutex<ToolRegistry>>,
    provider: Arc<dyn LlmProvider>,
    config: SessionConfig,
    system_prompt: Option<String>,
    subscribers: Vec<Box<dyn Fn(SessionEvent) + Send + Sync>>,
    total_input_tokens: u64,
    total_output_tokens: u64,
    tool_call_count: u32,
}

impl AgentSession {
    /// Create a new session with the given provider and config.
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tools: ToolRegistry,
        config: SessionConfig,
    ) -> Self {
        Self {
            messages: Vec::new(),
            tools: Arc::new(Mutex::new(tools)),
            provider,
            config,
            system_prompt: None,
            subscribers: Vec::new(),
            total_input_tokens: 0,
            total_output_tokens: 0,
            tool_call_count: 0,
        }
    }

    /// Set the system prompt.
    pub fn set_system_prompt(&mut self, prompt: String) {
        self.system_prompt = Some(prompt);
    }

    /// Subscribe to session events.
    pub fn on_event(&mut self, callback: impl Fn(SessionEvent) + Send + Sync + 'static) {
        self.subscribers.push(Box::new(callback));
    }

    /// Inject a steering message (appears as a system-like user message).
    pub fn steer(&mut self, message: &str) {
        self.messages.push(ChatMessage {
            role: MessageRole::User,
            content: format!("[STEERING] {}", message),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
        debug!(message = %message, "injected steering message");
    }

    /// Run the main prompt loop.
    ///
    /// 1. Push the user message
    /// 2. Loop: check compaction, call LLM, handle tool calls
    /// 3. Return the final assistant text
    pub async fn prompt(&mut self, text: &str) -> Result<String> {
        // Push user message
        self.messages.push(ChatMessage {
            role: MessageRole::User,
            content: text.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });

        let mut turn: u32 = 0;

        loop {
            if turn >= self.config.max_turns {
                warn!(max_turns = self.config.max_turns, "hit max turns limit");
                bail!(
                    "session exceeded maximum turns ({})",
                    self.config.max_turns
                );
            }

            // Check if compaction is needed
            let estimated = self.estimate_tokens();
            let threshold =
                (self.config.context_window as f64 * self.config.compaction_threshold) as usize;
            if estimated > threshold {
                info!(
                    estimated_tokens = estimated,
                    threshold = threshold,
                    "compacting context"
                );
                self.compact().await;
            }

            // Build request
            let tool_defs = {
                let tools = self.tools.lock().await;
                tools.definitions()
            };

            let mut request_messages = Vec::new();
            if let Some(ref sys) = self.system_prompt {
                request_messages.push(ChatMessage {
                    role: MessageRole::System,
                    content: sys.clone(),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                });
            }
            request_messages.extend(self.messages.clone());

            let request = ChatRequest {
                model: self.config.model.clone(),
                messages: request_messages,
                tools: tool_defs,
                temperature: self.config.temperature,
                max_tokens: self.config.max_tokens,
            };

            // Call LLM with retries
            let response = self.call_with_retry(&request).await?;

            self.total_input_tokens += response.input_tokens as u64;
            self.total_output_tokens += response.output_tokens as u64;

            let assistant_msg = response.message;

            // Emit text if present
            if !assistant_msg.content.is_empty() {
                self.emit(SessionEvent::TextDelta(assistant_msg.content.clone()));
            }

            // Append assistant message
            self.messages.push(assistant_msg.clone());

            // If no tool calls, we're done
            if assistant_msg.tool_calls.is_empty() {
                self.emit(SessionEvent::TextDone(assistant_msg.content.clone()));
                self.emit(SessionEvent::TurnEnd { turn });
                return Ok(assistant_msg.content);
            }

            // Process tool calls
            for tc in &assistant_msg.tool_calls {
                self.emit(SessionEvent::ToolStart {
                    tool_name: tc.name.clone(),
                    tool_call_id: tc.id.clone(),
                });

                let result = self.execute_tool(tc).await;

                let result_text = match &result {
                    Ok(tr) => tr
                        .content
                        .iter()
                        .map(|c| c.text.as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    Err(e) => format!("Error: {}", e),
                };

                self.emit(SessionEvent::ToolEnd {
                    tool_name: tc.name.clone(),
                    tool_call_id: tc.id.clone(),
                    result: result_text.clone(),
                });

                // Push tool result message
                self.messages.push(ChatMessage {
                    role: MessageRole::Tool,
                    content: result_text,
                    tool_calls: Vec::new(),
                    tool_call_id: Some(tc.id.clone()),
                });

                self.tool_call_count += 1;
            }

            turn += 1;
            self.emit(SessionEvent::TurnEnd { turn });
        }
    }

    /// Execute a single tool call.
    async fn execute_tool(&self, tc: &ToolCall) -> Result<hq_core::types::ToolResult> {
        let tools = self.tools.lock().await;
        let tool = tools
            .get(&tc.name)
            .ok_or_else(|| anyhow::anyhow!("unknown tool: {}", tc.name))?;

        tool.execute(&tc.id, tc.arguments.clone()).await
    }

    /// Call the LLM with exponential backoff on transient errors.
    async fn call_with_retry(&self, request: &ChatRequest) -> Result<hq_llm::ChatResponse> {
        let mut attempt = 0u32;
        loop {
            match self.provider.chat(request).await {
                Ok(response) => return Ok(response),
                Err(e) => {
                    let err_str = e.to_string();
                    let is_transient = err_str.contains("429")
                        || err_str.contains("500")
                        || err_str.contains("502")
                        || err_str.contains("503")
                        || err_str.contains("504")
                        || err_str.contains("rate limit")
                        || err_str.contains("overloaded");

                    if !is_transient || attempt >= self.config.max_retries {
                        return Err(e);
                    }

                    let delay = self.config.retry_base_delay * 2u32.pow(attempt);
                    warn!(
                        attempt = attempt + 1,
                        max = self.config.max_retries,
                        delay_ms = delay.as_millis(),
                        error = %err_str,
                        "retrying after transient error"
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
            }
        }
    }

    /// Compact the message history when context is getting full.
    ///
    /// Keeps the last 10 messages and summarizes older ones via an LLM call.
    /// On failure, falls back to simple truncation.
    async fn compact(&mut self) {
        let keep_count = 10;
        if self.messages.len() <= keep_count {
            return;
        }

        let old_len = self.messages.len();
        let older: Vec<ChatMessage> = self.messages.drain(..old_len - keep_count).collect();

        // Try to summarize via LLM
        let summary_prompt = format!(
            "Summarize the following conversation history concisely, preserving key facts, \
             decisions, and tool results that may be needed for the ongoing task:\n\n{}",
            older
                .iter()
                .map(|m| format!("[{}] {}", format!("{:?}", m.role).to_lowercase(), m.content))
                .collect::<Vec<_>>()
                .join("\n")
        );

        let summary_request = ChatRequest {
            model: self.config.model.clone(),
            messages: vec![ChatMessage {
                role: MessageRole::User,
                content: summary_prompt,
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
            temperature: Some(0.0),
            max_tokens: Some(2000),
        };

        match self.provider.chat(&summary_request).await {
            Ok(response) => {
                // Prepend summary as a user message
                self.messages.insert(
                    0,
                    ChatMessage {
                        role: MessageRole::User,
                        content: format!(
                            "[CONTEXT SUMMARY - {} earlier messages compacted]\n{}",
                            older.len(),
                            response.message.content
                        ),
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                    },
                );
                let new_len = self.messages.len();
                self.emit(SessionEvent::Compaction {
                    old_messages: old_len,
                    new_messages: new_len,
                });
                info!(
                    old = old_len,
                    new = new_len,
                    "compacted via LLM summarization"
                );
            }
            Err(e) => {
                // Fallback: just truncate (the older messages are already drained)
                let new_len = self.messages.len();
                self.emit(SessionEvent::Compaction {
                    old_messages: old_len,
                    new_messages: new_len,
                });
                warn!(
                    error = %e,
                    old = old_len,
                    new = new_len,
                    "compaction summary failed, fell back to truncation"
                );
            }
        }
    }

    /// Estimate total tokens in the conversation using a simple heuristic.
    fn estimate_tokens(&self) -> usize {
        let system_tokens = self
            .system_prompt
            .as_ref()
            .map(|s| s.len() / 4)
            .unwrap_or(0);
        let message_tokens: usize = self.messages.iter().map(|m| m.content.len() / 4).sum();
        system_tokens + message_tokens
    }

    /// Emit an event to all subscribers.
    fn emit(&self, event: SessionEvent) {
        for subscriber in &self.subscribers {
            subscriber(event.clone());
        }
    }

    /// Get token usage stats.
    pub fn stats(&self) -> SessionStats {
        SessionStats {
            total_input_tokens: self.total_input_tokens,
            total_output_tokens: self.total_output_tokens,
            total_tokens: self.total_input_tokens + self.total_output_tokens,
            tool_call_count: self.tool_call_count,
            message_count: self.messages.len() as u32,
        }
    }

    /// Get a reference to the message history.
    pub fn messages(&self) -> &[ChatMessage] {
        &self.messages
    }
}

/// Accumulated stats for a session.
#[derive(Debug, Clone)]
pub struct SessionStats {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_tokens: u64,
    pub tool_call_count: u32,
    pub message_count: u32,
}
