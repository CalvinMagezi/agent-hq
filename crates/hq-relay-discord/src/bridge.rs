//! Discord PlatformBridge implementation using serenity + poise.

use anyhow::{Context as _, Result};
use chrono::Utc;
use hq_core::types::{PlatformCapabilities, PlatformId, UnifiedMessage};
use hq_relay::MessageCallback;
use async_trait::async_trait;
use serenity::all::{
    ChannelId, Context, CreateMessage, EventHandler, GatewayIntents, MessageId,
    ReactionType, Ready,
};
use serenity::model::channel::Message;
use serenity::Client;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

/// Discord bridge — connects to Discord via serenity and normalises messages
/// into `UnifiedMessage` for the relay core.
pub struct DiscordBridge {
    token: String,
    client: Option<Client>,
    message_callback: Option<MessageCallback>,
    /// Bot user ID, set after connection.
    bot_user_id: Arc<RwLock<Option<u64>>>,
    /// Serenity HTTP client, available after start().
    http: Arc<RwLock<Option<Arc<serenity::http::Http>>>>,
}

impl DiscordBridge {
    /// Create a new Discord bridge with the given bot token.
    pub fn new(token: String) -> Self {
        Self {
            token,
            client: None,
            message_callback: None,
            bot_user_id: Arc::new(RwLock::new(None)),
            http: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the callback that will be invoked for each incoming message.
    pub fn set_message_callback(&mut self, callback: MessageCallback) {
        self.message_callback = Some(callback);
    }

    async fn get_http(&self) -> Result<Arc<serenity::http::Http>> {
        let guard = self.http.read().await;
        guard
            .clone()
            .context("Discord bridge not started — no HTTP client available")
    }
}

#[async_trait]
impl hq_relay::PlatformBridge for DiscordBridge {
    fn platform_id(&self) -> PlatformId {
        PlatformId::Discord
    }

    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities {
            max_message_length: 2000,
            supports_reactions: true,
            supports_streaming: false,
            supports_voice: true,
            supports_media: true,
            format_type: "markdown".to_string(),
        }
    }

    async fn start(&mut self) -> Result<()> {
        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT;

        let callback = self.message_callback.clone();
        let bot_user_id = self.bot_user_id.clone();
        let http_store = self.http.clone();

        let handler = DiscordHandler {
            callback,
            bot_user_id: bot_user_id.clone(),
        };

        let client = Client::builder(&self.token, intents)
            .event_handler(handler)
            .await
            .context("Failed to build Discord client")?;

        // Store the HTTP client for sending messages
        {
            let mut http_guard = http_store.write().await;
            *http_guard = Some(client.http.clone());
        }

        info!("Starting Discord gateway connection");
        self.client = Some(client);

        // Start in background — client.start() blocks
        let client_ref = self.client.as_mut().unwrap();
        client_ref
            .start()
            .await
            .context("Discord client failed to start")?;

        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        if let Some(client) = &self.client {
            client.shard_manager.shutdown_all().await;
            info!("Discord client stopped");
        }
        Ok(())
    }

    async fn send_text(
        &self,
        text: &str,
        chat_id: &str,
        reply_to: Option<&str>,
    ) -> Result<Option<String>> {
        let http = self.get_http().await?;
        let channel_id: u64 = chat_id.parse().context("Invalid Discord channel ID")?;
        let channel = ChannelId::new(channel_id);

        let mut builder = CreateMessage::new().content(text);

        if let Some(reply_id_str) = reply_to {
            if let Ok(reply_id) = reply_id_str.parse::<u64>() {
                builder = builder.reference_message((channel, MessageId::new(reply_id)));
            }
        }

        let sent = channel
            .send_message(&http, builder)
            .await
            .context("Failed to send Discord message")?;

        Ok(Some(sent.id.to_string()))
    }

    async fn send_typing(&self, chat_id: &str) -> Result<()> {
        let http = self.get_http().await?;
        let channel_id: u64 = chat_id.parse().context("Invalid Discord channel ID")?;
        let channel = ChannelId::new(channel_id);
        channel
            .broadcast_typing(&http)
            .await
            .context("Failed to send typing indicator")?;
        Ok(())
    }

    async fn send_reaction(&self, msg_id: &str, emoji: &str, chat_id: &str) -> Result<()> {
        let http = self.get_http().await?;
        let channel_id: u64 = chat_id.parse().context("Invalid Discord channel ID")?;
        let message_id: u64 = msg_id.parse().context("Invalid message ID")?;

        let channel = ChannelId::new(channel_id);
        let reaction = ReactionType::Unicode(emoji.to_string());

        http.create_reaction(channel, MessageId::new(message_id), &reaction)
            .await
            .context("Failed to add reaction")?;

        Ok(())
    }

    async fn delete_message(&self, msg_id: &str, chat_id: &str) -> Result<()> {
        let http = self.get_http().await?;
        let channel_id: u64 = chat_id.parse().context("Invalid Discord channel ID")?;
        let message_id: u64 = msg_id.parse().context("Invalid message ID")?;

        let channel = ChannelId::new(channel_id);
        channel
            .delete_message(&http, MessageId::new(message_id))
            .await
            .context("Failed to delete message")?;

        Ok(())
    }
}

/// Serenity event handler that normalises Discord messages into UnifiedMessage.
struct DiscordHandler {
    callback: Option<MessageCallback>,
    bot_user_id: Arc<RwLock<Option<u64>>>,
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn ready(&self, _ctx: Context, ready: Ready) {
        info!(user = %ready.user.name, "Discord bot connected");
        let mut id = self.bot_user_id.write().await;
        *id = Some(ready.user.id.get());
    }

    async fn message(&self, _ctx: Context, msg: Message) {
        // Ignore bot's own messages
        {
            let bot_id = self.bot_user_id.read().await;
            if let Some(id) = *bot_id {
                if msg.author.id.get() == id {
                    return;
                }
            }
        }

        // Ignore other bots
        if msg.author.bot {
            return;
        }

        let Some(callback) = &self.callback else {
            return;
        };

        // Normalise to UnifiedMessage
        let reply_to_id = msg
            .referenced_message
            .as_ref()
            .map(|r| r.id.to_string());
        let reply_content = msg
            .referenced_message
            .as_ref()
            .map(|r| r.content.clone());

        let unified = UnifiedMessage {
            id: msg.id.to_string(),
            chat_id: msg.channel_id.to_string(),
            user_id: msg.author.id.to_string(),
            content: msg.content.clone(),
            timestamp: Utc::now(),
            platform: PlatformId::Discord,
            reply_to_id,
            reply_content,
            is_voice_note: false,
            media_type: None,
            media_buffer: None,
            harness_override: None,
        };

        if let Err(e) = callback(unified).await {
            error!(%e, "Error handling Discord message");
        }
    }
}
