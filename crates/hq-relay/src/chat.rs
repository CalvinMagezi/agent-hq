//! Chat handler — builds context from thread history, calls LLM, stores response.

use anyhow::Result;
use hq_core::types::{ChatMessage, MessageRole};
use hq_llm::{ChatRequest, LlmProvider};
use hq_tools::skills::SkillHintIndex;
use tracing::{debug, info};

use crate::thread::ThreadStore;

/// Handle a chat message: build context, call LLM, store response, return text.
///
/// Generic over `L: LlmProvider` because the trait is not dyn-compatible.
///
/// If `skill_index` is provided, the system prompt is enriched with contextual
/// skills matching the user's message content. This happens per-message so each
/// conversation turn gets the right skills without pre-loading everything.
pub async fn handle_chat<L: LlmProvider>(
    content: &str,
    thread_id: &str,
    thread_store: &mut ThreadStore,
    llm_provider: &L,
    model: &str,
    system_prompt: Option<&str>,
    skill_index: Option<&SkillHintIndex>,
) -> Result<String> {
    // Store the user message
    thread_store.add_message(thread_id, "user", content)?;

    // Build messages from thread context
    let context = thread_store.get_context(thread_id, 4000)?;
    let mut messages = Vec::new();

    // System message — enriched with contextual skills if available
    if let Some(sys) = system_prompt {
        let enriched = match skill_index {
            Some(index) => hq_tools::skills::enrich_system_prompt(index, sys, content),
            None => sys.to_string(),
        };
        messages.push(ChatMessage {
            role: MessageRole::System,
            content: enriched,
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }

    // Parse context back into messages
    for line in context.lines() {
        if let Some(rest) = line.strip_prefix("[user]: ") {
            messages.push(ChatMessage {
                role: MessageRole::User,
                content: rest.to_string(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
        } else if let Some(rest) = line.strip_prefix("[assistant]: ") {
            messages.push(ChatMessage {
                role: MessageRole::Assistant,
                content: rest.to_string(),
                tool_calls: Vec::new(),
                tool_call_id: None,
            });
        }
        // Skip other roles for now
    }

    // If context parsing didn't capture the latest user message, add it
    if messages
        .last()
        .map(|m| m.role != MessageRole::User || m.content != content)
        .unwrap_or(true)
    {
        messages.push(ChatMessage {
            role: MessageRole::User,
            content: content.to_string(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }

    debug!(model, messages_count = messages.len(), "Calling LLM");

    let request = ChatRequest {
        model: model.to_string(),
        messages,
        tools: Vec::new(),
        temperature: Some(0.7),
        max_tokens: Some(4096),
    };

    let response = llm_provider.chat(&request).await?;
    let response_text = response.message.content.clone();

    info!(
        model,
        input_tokens = response.input_tokens,
        output_tokens = response.output_tokens,
        "LLM response received"
    );

    // Store assistant response
    thread_store.add_message(thread_id, "assistant", &response_text)?;

    Ok(response_text)
}
