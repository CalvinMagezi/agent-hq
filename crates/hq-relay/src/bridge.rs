//! PlatformBridge trait — abstraction over chat platforms.

use anyhow::Result;
use async_trait::async_trait;
use hq_core::types::{PlatformCapabilities, PlatformId, UnifiedMessage};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Callback invoked when a message arrives from a platform.
pub type MessageCallback = Arc<
    dyn Fn(UnifiedMessage) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync,
>;

/// Trait that every chat platform adapter must implement.
#[async_trait]
pub trait PlatformBridge: Send + Sync {
    /// Which platform this bridge connects to.
    fn platform_id(&self) -> PlatformId;

    /// Capabilities of the platform (message limits, reactions, etc.).
    fn capabilities(&self) -> PlatformCapabilities;

    /// Start the platform connection (connect to gateway, start polling, etc.).
    async fn start(&mut self) -> Result<()>;

    /// Stop the platform connection gracefully.
    async fn stop(&mut self) -> Result<()>;

    /// Send a text message to a chat. Returns the sent message ID if available.
    async fn send_text(
        &self,
        text: &str,
        chat_id: &str,
        reply_to: Option<&str>,
    ) -> Result<Option<String>>;

    /// Send a typing indicator to a chat.
    async fn send_typing(&self, chat_id: &str) -> Result<()>;

    /// Send a reaction (emoji) to a message.
    async fn send_reaction(&self, msg_id: &str, emoji: &str, chat_id: &str) -> Result<()>;

    /// Delete a message in a chat.
    async fn delete_message(&self, msg_id: &str, chat_id: &str) -> Result<()>;
}
