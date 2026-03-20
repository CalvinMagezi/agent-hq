//! Telegram PlatformBridge implementation using teloxide.

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use chrono::Utc;
use hq_core::types::{PlatformCapabilities, PlatformId, UnifiedMessage};
use hq_relay::MessageCallback;
use teloxide::prelude::*;
use teloxide::types::{ChatAction, MessageId as TgMessageId, ReplyParameters};
use tracing::{error, info};

/// Telegram bridge — connects to Telegram via teloxide polling and normalises
/// messages into `UnifiedMessage` for the relay core.
pub struct TelegramBridge {
    token: String,
    bot: Option<Bot>,
    message_callback: Option<MessageCallback>,
    /// Shutdown signal sender.
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TelegramBridge {
    /// Create a new Telegram bridge with the given bot token.
    pub fn new(token: String) -> Self {
        Self {
            token,
            bot: None,
            message_callback: None,
            shutdown_tx: None,
        }
    }

    /// Set the callback that will be invoked for each incoming message.
    pub fn set_message_callback(&mut self, callback: MessageCallback) {
        self.message_callback = Some(callback);
    }

    fn get_bot(&self) -> Result<&Bot> {
        self.bot
            .as_ref()
            .context("Telegram bridge not started — no bot available")
    }
}

#[async_trait]
impl hq_relay::PlatformBridge for TelegramBridge {
    fn platform_id(&self) -> PlatformId {
        PlatformId::Telegram
    }

    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities {
            max_message_length: 4096,
            supports_reactions: false,
            supports_streaming: false,
            supports_voice: true,
            supports_media: true,
            format_type: "markdown".to_string(),
        }
    }

    async fn start(&mut self) -> Result<()> {
        let bot = Bot::new(&self.token);
        self.bot = Some(bot.clone());

        let callback = self.message_callback.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        self.shutdown_tx = Some(shutdown_tx);

        info!("Starting Telegram polling");

        // Spawn polling in a background task
        tokio::spawn(async move {
            let handler =
                Update::filter_message().endpoint(move |_bot: Bot, msg: Message| {
                    let callback = callback.clone();
                    async move {
                        if let Some(cb) = &callback {
                            // Extract text content
                            let content = msg.text().unwrap_or("").to_string();
                            if content.is_empty() {
                                return respond(());
                            }

                            // Check for voice notes
                            let is_voice = msg.voice().is_some();

                            // Build reply info
                            let reply_to_id = msg
                                .reply_to_message()
                                .map(|r| r.id.0.to_string());
                            let reply_content = msg
                                .reply_to_message()
                                .and_then(|r| r.text().map(|t| t.to_string()));

                            let unified = UnifiedMessage {
                                id: msg.id.0.to_string(),
                                chat_id: msg.chat.id.0.to_string(),
                                user_id: msg
                                    .from
                                    .as_ref()
                                    .map(|u| u.id.0.to_string())
                                    .unwrap_or_default(),
                                content,
                                timestamp: Utc::now(),
                                platform: PlatformId::Telegram,
                                reply_to_id,
                                reply_content,
                                is_voice_note: is_voice,
                                media_type: None,
                                media_buffer: None,
                                harness_override: None,
                            };

                            if let Err(e) = cb(unified).await {
                                error!(%e, "Error handling Telegram message");
                            }
                        }
                        respond(())
                    }
                });

            let mut dispatcher = Dispatcher::builder(bot, handler)
                .enable_ctrlc_handler()
                .build();

            // Run dispatcher until shutdown
            tokio::select! {
                _ = dispatcher.dispatch() => {},
                _ = &mut shutdown_rx => {
                    info!("Telegram dispatcher shutting down");
                },
            }
        });

        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            info!("Telegram bridge stopped");
        }
        Ok(())
    }

    async fn send_text(
        &self,
        text: &str,
        chat_id: &str,
        reply_to: Option<&str>,
    ) -> Result<Option<String>> {
        let bot = self.get_bot()?;
        let chat: ChatId = ChatId(
            chat_id
                .parse::<i64>()
                .context("Invalid Telegram chat ID")?,
        );

        let mut request = bot.send_message(chat, text);

        if let Some(reply_id_str) = reply_to {
            if let Ok(reply_id) = reply_id_str.parse::<i32>() {
                request =
                    request.reply_parameters(ReplyParameters::new(TgMessageId(reply_id)));
            }
        }

        let sent = request
            .await
            .context("Failed to send Telegram message")?;

        Ok(Some(sent.id.0.to_string()))
    }

    async fn send_typing(&self, chat_id: &str) -> Result<()> {
        let bot = self.get_bot()?;
        let chat: ChatId = ChatId(
            chat_id
                .parse::<i64>()
                .context("Invalid Telegram chat ID")?,
        );

        bot.send_chat_action(chat, ChatAction::Typing)
            .await
            .context("Failed to send typing action")?;

        Ok(())
    }

    async fn send_reaction(&self, _msg_id: &str, _emoji: &str, _chat_id: &str) -> Result<()> {
        // Telegram Bot API has limited reaction support (only in newer versions)
        // For now, this is a no-op
        Ok(())
    }

    async fn delete_message(&self, msg_id: &str, chat_id: &str) -> Result<()> {
        let bot = self.get_bot()?;
        let chat: ChatId = ChatId(
            chat_id
                .parse::<i64>()
                .context("Invalid Telegram chat ID")?,
        );
        let message_id: i32 = msg_id.parse().context("Invalid Telegram message ID")?;

        bot.delete_message(chat, TgMessageId(message_id))
            .await
            .context("Failed to delete Telegram message")?;

        Ok(())
    }
}
