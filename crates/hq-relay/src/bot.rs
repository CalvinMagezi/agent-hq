//! UnifiedBot — central message handler that routes incoming messages through
//! command dispatch, chat handling, or harness execution.

use anyhow::Result;
use hq_core::types::UnifiedMessage;
use hq_llm::LlmProvider;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::bridge::PlatformBridge;
use crate::chat;
use crate::commands;
use crate::harness::LocalHarness;
use crate::orchestrator::SessionOrchestrator;
use crate::thread::ThreadStore;

/// The unified bot that processes messages from any platform.
///
/// Generic over `B` (the platform bridge) and `L` (the LLM provider),
/// because both traits use `trait_variant` and are not dyn-compatible.
pub struct UnifiedBot<B: PlatformBridge, L: LlmProvider> {
    bridge: Arc<B>,
    thread_store: Arc<Mutex<ThreadStore>>,
    orchestrator: Arc<SessionOrchestrator>,
    #[allow(dead_code)]
    harness: Arc<LocalHarness>,
    llm_provider: Arc<L>,
    /// Dedup set for recently processed message IDs.
    seen_ids: Arc<Mutex<HashSet<String>>>,
    /// Active model name.
    model: String,
    /// Default harness type.
    default_harness: String,
    /// System prompt for LLM chat.
    system_prompt: Option<String>,
}

impl<B: PlatformBridge, L: LlmProvider> UnifiedBot<B, L> {
    pub fn new(
        bridge: Arc<B>,
        thread_store: ThreadStore,
        llm_provider: Arc<L>,
        model: String,
        default_harness: String,
        system_prompt: Option<String>,
    ) -> Self {
        let harness = Arc::new(LocalHarness::new());
        let orchestrator = Arc::new(SessionOrchestrator::new(harness.clone()));

        Self {
            bridge,
            thread_store: Arc::new(Mutex::new(thread_store)),
            orchestrator,
            harness,
            llm_provider,
            seen_ids: Arc::new(Mutex::new(HashSet::new())),
            model,
            default_harness,
            system_prompt,
        }
    }

    /// Handle an incoming message from any platform.
    pub async fn handle_message(&self, msg: UnifiedMessage) -> Result<()> {
        // 1. Dedup — skip if we've already seen this message (max 200 entries)
        {
            let mut seen = self.seen_ids.lock().await;
            if seen.contains(&msg.id) {
                debug!(msg_id = %msg.id, "Duplicate message, skipping");
                return Ok(());
            }
            if seen.len() >= 200 {
                seen.clear();
            }
            seen.insert(msg.id.clone());
        }

        let content = msg.content.trim();
        if content.is_empty() {
            return Ok(());
        }

        info!(
            platform = ?msg.platform,
            chat_id = %msg.chat_id,
            content_len = content.len(),
            "Processing message"
        );

        // 2. Resolve/create thread
        {
            let mut store = self.thread_store.lock().await;
            let _ = store.get_or_create(&msg.chat_id, msg.platform.clone())?;
        }

        // 3. Send typing indicator
        let _ = self.bridge.send_typing(&msg.chat_id).await;

        // 4. Route: command or chat
        let response = if content.starts_with('!') {
            self.handle_command(content, &msg.chat_id).await
        } else {
            self.handle_chat(content, &msg).await
        };

        match response {
            Ok(text) => {
                self.send_chunked(&text, &msg.chat_id, Some(&msg.id))
                    .await?;
            }
            Err(e) => {
                warn!(%e, "Error processing message");
                let error_text = format!("Error: {e}");
                let _ = self
                    .bridge
                    .send_text(&error_text, &msg.chat_id, Some(&msg.id))
                    .await;
            }
        }

        Ok(())
    }

    /// Send a long text in chunks, splitting at platform max length.
    /// Splits on `\n\n`, then `\n`, then space boundaries.
    pub async fn send_chunked(
        &self,
        text: &str,
        chat_id: &str,
        reply_to: Option<&str>,
    ) -> Result<()> {
        let max_len = self.bridge.capabilities().max_message_length;
        if max_len == 0 {
            // No limit, send as-is
            self.bridge.send_text(text, chat_id, reply_to).await?;
            return Ok(());
        }

        let chunks = split_text(text, max_len);

        for (i, chunk) in chunks.iter().enumerate() {
            // Only reply_to on the first chunk
            let reply = if i == 0 { reply_to } else { None };
            self.bridge.send_text(chunk, chat_id, reply).await?;
        }

        Ok(())
    }

    // --- Internal ---

    async fn handle_command(&self, content: &str, chat_id: &str) -> Result<String> {
        let mut store = self.thread_store.lock().await;
        let response = commands::dispatch_command(
            content,
            chat_id,
            &mut store,
            &self.orchestrator,
            &self.model,
            &self.default_harness,
        )
        .await;
        Ok(response)
    }

    async fn handle_chat(&self, content: &str, msg: &UnifiedMessage) -> Result<String> {
        // Determine active harness for this thread
        let harness_type = msg
            .harness_override
            .as_deref()
            .unwrap_or(&self.default_harness);

        // For "claude-code" or "hq" harness, use the orchestrator
        if harness_type == "claude-code" || harness_type == "hq" {
            let session_id = uuid::Uuid::new_v4().to_string();
            return self
                .orchestrator
                .run(&session_id, harness_type, content)
                .await;
        }

        // Default: use LLM chat
        let mut store = self.thread_store.lock().await;
        chat::handle_chat(
            content,
            &msg.chat_id,
            &mut store,
            &*self.llm_provider,
            &self.model,
            self.system_prompt.as_deref(),
        )
        .await
    }
}

/// Split text into chunks of at most `max_len` characters.
/// Prefers splitting on `\n\n`, then `\n`, then space.
fn split_text(text: &str, max_len: usize) -> Vec<String> {
    if text.len() <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= max_len {
            chunks.push(remaining.to_string());
            break;
        }

        let slice = &remaining[..max_len];

        // Try to find a good split point
        let split_at = if let Some(pos) = slice.rfind("\n\n") {
            pos + 2 // Include the double newline
        } else if let Some(pos) = slice.rfind('\n') {
            pos + 1
        } else if let Some(pos) = slice.rfind(' ') {
            pos + 1
        } else {
            max_len // Hard cut
        };

        chunks.push(remaining[..split_at].to_string());
        remaining = &remaining[split_at..];
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_text_short() {
        let chunks = split_text("hello", 2000);
        assert_eq!(chunks, vec!["hello"]);
    }

    #[test]
    fn test_split_text_on_paragraph() {
        let text = format!("{}paragraph one\n\nparagraph two", "x".repeat(1990));
        let chunks = split_text(&text, 2000);
        assert!(chunks.len() >= 2);
        assert!(chunks[0].len() <= 2000);
    }

    #[test]
    fn test_split_text_on_newline() {
        let text = format!("{}line one\nline two is also here", "x".repeat(1990));
        let chunks = split_text(&text, 2000);
        assert!(chunks.len() >= 2);
    }
}
